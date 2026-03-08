/**
 * TeleDown - Content Script (Main)
 *
 * Features:
 * 1. Inject downloader script into page context
 * 2. Detect videos via MutationObserver
 * 3. Per-video download button (manual click to resolve URL + download)
 * 4. Floating panel with download stats
 * 5. Folder-based download (configured via settings)
 * 6. Chat navigation detection (URL change)
 */

import { startWatching, clearSeenVideos, tryGetVideoUrl, triggerVideoLoad, getChatName, type DetectedVideo } from './detector';
import {
  injectDownloadButtons,
  setDownloadHandler,
  resetButtonToDefault,
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

/** Broadcast current settings to the injected page script */
function broadcastSettings(): void {
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
    downloadFolder: settings.downloadFolder,
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

  // Log all queue statuses for debugging
  const statuses = Array.from(videoQueue.entries()).map(([id, i]) => `${id}:${i.status}`).join(', ');
  console.log(`[TeleDown] [${videoId}] → requestDownload, url=${videoUrl.substring(0, 80)}...`);
  console.log(`[TeleDown] Queue: ${statuses}`);

  updateControlPanel(computePanelState());

  chrome.runtime.sendMessage({
    action: 'downloadStarted',
    data: { videoId, downloadId, progress: 0, status: 'downloading', fileName: videoId },
  }).catch(() => {});

  const chatName = getChatName();

  document.dispatchEvent(
    new CustomEvent('video_download', {
      detail: {
        type: 'single',
        video_src: {
          video_url: videoUrl,
          video_id: videoId,
          page: window.location.href,
          download_id: downloadId,
          chat_name: chatName,
        },
      },
    }),
  );
}

// ============================================================
// Manual Download (button click handler)
// ============================================================

/**
 * Handle manual download button click:
 * 1. If URL already resolved → download immediately
 * 2. If not → try to get URL from DOM, or open media viewer to extract stream URL
 * 3. Then dispatch download to injected script
 */
async function handleManualDownload(videoId: string): Promise<void> {
  const item = videoQueue.get(videoId);
  if (!item) return;
  if (item.status === 'downloading' || item.status === 'completed') return;

  // Reset error status for retry
  if (item.status === 'error') {
    item.status = 'pending';
  }

  let url = item.videoUrl;

  if (!url) {
    // Try to get URL from current DOM element
    if (item.containerElement?.isConnected) {
      url = tryGetVideoUrl(item.containerElement) || '';

      if (!url) {
        // Slow path: click to open media viewer → extract stream URL → close
        console.log(`[TeleDown] [${videoId}] No URL in DOM, trying triggerVideoLoad...`);
        url = await triggerVideoLoad(item.containerElement) || '';
      }
    }

    if (!url) {
      console.warn(`[TeleDown] [${videoId}] Failed to resolve URL (container connected=${item.containerElement?.isConnected})`);
      updateButtonError(videoId);
      return;
    }

    item.videoUrl = url;
  }

  broadcastSettings();
  requestDownload(url, videoId);
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

/**
 * Sync ALL button states with queue — prevents phantom "downloading" display.
 * Runs every scan cycle (3s) to catch any stale/incorrect button states.
 */
function syncButtonStates(): void {
  document.querySelectorAll<HTMLElement>('.tele-down-btn[data-video-id]').forEach((btn) => {
    const videoId = btn.dataset.videoId!;
    const item = videoQueue.get(videoId);

    const hasDownloading = btn.classList.contains('downloading');
    const hasCompleted = btn.classList.contains('completed');
    const hasError = btn.classList.contains('error');
    const hasAnyState = hasDownloading || hasCompleted || hasError;

    // Not in queue → must be default
    if (!item) {
      if (hasAnyState) resetButtonToDefault(videoId);
      return;
    }

    // Pending → must show default (no progress, not completed, not error)
    if (item.status === 'pending' && hasAnyState) {
      resetButtonToDefault(videoId);
    }
  });
}

function onVideosDetected(videos: DetectedVideo[]): void {
  let newCount = 0;

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
      newCount++;
    } else {
      if (!existing.videoUrl && video.videoUrl) {
        existing.videoUrl = video.videoUrl;
      }
      // Always update container reference when re-detected (fresh DOM element)
      if (video.containerElement?.isConnected) {
        existing.containerElement = video.containerElement;
      }
    }
  }

  if (newCount > 0) {
    console.log(`[TeleDown] ${newCount} new video(s) detected (total: ${videoQueue.size})`);
  }

  // Inject download buttons for ALL detected videos (including re-detected ones
  // whose DOM containers may have been recycled by Telegram's virtual scroll)
  const longVideos = videos.filter(
    (v) => v.durationSeconds === undefined || v.durationSeconds >= MIN_DURATION_SECONDS,
  );
  if (longVideos.length > 0) {
    injectDownloadButtons(longVideos);
  }

  // Reconcile: ensure NO button shows wrong state
  syncButtonStates();

  showControlPanel(computePanelState());
}

// ============================================================
// Chat Navigation Detection (SPA URL changes)
// ============================================================

function handleChatChange(newUrl: string): void {
  if (newUrl === currentChatUrl) return;
  currentChatUrl = newUrl;

  console.log(`[TeleDown] Chat changed: ${newUrl}`);

  videoQueue.clear();
  clearSeenVideos();

  showControlPanel(computePanelState());
}

function setupUrlWatcher(): void {
  let lastUrl = window.location.href;

  const urlObserver = new MutationObserver(() => {
    const url = window.location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      handleChatChange(url);
    }
  });

  urlObserver.observe(document.body, { childList: true, subtree: true });

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

  currentChatUrl = window.location.href;
}

// ============================================================
// Panel Callbacks
// ============================================================

function onClearHistory(): void {
  videoQueue.clear();
  clearSeenVideos();
  downloadCounter = 0;

  document.querySelectorAll('.tele-down-btn').forEach((btn) => btn.remove());

  updateControlPanel(computePanelState());
  console.log('[TeleDown] Download history cleared');
}

// ============================================================
// Unified postMessage handler (inject script → content script)
// ============================================================

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case 'tele_down_progress': {
      const videoId = msg.video_id as string;
      const progress = parseFloat(msg.progress);
      if (!videoId || isNaN(progress)) return;

      const item = videoQueue.get(videoId);
      if (!item) return;

      // Only process progress for items that are actually downloading
      if (item.status !== 'downloading') {
        console.log(`[TeleDown] [${videoId}] ignoring progress (status=${item.status}, not downloading)`);
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
        updateButtonCompleted(videoId);
        updateControlPanel(computePanelState());

        chrome.runtime.sendMessage({
          action: 'downloadCompleted',
          data: { videoId, downloadId: msg.download_id || '', progress: 100, status: 'completed' },
        }).catch(() => {});
      }
      break;
    }

    case 'tele_down_error': {
      const videoId = msg.video_id as string;
      if (!videoId) return;
      console.error(`[TeleDown] [${videoId}] download ERROR: ${msg.error}`);

      const item = videoQueue.get(videoId);
      if (!item || item.status !== 'downloading') return;

      item.status = 'error';
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

  injectDownloaderScript();

  // Per-button download handler: resolve URL on-demand + download
  setDownloadHandler(handleManualDownload);

  // Panel: only "clear history" callback needed
  setControlPanelCallbacks(onClearHistory);

  setupUrlWatcher();

  startWatching(onVideosDetected);

  console.log('[TeleDown] Ready (manual download mode)');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
