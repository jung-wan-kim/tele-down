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

import { startWatching, clearSeenVideos, tryGetVideoUrl, triggerVideoLoad, scanForVideos, getChatName, extractFileIdFromUrl, type DetectedVideo } from './detector';
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
  /** Message timestamp for filename */
  timestamp?: string;
}

/** All detected videos for the current chat */
const videoQueue = new Map<string, QueueItem>();

let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let downloadCounter = 0;
let currentChatUrl = '';
let isScanning = false;
let scanProgress = 0;
let scanAborted = false;
let isProcessing = false;

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

  // Build filename prefix: [채팅방이름]
  const chatName = getChatName();

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
          chat_name: chatName,
        },
      },
    }),
  );
}

/**
 * Download all resolved videos (dedup + sliding window).
 * No URL resolution here — all URLs should be resolved during scan.
 */
async function startDownloads(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const maxParallel = Math.max(1, Math.min(settings.parallelDownloads || 2, 5));

    // Scroll back to bottom (natural chat position)
    const sc = getScrollContainer();
    if (sc) {
      sc.scrollTop = sc.scrollHeight;
      await sleep(500);
    }

    // Dedup by file ID — same file may appear in multiple messages
    const seenFileIds = new Set<string>();
    const readyToDownload: QueueItem[] = [];
    for (const item of videoQueue.values()) {
      if (item.status !== 'pending' || !item.videoUrl) continue;
      const fileId = extractFileIdFromUrl(item.videoUrl);
      if (fileId) {
        if (seenFileIds.has(fileId)) {
          item.status = 'completed';
          console.log(`[TeleDown] [${item.videoId}] skipped (duplicate fileId=${fileId})`);
          continue;
        }
        seenFileIds.add(fileId);
      }
      readyToDownload.push(item);
    }
    updateControlPanel(computePanelState());

    if (readyToDownload.length === 0) {
      console.log('[TeleDown] No unique videos to download');
      return;
    }

    console.log(`[TeleDown] Downloading ${readyToDownload.length} unique videos...`);

    let nextIdx = 0;
    let activeCount = 0;
    let completedCount = 0;

    await new Promise<void>((resolveAll) => {
      function onSlotFreed(): void {
        activeCount--;
        fillSlots();
        if (activeCount === 0 && nextIdx >= readyToDownload.length) {
          console.log(`[TeleDown] All downloads complete: ${completedCount} started`);
          resolveAll();
        }
      }

      function fillSlots(): void {
        while (activeCount < maxParallel && nextIdx < readyToDownload.length) {
          const item = readyToDownload[nextIdx++];
          if (item.status !== 'pending') continue;

          activeCount++;
          completedCount++;
          console.log(
            `[TeleDown] [${item.videoId}] starting download (active=${activeCount}, remaining=${readyToDownload.length - nextIdx})`,
          );
          startTrackedDownload(item.videoUrl, item.videoId, onSlotFreed);
        }
      }

      fillSlots();
      if (activeCount === 0 && nextIdx >= readyToDownload.length) resolveAll();
    });
  } finally {
    isProcessing = false;
  }
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
 * Auto-scroll through chat history, detect AND resolve URLs one by one,
 * then download all resolved videos.
 *
 * At each scroll position:
 * 1. Detect visible videos (scanForVideos)
 * 2. For each newly detected video, immediately resolve its URL (one at a time)
 *    — container is guaranteed connected at this point
 * 3. Scroll UP, repeat until top of chat history
 * 4. After full scan, download all videos that have URLs
 *
 * No scrollToBubble, no retry phases — resolve happens during scan or not at all.
 */
async function autoScrollAndDownload(): Promise<void> {
  if (isScanning) return;

  const scrollContainer = getScrollContainer();
  if (!scrollContainer) {
    console.warn('[TeleDown] Cannot find scroll container');
    return;
  }

  isScanning = true;
  scanAborted = false;
  scanProgress = 0;
  updateControlPanel(computePanelState());

  // Wait for chat to fully load — Telegram renders messages lazily.
  // If autoDownload triggers too early, scrollHeight === viewportHeight (no scroll).
  let prevScrollHeight = scrollContainer.scrollHeight;
  for (let waitAttempt = 0; waitAttempt < 10; waitAttempt++) {
    await sleep(500);
    const newHeight = scrollContainer.scrollHeight;
    if (newHeight > prevScrollHeight + 50) {
      prevScrollHeight = newHeight;
      waitAttempt = 0; // still loading, reset wait counter
    }
  }

  // Scroll to bottom to ensure we start from the newest messages
  scrollContainer.scrollTop = scrollContainer.scrollHeight;
  await sleep(500);

  const viewportHeight = scrollContainer.clientHeight;
  const scrollStep = Math.max(viewportHeight * 0.7, 200);
  const startScrollTop = scrollContainer.scrollTop;

  console.log(`[TeleDown] Sequential scan started — startScrollTop=${startScrollTop}, scrollStep=${Math.round(scrollStep)}, viewportHeight=${viewportHeight}, scrollHeight=${scrollContainer.scrollHeight}`);

  let totalResolved = 0;

  try {
    // Step 1: Process at current position (bottom — newest messages)
    totalResolved += await scanAndResolveAtPosition();

    if (scanAborted) return;

    // Step 2: Scroll UP step-by-step using deterministic target position.
    // triggerVideoLoad opens/closes media viewer which disrupts scroll position,
    // so we track our own targetPosition that decreases monotonically.

    let targetPosition = startScrollTop;
    let lastScrollHeight = scrollContainer.scrollHeight;

    while (!scanAborted) {
      // Calculate next position (always moves UP)
      const prevTarget = targetPosition;
      targetPosition = Math.max(0, targetPosition - scrollStep);

      console.log(`[TeleDown] Scroll: ${Math.round(prevTarget)} → ${Math.round(targetPosition)} (actual=${scrollContainer.scrollTop})`);

      // Force scroll to target (overrides any shift from media viewer)
      scrollContainer.scrollTop = targetPosition;

      // Wait for Telegram to lazy-load + render at this position
      await sleep(1000);

      if (scanAborted) break;

      // Detect + resolve one by one at this position
      totalResolved += await scanAndResolveAtPosition();

      if (scanAborted) break;

      // Restore scroll position after URL resolution (media viewer may have changed it)
      if (Math.abs(scrollContainer.scrollTop - targetPosition) > 50) {
        scrollContainer.scrollTop = targetPosition;
        await sleep(300);
      }

      // Update progress
      if (startScrollTop > 0) {
        scanProgress = Math.min(99, ((startScrollTop - targetPosition) / startScrollTop) * 100);
      } else {
        scanProgress = 99;
      }
      updateControlPanel(computePanelState());

      // Top reached?
      if (targetPosition <= 0) {
        await sleep(1500);
        const newScrollHeight = scrollContainer.scrollHeight;
        if (newScrollHeight <= lastScrollHeight + 100) {
          console.log(`[TeleDown] Top reached, no more history (scrollHeight=${newScrollHeight})`);
          break; // No more history to load
        }
        // Telegram loaded older messages — scrollHeight grew
        console.log(`[TeleDown] Top reached, more history loading (scrollHeight: ${lastScrollHeight} → ${newScrollHeight})`);
        lastScrollHeight = newScrollHeight;
        // Stay at top to process newly loaded content
        continue;
      }

      lastScrollHeight = scrollContainer.scrollHeight;
    }

    // Final pass at topmost position
    if (!scanAborted) {
      scrollContainer.scrollTop = 0;
      await sleep(1000);
      totalResolved += await scanAndResolveAtPosition();
    }

    // Mark any remaining unresolved items as errors
    const unresolved: string[] = [];
    for (const item of videoQueue.values()) {
      if (item.status === 'pending' && !item.videoUrl) {
        item.status = 'error';
        updateButtonError(item.videoId);
        unresolved.push(item.videoId);
      }
    }
    if (unresolved.length > 0) {
      console.log(`[TeleDown] Marking ${unresolved.length} unresolved as error: ${unresolved.join(', ')}`);
    }

    scanProgress = 100;
    updateControlPanel(computePanelState());

    const total = videoQueue.size;
    const withUrl = Array.from(videoQueue.values()).filter(v => v.videoUrl).length;
    const errors = Array.from(videoQueue.values()).filter(v => v.status === 'error').length;
    console.log(`[TeleDown] Scan complete: ${total} detected, ${withUrl} URLs resolved, ${errors} errors`);
  } finally {
    isScanning = false;
    scanProgress = 0;
    updateControlPanel(computePanelState());
  }

  // Download all resolved videos
  if (!scanAborted) {
    broadcastSettings();
    await startDownloads();
  }
}

/**
 * Detect videos at current scroll position and resolve each URL one by one.
 * Called during auto-scroll — containers are guaranteed connected.
 * Returns number of newly resolved URLs.
 */
async function scanAndResolveAtPosition(): Promise<number> {
  // Detect videos and add to queue
  processScannedVideos();

  // Count all pending items without URL (including disconnected ones)
  const allPending = Array.from(videoQueue.values()).filter(
    (v) => v.status === 'pending' && !v.videoUrl,
  );
  const connected = allPending.filter((v) => v.containerElement?.isConnected);
  const disconnected = allPending.filter((v) => !v.containerElement?.isConnected);

  if (disconnected.length > 0) {
    console.log(`[TeleDown] ${disconnected.length} items skipped (disconnected): ${disconnected.map(v => v.videoId).join(', ')}`);
  }

  if (connected.length === 0) return 0;

  let resolved = 0;
  let skippedDisconnect = 0;
  let failedLoad = 0;
  for (const item of connected) {
    if (scanAborted) break;

    // Re-check: previous triggerVideoLoad may have caused Telegram to re-render
    if (!item.containerElement?.isConnected) {
      skippedDisconnect++;
      console.log(`[TeleDown] [${item.videoId}] disconnected during resolution (other click caused re-render)`);
      continue;
    }

    // Fast: check if video src is already in DOM
    const url = tryGetVideoUrl(item.containerElement);
    if (url) {
      item.videoUrl = url;
      resolved++;
      continue;
    }

    // Slow: click to open media viewer → extract stream URL → close viewer
    const loadedUrl = await triggerVideoLoad(item.containerElement);
    if (loadedUrl) {
      item.videoUrl = loadedUrl;
      resolved++;
    } else {
      failedLoad++;
      console.log(`[TeleDown] [${item.videoId}] triggerVideoLoad failed (container.isConnected=${item.containerElement?.isConnected})`);
    }

    // Brief pause between each video to let Telegram stabilize
    await sleep(300);
  }

  console.log(`[TeleDown] Position result: ${resolved} resolved, ${skippedDisconnect} disconnected mid-process, ${failedLoad} load failed (of ${connected.length} attempted)`);

  return resolved;
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
        timestamp: video.timestamp,
      });
      newlyAdded++;
    } else if (!existing.videoUrl) {
      if (video.videoUrl) {
        // URL became available (lazy-loaded) - update it
        existing.videoUrl = video.videoUrl;
      }
      // Always update container reference when re-detected (fresh DOM element)
      if (video.containerElement?.isConnected) {
        existing.containerElement = video.containerElement;
      }
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
  if (settings.autoDownload && newlyAdded > 0 && !isScanning && !isProcessing) {
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
