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

import { startWatching, type DetectedVideo } from './detector';
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
}

/** All detected videos for the current chat */
const videoQueue = new Map<string, QueueItem>();

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let downloadCounter = 0;
let currentChatUrl = '';

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
  };
}

function requestDownload(videoUrl: string, videoId: string): void {
  const item = videoQueue.get(videoId);
  if (!item || item.status === 'downloading' || item.status === 'completed') return;

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

/** Download all pending videos (respects parallelDownloads setting) */
async function startAllPendingDownloads(): Promise<void> {
  const pending = Array.from(videoQueue.values()).filter((v) => v.status === 'pending');
  if (pending.length === 0) return;

  const parallel = settings.parallelDownloads || 3;

  // Process in batches
  for (let i = 0; i < pending.length; i += parallel) {
    const batch = pending.slice(i, i + parallel);
    batch.forEach((item) => requestDownload(item.videoUrl, item.videoId));
    // Small delay between batches to avoid overwhelming the network
    if (i + parallel < pending.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// ============================================================
// Injected Script Loader
// ============================================================

let downloaderInjected = false;

function injectDownloaderScript(): void {
  if (downloaderInjected) return;
  downloaderInjected = true;

  const scriptUrl = chrome.runtime.getURL('src/inject/downloader.ts');
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.type = 'module';
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
    if (!videoQueue.has(video.videoId)) {
      videoQueue.set(video.videoId, {
        videoId: video.videoId,
        videoUrl: video.videoUrl,
        status: 'pending',
        progress: 0,
      });
      newlyAdded++;
    }
  }

  // Inject download buttons
  injectDownloadButtons(videos);

  // Show / update panel
  showControlPanel(computePanelState());

  // Auto-download newly detected videos
  if (settings.autoDownload && newlyAdded > 0) {
    const newVideos = videos.filter((v) => {
      const item = videoQueue.get(v.videoId);
      return item?.status === 'pending';
    });
    newVideos.forEach((v) => requestDownload(v.videoUrl, v.videoId));
  }
}

// ============================================================
// Chat Navigation Detection (SPA URL changes)
// ============================================================

function handleChatChange(newUrl: string): void {
  if (newUrl === currentChatUrl) return;
  currentChatUrl = newUrl;

  console.log(`[TeleDown] Chat changed: ${newUrl}`);

  // Clear queue for the new chat
  videoQueue.clear();

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
  startAllPendingDownloads();
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
  setControlPanelCallbacks(onStartDownloadClick, onAutoDownloadToggle);

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
