/**
 * TeleDown - Content Script (Main)
 *
 * Features:
 * 1. Inject downloader script into page context
 * 2. Detect videos via MutationObserver
 * 3. Manage download queue (pending / downloading / completed)
 * 4. Floating control panel with "Start Download" button
 * 5. Auto-download mode
 * 6. Folder-based download (configured via settings)
 * 7. Chat navigation detection (URL change)
 */

import { startWatching, clearSeenVideos, tryGetVideoUrl, triggerVideoLoad, scanForVideos, type DetectedVideo } from './detector';
import {
  injectDownloadButtons,
  setDownloadHandler,
  updateButtonProgress,
  updateButtonCompleted,
  updateButtonError,
  showControlPanel,
  updateControlPanel,
  setControlPanelCallbacks,
  type PanelState,
} from './ui';
import type { ExtensionSettings } from '../types/messages';
import { DEFAULT_SETTINGS } from '../types/messages';

// ============================================================
// State
// ============================================================

type VideoStatus = 'pending' | 'downloading' | 'completed' | 'error';

interface QueueItem {
  videoId: string;
  videoUrl: string;
  status: VideoStatus;
  progress: number;
  /** Reference to the DOM container for URL resolution */
  containerElement?: HTMLElement;
}

/** All detected videos for the current chat */
const videoQueue = new Map<string, QueueItem>();

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let downloadCounter = 0;
let currentChatUrl = '';
let isScanning = false;
let scanProgress = 0;
let scanAborted = false;

// ============================================================
// Settings
// ============================================================

async function loadSettings(): Promise<void> {
  try {
    const result = await chrome.storage.sync.get('settings');
    if (result.settings) {
      settings = { ...DEFAULT_SETTINGS, ...result.settings };
    }
  } catch {
    // Use defaults
  }
}

async function saveSettings(): Promise<void> {
  try {
    await chrome.storage.sync.set({ settings });
  } catch {
    // Ignore
  }
}

/** Broadcast current settings to the injected page script */
function broadcastSettings(): void {
  document.dispatchEvent(
    new CustomEvent('tele_down_settings', {
      detail: {
        downloadFolder: settings.downloadFolder,
        parallelChunks: settings.parallelChunks,
      },
    }),
  );
}

// ============================================================
// Download Helpers
// ============================================================

function generateDownloadId(): string {
  return `dl-${Date.now()}-${++downloadCounter}`;
}

function computePanelState(): PanelState {
  let pending = 0, downloading = 0, completed = 0, errored = 0;
  for (const item of videoQueue.values()) {
    if (item.status === 'pending') pending++;
    else if (item.status === 'downloading') downloading++;
    else if (item.status === 'completed') completed++;
    else if (item.status === 'error') errored++;
  }
  return {
    totalDetected: videoQueue.size,
    pending,
    downloading,
    completed,
    errored,
    autoDownload: settings.autoDownload,
    downloadFolder: settings.downloadFolder,
    scanning: isScanning,
    scanProgress,
  };
}

function requestDownload(videoUrl: string, videoId: string): void {
  const item = videoQueue.get(videoId);
  if (!item) return;
  // Only allow downloading from 'pending' or 'error' (retry) status
  if (item.status === 'downloading' || item.status === 'completed') return;

  const downloadId = generateDownloadId();
  item.status = 'downloading';
  item.progress = 0;
  videoQueue.set(videoId, item);

  updateControlPanel(computePanelState());

  // Notify background
  chrome.runtime.sendMessage({
    action: 'downloadStarted',
    data: { videoId, downloadId, progress: 0, status: 'downloading', fileName: videoId },
  }).catch(() => {});

  // Progress listener
  const progressHandler = ((event: CustomEvent) => {
    const progress = parseFloat(event.detail.progress);
    item.progress = progress;
    updateButtonProgress(videoId, progress);
    updateControlPanel(computePanelState());

    chrome.runtime.sendMessage({
      action: 'downloadProgress',
      data: { videoId, downloadId, progress, status: 'downloading' },
    }).catch(() => {});

    if (progress >= 99.9) {
      item.status = 'completed';
      videoQueue.set(videoId, item);
      updateButtonCompleted(videoId);
      updateControlPanel(computePanelState());

      chrome.runtime.sendMessage({
        action: 'downloadCompleted',
        data: { videoId, downloadId, progress: 100, status: 'completed' },
      }).catch(() => {});

      document.removeEventListener(
        `${videoId}_video_download_progress`,
        progressHandler as EventListener,
      );
    }
  }) as EventListener;

  // Error listener
  const errorHandler = ((event: CustomEvent) => {
    item.status = 'error';
    videoQueue.set(videoId, item);
    updateButtonError(videoId);
    updateControlPanel(computePanelState());

    chrome.runtime.sendMessage({
      action: 'downloadError',
      data: {
        videoId,
        downloadId,
        progress: 0,
        status: 'error',
        error: event.detail?.error || 'Unknown error',
      },
    }).catch(() => {});

    document.removeEventListener(
      `${videoId}_video_download_progress`,
      progressHandler as EventListener,
    );
    document.removeEventListener(
      `${videoId}_video_download_error`,
      errorHandler as EventListener,
    );
  }) as EventListener;

  document.addEventListener(`${videoId}_video_download_progress`, progressHandler);
  document.addEventListener(`${videoId}_video_download_error`, errorHandler);

  // Dispatch to injected script
  document.dispatchEvent(
    new CustomEvent('video_download', {
      detail: {
        type: 'single',
        video_src: {
          video_url: videoUrl,
          video_id: videoId,
          page: window.location.href,
          download_id: downloadId,
        },
      },
    }),
  );
}

/** Resolve URLs for pending videos that don't have one yet */
async function resolveVideoUrls(): Promise<void> {
  const needsUrl = Array.from(videoQueue.values()).filter(
    (v) => v.status === 'pending' && !v.videoUrl && v.containerElement,
  );

  if (needsUrl.length === 0) return;

  console.log(`[TeleDown] Resolving URLs for ${needsUrl.length} video(s)...`);

  for (const item of needsUrl) {
    if (!item.containerElement) continue;

    // First try without scrolling (maybe it loaded since detection)
    let url = tryGetVideoUrl(item.containerElement);
    if (!url) {
      // Scroll into view to trigger Telegram's lazy loading
      url = await triggerVideoLoad(item.containerElement);
    }

    if (url) {
      item.videoUrl = url;
      console.log(`[TeleDown] Resolved URL for ${item.videoId}`);
    }
  }
}

/** Download all pending videos (respects parallelDownloads setting) */
async function startAllPendingDownloads(): Promise<void> {
  // First, resolve URLs for videos that don't have one yet
  await resolveVideoUrls();

  const pending = Array.from(videoQueue.values()).filter(
    (v) => v.status === 'pending' && v.videoUrl,
  );
  if (pending.length === 0) return;

  // Download one video at a time to avoid overwhelming Telegram's Service Worker
  for (const item of pending) {
    requestDownload(item.videoUrl, item.videoId);
    // Wait a bit before starting the next to stagger requests
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ============================================================
// Auto-Scroll Scan + Download
// ============================================================

/**
 * Find the scrollable container for the chat messages.
 * Web K: .bubbles (has overflow-y scroll)
 * Web A: .MessageList or .messages-container
 */
function getScrollContainer(): HTMLElement | null {
  // Web K: .bubbles is the scrollable parent of .bubbles-inner
  const bubblesEl = document.querySelector<HTMLElement>('.bubbles');
  if (bubblesEl) return bubblesEl;

  // Web A
  return (
    document.querySelector<HTMLElement>('.MessageList') ||
    document.querySelector<HTMLElement>('.messages-container')
  );
}

/**
 * Auto-scroll through the entire chat, detect all videos, then download.
 *
 * Strategy:
 * 1. Scroll to the top of the current loaded messages
 * 2. Scroll down step-by-step (70% viewport per step)
 * 3. At each step, scan for video containers
 * 4. After reaching the bottom, resolve URLs and start downloads
 */
async function autoScrollAndDownload(): Promise<void> {
  if (isScanning) return;

  const scrollContainer = getScrollContainer();
  if (!scrollContainer) {
    console.warn('[TeleDown] Cannot find scroll container');
    startAllPendingDownloads();
    return;
  }

  isScanning = true;
  scanAborted = false;
  scanProgress = 0;
  updateControlPanel(computePanelState());

  console.log('[TeleDown] Auto-scroll scan started');

  // Save original scroll position to restore later if needed
  const originalScrollTop = scrollContainer.scrollTop;

  try {
    // Step 1: Scroll to top
    scrollContainer.scrollTop = 0;
    await sleep(800);

    if (scanAborted) return;

    // Step 2: Scan at top position
    processScannedVideos();

    // Step 3: Scroll down step-by-step
    const viewportHeight = scrollContainer.clientHeight;
    const scrollStep = Math.max(viewportHeight * 0.7, 200);

    let lastScrollHeight = scrollContainer.scrollHeight;
    let stuckCount = 0;

    while (!scanAborted) {
      const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const currentScroll = scrollContainer.scrollTop;

      // Update progress
      scanProgress = maxScroll > 0 ? Math.min(99, (currentScroll / maxScroll) * 100) : 99;
      updateControlPanel(computePanelState());

      // Check if we've reached the bottom
      if (currentScroll >= maxScroll - 5) {
        // Double-check: wait a bit and see if more content loaded
        await sleep(500);
        const newMaxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
        if (scrollContainer.scrollTop >= newMaxScroll - 5) break;
      }

      // Scroll down one step
      scrollContainer.scrollTop = Math.min(currentScroll + scrollStep, maxScroll);
      await sleep(600);

      if (scanAborted) break;

      // Scan for videos at current position
      processScannedVideos();

      // Detect if we're stuck (no new content loading, no scroll change)
      if (scrollContainer.scrollHeight === lastScrollHeight &&
          Math.abs(scrollContainer.scrollTop - currentScroll) < 5) {
        stuckCount++;
        if (stuckCount >= 3) break;
      } else {
        stuckCount = 0;
      }
      lastScrollHeight = scrollContainer.scrollHeight;
    }

    // Final scan at bottom
    if (!scanAborted) {
      processScannedVideos();
    }

    scanProgress = 100;
    updateControlPanel(computePanelState());

    console.log(`[TeleDown] Scan complete: ${videoQueue.size} video(s) found`);
  } finally {
    isScanning = false;
    scanProgress = 0;
    updateControlPanel(computePanelState());

    // Scroll back to bottom (natural position for chat)
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }

  // Start downloading all pending videos
  if (!scanAborted) {
    broadcastSettings();
    await startAllPendingDownloads();
  }
}

/** Process videos found by scanForVideos and add to queue */
function processScannedVideos(): void {
  const videos = scanForVideos();
  if (videos.length > 0) {
    onVideosDetected(videos);
  }
}

function stopScanning(): void {
  scanAborted = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Injected Script Loader
// ============================================================

let downloaderInjected = false;

function injectDownloaderScript(): void {
  if (downloaderInjected) return;
  downloaderInjected = true;

  const scriptUrl = chrome.runtime.getURL('inject/downloader.js');
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.onload = () => {
    script.remove();
    // Send settings after injection
    setTimeout(broadcastSettings, 200);
  };
  script.onerror = () => {
    script.remove();
    downloaderInjected = false;
  };
  (document.head || document.documentElement).appendChild(script);
}

// ============================================================
// Video Detection Callback
// ============================================================

function onVideosDetected(videos: DetectedVideo[]): void {
  let newlyAdded = 0;

  for (const video of videos) {
    const existing = videoQueue.get(video.videoId);
    if (!existing) {
      videoQueue.set(video.videoId, {
        videoId: video.videoId,
        videoUrl: video.videoUrl,
        status: 'pending',
        progress: 0,
        containerElement: video.containerElement,
      });
      newlyAdded++;
    } else if (!existing.videoUrl && video.videoUrl) {
      // URL became available (lazy-loaded) - update it
      existing.videoUrl = video.videoUrl;
      existing.containerElement = video.containerElement;
    }
  }

  // Inject download buttons (only for videos with URLs)
  const videosWithUrls = videos.filter((v) => v.videoUrl);
  if (videosWithUrls.length > 0) {
    injectDownloadButtons(videosWithUrls);
  }

  // Show / update panel
  showControlPanel(computePanelState());

  // Auto-download newly detected videos that have URLs
  if (settings.autoDownload && newlyAdded > 0) {
    const newVideos = videos.filter((v) => {
      const item = videoQueue.get(v.videoId);
      return item?.status === 'pending' && item.videoUrl;
    });
    newVideos.forEach((v, i) => {
      setTimeout(() => requestDownload(v.videoUrl, v.videoId), i * 1000);
    });
  }
}

// ============================================================
// Chat Navigation Detection (SPA URL changes)
// ============================================================

function handleChatChange(newUrl: string): void {
  if (newUrl === currentChatUrl) return;
  currentChatUrl = newUrl;

  console.log(`[TeleDown] Chat changed: ${newUrl}`);

  // Clear queue and detector's seen IDs for the new chat
  videoQueue.clear();
  clearSeenVideos();

  // Reset panel
  showControlPanel(computePanelState());
}

function setupUrlWatcher(): void {
  // Telegram Web is a SPA; watch for URL/hash changes
  let lastUrl = window.location.href;

  const urlObserver = new MutationObserver(() => {
    const url = window.location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      handleChatChange(url);
    }
  });

  urlObserver.observe(document.body, { childList: true, subtree: true });

  // Also listen to history API changes
  const origPushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    origPushState(...args);
    handleChatChange(window.location.href);
  };

  const origReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    origReplaceState(...args);
    handleChatChange(window.location.href);
  };

  window.addEventListener('popstate', () => {
    handleChatChange(window.location.href);
  });

  // Set initial URL
  currentChatUrl = window.location.href;
}

// ============================================================
// Panel Callbacks
// ============================================================

function onStartDownloadClick(): void {
  broadcastSettings(); // Ensure injected script has latest settings
  autoScrollAndDownload();
}

function onAutoDownloadToggle(enabled: boolean): void {
  settings.autoDownload = enabled;
  saveSettings();
  updateControlPanel(computePanelState());

  // If just enabled, start downloading pending videos
  if (enabled) {
    broadcastSettings();
    startAllPendingDownloads();
  }
}

// ============================================================
// File save handler (inject script → content → background)
// Uses window.postMessage (not CustomEvent) to cross Chrome's world boundary
// ============================================================

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'tele_down_save') return;

  const { blobUrl, fileName, folder } = event.data;
  if (!blobUrl || !fileName) return;

  console.log(`[TeleDown] Saving: ${folder}/${fileName}`);

  chrome.runtime.sendMessage({
    action: 'saveToDisk',
    data: { blobUrl, fileName, folder },
  }).then((response) => {
    if (!response?.success) {
      console.warn('[TeleDown] chrome.downloads failed, using fallback <a> download');
      // Fallback: use <a> tag download (no folder, but at least the file saves)
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }).catch((err) => {
    console.error('[TeleDown] saveToDisk error:', err);
    // Fallback
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
});

// ============================================================
// Background message listener (settings updates from popup)
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'settingsUpdated' && message.data) {
    settings = { ...DEFAULT_SETTINGS, ...message.data };
    broadcastSettings();
    updateControlPanel(computePanelState());
  }
});

// ============================================================
// Init
// ============================================================

async function init(): Promise<void> {
  console.log('[TeleDown] Initializing...');

  await loadSettings();

  // Setup injected script (page context downloader)
  injectDownloaderScript();

  // Setup per-button download handler
  setDownloadHandler(requestDownload);

  // Setup panel callbacks
  setControlPanelCallbacks(onStartDownloadClick, onAutoDownloadToggle, stopScanning);

  // Watch for URL changes (chat navigation)
  setupUrlWatcher();

  // Start watching for video elements
  startWatching(onVideosDetected);

  console.log('[TeleDown] Ready. Auto-download:', settings.autoDownload);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
