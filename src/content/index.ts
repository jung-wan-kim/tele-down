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
  // Use window.postMessage (NOT CustomEvent) to cross Chrome's world boundary
  // CustomEvent.detail may be null across isolated world → page context
  window.postMessage({
    type: 'tele_down_settings',
    downloadFolder: settings.downloadFolder,
    parallelChunks: settings.parallelChunks,
    downloadQueue: settings.downloadQueue,
  }, '*');
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
  if (!item) {
    console.warn(`[TeleDown] [${videoId}] requestDownload: not in queue`);
    return;
  }
  if (item.status === 'downloading' || item.status === 'completed') {
    console.log(`[TeleDown] [${videoId}] requestDownload: skip (${item.status})`);
    return;
  }

  const downloadId = generateDownloadId();
  item.status = 'downloading';
  item.progress = 0;
  videoQueue.set(videoId, item);

  console.log(`[TeleDown] [${videoId}] → dispatching to inject script, url=${videoUrl.substring(0, 80)}...`);

  updateControlPanel(computePanelState());

  chrome.runtime.sendMessage({
    action: 'downloadStarted',
    data: { videoId, downloadId, progress: 0, status: 'downloading', fileName: videoId },
  }).catch(() => {});

  // Dispatch download request to injected script (content → page: detail works)
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

/** Try to resolve a single video's URL with retries and scrolling */
async function resolveOneVideoUrl(item: QueueItem): Promise<string | null> {
  if (!item.containerElement) return null;

  // Attempt 1: check if URL appeared since detection
  let url = tryGetVideoUrl(item.containerElement);
  if (url) return url;

  // Attempt 2-4: scroll into view and wait progressively longer
  for (let attempt = 0; attempt < 3; attempt++) {
    url = await triggerVideoLoad(item.containerElement);
    if (url) return url;
    await sleep(300); // extra wait between retries
  }

  return null;
}

/** Download all pending videos using a sliding-window concurrency model.
 *  Resolves URLs on-demand for each video before downloading. */
async function startAllPendingDownloads(): Promise<void> {
  // Include ALL pending videos, even without URLs (will resolve on-demand)
  const pending = Array.from(videoQueue.values()).filter(
    (v) => v.status === 'pending',
  );
  if (pending.length === 0) {
    console.log('[TeleDown] No pending videos to download');
    return;
  }

  const withUrl = pending.filter((v) => v.videoUrl).length;
  const withoutUrl = pending.length - withUrl;
  const maxParallel = Math.max(1, Math.min(settings.parallelDownloads || 2, 5));
  console.log(`[TeleDown] Queue: ${pending.length} pending (${withUrl} with URL, ${withoutUrl} need resolve), parallel=${maxParallel}`);

  let nextIdx = 0;
  let activeCount = 0;
  let completedCount = 0;
  let skippedCount = 0;

  return new Promise<void>((resolveAll) => {
    function onSlotFreed(): void {
      activeCount--;
      fillSlots();
      if (activeCount === 0 && nextIdx >= pending.length) {
        console.log(`[TeleDown] All done: ${completedCount} started, ${skippedCount} skipped (no URL)`);
        resolveAll();
      }
    }

    async function fillSlots(): Promise<void> {
      while (activeCount < maxParallel && nextIdx < pending.length) {
        const item = pending[nextIdx++];
        if (item.status !== 'pending') {
          console.log(`[TeleDown] [${item.videoId}] skip: status=${item.status}`);
          continue;
        }

        // Resolve URL if needed
        if (!item.videoUrl) {
          console.log(`[TeleDown] [${item.videoId}] resolving URL...`);
          const url = await resolveOneVideoUrl(item);
          if (url) {
            item.videoUrl = url;
            console.log(`[TeleDown] [${item.videoId}] URL resolved`);
          } else {
            console.warn(`[TeleDown] [${item.videoId}] URL resolve FAILED, skipping`);
            skippedCount++;
            continue;
          }
        }

        activeCount++;
        completedCount++;
        console.log(`[TeleDown] [${item.videoId}] starting download (active=${activeCount}, remaining=${pending.length - nextIdx})`);
        startTrackedDownload(item.videoUrl, item.videoId, onSlotFreed);
      }
    }

    fillSlots();

    // Safety: if nothing was started, resolve immediately
    if (activeCount === 0 && nextIdx >= pending.length) resolveAll();
  });
}

/** Start a download and call onDone when it completes, errors, or times out */
function startTrackedDownload(
  videoUrl: string,
  videoId: string,
  onDone: () => void,
): void {
  const PER_VIDEO_TIMEOUT = 300000; // 5 min per video max
  let settled = false;

  function settle(reason: string): void {
    if (settled) return;
    settled = true;
    console.log(`[TeleDown] [${videoId}] slot freed: ${reason}`);
    onDone();
  }

  // Timeout fallback
  const timer = setTimeout(() => {
    if (!settled) {
      const item = videoQueue.get(videoId);
      if (item && item.status === 'downloading') {
        item.status = 'error';
        videoQueue.set(videoId, item);
        updateButtonError(videoId);
        updateControlPanel(computePanelState());
      }
      settle('timeout');
    }
  }, PER_VIDEO_TIMEOUT);

  // Watch for completion or error via status changes
  const checkInterval = setInterval(() => {
    const item = videoQueue.get(videoId);
    if (!item || item.status === 'completed' || item.status === 'error') {
      clearInterval(checkInterval);
      clearTimeout(timer);
      settle(item?.status || 'removed');
    }
  }, 500);

  requestDownload(videoUrl, videoId);
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
 * Auto-scroll through the entire chat history, detect all videos, then download.
 *
 * Chat scrolls UPWARD to load older messages (newest at bottom, oldest at top).
 *
 * Strategy:
 * 1. Scan at current position (bottom — newest messages)
 * 2. Scroll UP step-by-step to discover older messages
 * 3. At each step, wait for Telegram's lazy loading, then scan
 * 4. When top is reached (scrollTop=0) and no more history loads, stop
 * 5. Scroll back to bottom, then start downloading all detected videos
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

  console.log('[TeleDown] Auto-scroll scan started (scrolling UP through history)');

  // The starting position is at the bottom (most recent messages)
  const startScrollTop = scrollContainer.scrollTop;

  try {
    // Step 1: Scan at current position (bottom)
    processScannedVideos();

    if (scanAborted) return;

    // Step 2: Scroll UP step-by-step
    const viewportHeight = scrollContainer.clientHeight;
    const scrollStep = Math.max(viewportHeight * 0.7, 200);

    let lastScrollHeight = scrollContainer.scrollHeight;
    let lastScrollTop = scrollContainer.scrollTop;
    let stuckCount = 0;
    let totalScrolledUp = 0;

    while (!scanAborted) {
      const currentScrollTop = scrollContainer.scrollTop;

      // Update progress: how much of the chat we've scrolled through
      // startScrollTop is total scrollable distance from top to our start position
      if (startScrollTop > 0) {
        totalScrolledUp = startScrollTop - currentScrollTop;
        scanProgress = Math.min(99, (totalScrolledUp / startScrollTop) * 100);
      } else {
        scanProgress = 99;
      }
      updateControlPanel(computePanelState());

      // Check if we've reached the top
      if (currentScrollTop <= 0) {
        // Wait to see if Telegram loads more older messages
        await sleep(1500);
        const newScrollHeight = scrollContainer.scrollHeight;
        if (newScrollHeight <= lastScrollHeight + 100) {
          // No new content loaded — we've reached the oldest messages
          break;
        }
        // More history loaded: scrollHeight grew, scrollTop may have shifted
        // Continue scanning
        lastScrollHeight = newScrollHeight;
      }

      // Scroll UP one step
      const targetScrollTop = Math.max(0, currentScrollTop - scrollStep);
      scrollContainer.scrollTop = targetScrollTop;

      // Wait for Telegram to lazy-load video src + potentially load older messages
      await sleep(800);

      if (scanAborted) break;

      // Scan for videos at current position
      processScannedVideos();

      // Detect if we're stuck (scroll didn't move AND no new content)
      if (Math.abs(scrollContainer.scrollTop - lastScrollTop) < 5 &&
          scrollContainer.scrollHeight === lastScrollHeight) {
        stuckCount++;
        if (stuckCount >= 3) break;
      } else {
        stuckCount = 0;
      }

      lastScrollTop = scrollContainer.scrollTop;
      lastScrollHeight = scrollContainer.scrollHeight;
    }

    // Final scan at topmost position
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

    // Scroll back to bottom (most recent messages — natural chat position)
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

const MIN_DURATION_SECONDS = 60;

function onVideosDetected(videos: DetectedVideo[]): void {
  let newlyAdded = 0;

  for (const video of videos) {
    // Skip videos shorter than 1 minute
    if (video.durationSeconds !== undefined && video.durationSeconds < MIN_DURATION_SECONDS) {
      continue;
    }

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

  // Auto-download: if enabled and new videos found, auto-scroll + download
  if (settings.autoDownload && newlyAdded > 0 && !isScanning) {
    // Start auto-scroll scan + download (non-blocking)
    autoScrollAndDownload();
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

function onClearHistory(): void {
  videoQueue.clear();
  clearSeenVideos();
  downloadCounter = 0;

  // Remove all download buttons from DOM
  document.querySelectorAll('.tele-down-btn').forEach((btn) => btn.remove());

  updateControlPanel(computePanelState());
  console.log('[TeleDown] Download history cleared');
}

function onAutoDownloadToggle(enabled: boolean): void {
  settings.autoDownload = enabled;
  saveSettings();
  updateControlPanel(computePanelState());

  // If just enabled, auto-scroll + download
  if (enabled) {
    broadcastSettings();
    autoScrollAndDownload();
  }
}

// ============================================================
// Unified postMessage handler (inject script → content script)
// ALL inject→content communication uses postMessage because
// CustomEvent.detail is null across Chrome's world boundary
// ============================================================

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg?.type) return;

  switch (msg.type) {
    // ---- Download progress ----
    case 'tele_down_progress': {
      const videoId = msg.video_id as string;
      const progress = parseFloat(msg.progress);
      if (!videoId || isNaN(progress)) {
        console.warn('[TeleDown] Bad progress msg:', msg);
        return;
      }

      const item = videoQueue.get(videoId);
      if (!item) {
        console.warn(`[TeleDown] Progress for unknown video: ${videoId}`);
        return;
      }

      item.progress = progress;
      updateButtonProgress(videoId, progress);
      updateControlPanel(computePanelState());

      chrome.runtime.sendMessage({
        action: 'downloadProgress',
        data: { videoId, downloadId: msg.download_id || '', progress, status: 'downloading' },
      }).catch(() => {});

      if (progress >= 99.9) {
        console.log(`[TeleDown] [${videoId}] download COMPLETED`);
        item.status = 'completed';
        videoQueue.set(videoId, item);
        updateButtonCompleted(videoId);
        updateControlPanel(computePanelState());

        chrome.runtime.sendMessage({
          action: 'downloadCompleted',
          data: { videoId, downloadId: msg.download_id || '', progress: 100, status: 'completed' },
        }).catch(() => {});
      }
      break;
    }

    // ---- Download error ----
    case 'tele_down_error': {
      const videoId = msg.video_id as string;
      if (!videoId) return;
      console.error(`[TeleDown] [${videoId}] download ERROR: ${msg.error}`);

      const item = videoQueue.get(videoId);
      if (!item) return;

      item.status = 'error';
      videoQueue.set(videoId, item);
      updateButtonError(videoId);
      updateControlPanel(computePanelState());

      chrome.runtime.sendMessage({
        action: 'downloadError',
        data: {
          videoId,
          downloadId: msg.download_id || '',
          progress: 0,
          status: 'error',
          error: msg.error || 'Unknown error',
        },
      }).catch(() => {});
      break;
    }

    // ---- File save (inject → content → background) ----
    case 'tele_down_save': {
      const { blobUrl, fileName, folder } = msg;
      if (!blobUrl || !fileName) return;

      console.log(`[TeleDown] Saving: ${folder}/${fileName}`);

      chrome.runtime.sendMessage({
        action: 'saveToDisk',
        data: { blobUrl, fileName, folder },
      }).then((response) => {
        if (!response?.success) {
          console.warn('[TeleDown] chrome.downloads failed, using fallback <a> download');
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
      }).catch((err) => {
        console.error('[TeleDown] saveToDisk error:', err);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });
      break;
    }
  }
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
  setControlPanelCallbacks(onStartDownloadClick, onAutoDownloadToggle, stopScanning, onClearHistory);

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
