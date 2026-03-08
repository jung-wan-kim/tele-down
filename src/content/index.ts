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
  /** Number of URL resolve attempts (error only after MAX_RESOLVE_RETRIES) */
  resolveAttempts?: number;
}

const MAX_RESOLVE_RETRIES = 2;

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

  // Build filename prefix: [채팅방이름] 타임스탬프
  const chatName = getChatName();
  const timestamp = item.timestamp || '';

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
          timestamp,
        },
      },
    }),
  );
}

/** Try to resolve a single video's URL.
 *  Handles the case where the DOM element has been detached by Telegram's
 *  virtual scrolling — re-finds the bubble by scrolling to its message ID. */
async function resolveOneVideoUrl(item: QueueItem): Promise<string | null> {
  // Fast path: container still in DOM
  if (item.containerElement?.isConnected) {
    console.log(`[TeleDown] [${item.videoId}] container connected, trying direct resolve`);
    const url = tryGetVideoUrl(item.containerElement);
    if (url) return url;
    const loadedUrl = await triggerVideoLoad(item.containerElement);
    if (loadedUrl) return loadedUrl;
    // triggerVideoLoad failed with connected container — DOM might be stale
    // Clear reference so next attempt uses scrollToBubble
    console.log(`[TeleDown] [${item.videoId}] triggerVideoLoad failed, clearing container ref`);
    item.containerElement = undefined;
    return null;
  }

  // Container detached (virtual scroll removed it) — scroll to re-find
  console.log(`[TeleDown] [${item.videoId}] container disconnected, using scrollToBubble`);
  const scrollContainer = getScrollContainer();
  if (!scrollContainer) return null;

  const bubble = await scrollToBubble(item.videoId, scrollContainer);
  if (!bubble) {
    console.log(`[TeleDown] [${item.videoId}] scrollToBubble returned null`);
    return null;
  }

  // Update container reference to the live DOM element
  const container =
    bubble.querySelector<HTMLElement>('.media-container') ||
    bubble.querySelector<HTMLElement>('.media-video')?.parentElement ||
    bubble;
  item.containerElement = container;

  const url = tryGetVideoUrl(container);
  if (url) return url;

  return await triggerVideoLoad(container);
}

/**
 * Download all pending videos in two phases:
 *
 * Phase 1 — Resolve URLs (sequential, requires scrolling through chat)
 *   Telegram's virtual scroll removes DOM elements outside the viewport.
 *   We scroll to each message in order to re-render its bubble, then
 *   click the play button to obtain the stream URL.
 *   NEW: Continuously processes newly detected videos WITHOUT scrolling
 *   back to bottom, so we stay near the area where videos are being found.
 *
 * Phase 2 — Download files (parallel sliding-window)
 *   Once URLs are known, download concurrently.
 */
async function startAllPendingDownloads(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const maxParallel = Math.max(1, Math.min(settings.parallelDownloads || 2, 5));

    // ── Phase 1: Continuously resolve URLs ──
    // Process pending videos in a loop: as new videos are detected during
    // scrolling (periodic scan), they get processed immediately in the next
    // iteration — while we're still scrolled near them.
    const processedIds = new Set<string>();
    let totalResolved = 0;
    let pass = 0;

    while (true) {
      const needResolve = Array.from(videoQueue.values()).filter(
        (v) => v.status === 'pending' && !v.videoUrl && !processedIds.has(v.videoId),
      );
      // Also pick up items that failed but haven't exhausted retries
      const retryable = Array.from(videoQueue.values()).filter(
        (v) => v.status === 'error' && !v.videoUrl
          && (v.resolveAttempts || 0) < MAX_RESOLVE_RETRIES
          && !processedIds.has(v.videoId),
      );
      const allToResolve = [...needResolve, ...retryable];

      if (allToResolve.length === 0) break;

      pass++;
      // Sort by message ID ascending (oldest → newest = top → bottom)
      allToResolve.sort((a, b) => {
        const midA = parseInt(a.videoId.replace(/^[ka]-/, ''), 10) || 0;
        const midB = parseInt(b.videoId.replace(/^[ka]-/, ''), 10) || 0;
        return midA - midB;
      });

      const totalPending = Array.from(videoQueue.values()).filter(v => v.status === 'pending' || v.status === 'error').length;
      const retryCount = retryable.length;
      console.log(
        `[TeleDown] Phase 1 pass ${pass}: ${needResolve.length} new + ${retryCount} retry (total unresolved: ${totalPending})`,
      );

      for (const item of allToResolve) {
        if (item.videoUrl) {
          processedIds.add(item.videoId);
          continue;
        }
        // Reset error status for retry
        if (item.status === 'error') {
          item.status = 'pending';
          console.log(`[TeleDown] [${item.videoId}] retrying (attempt ${(item.resolveAttempts || 0) + 1}/${MAX_RESOLVE_RETRIES})`);
        }
        if (item.status !== 'pending') {
          processedIds.add(item.videoId);
          continue;
        }

        console.log(`[TeleDown] [${item.videoId}] resolving URL...`);
        const url = await resolveOneVideoUrl(item);
        if (url) {
          item.videoUrl = url;
          item.resolveAttempts = 0;
          totalResolved++;
          processedIds.add(item.videoId); // Only mark processed on SUCCESS
          console.log(`[TeleDown] [${item.videoId}] URL resolved`);
        } else {
          const attempts = (item.resolveAttempts || 0) + 1;
          item.resolveAttempts = attempts;
          if (attempts >= MAX_RESOLVE_RETRIES) {
            console.warn(`[TeleDown] [${item.videoId}] URL resolve FAILED after ${attempts} attempts, marking as error`);
            item.status = 'error';
            processedIds.add(item.videoId); // Exhausted retries — permanently done
            updateButtonError(item.videoId);
          } else {
            console.warn(`[TeleDown] [${item.videoId}] URL resolve FAILED (attempt ${attempts}/${MAX_RESOLVE_RETRIES}), will retry next pass`);
            item.status = 'error'; // temporarily error; NOT added to processedIds → retryable next pass
          }
        }

        // Brief DOM stabilization after each resolve attempt
        await sleep(200);

        // Opportunistic: while scrolled here, check other pending items in DOM
        for (const [, other] of videoQueue) {
          if (other.status !== 'pending' || other.videoUrl) continue;
          if (!other.containerElement?.isConnected) continue;
          const otherUrl = tryGetVideoUrl(other.containerElement);
          if (otherUrl) {
            other.videoUrl = otherUrl;
            totalResolved++;
            console.log(`[TeleDown] [${other.videoId}] URL resolved (opportunistic)`);
          }
        }
      }

      console.log(`[TeleDown] Phase 1 pass ${pass} done (total resolved: ${totalResolved})`);
      // Loop continues: check if new pending videos appeared during this pass
    }

    if (totalResolved === 0 && pass === 0) {
      console.log('[TeleDown] No pending videos to download');
    }

    // Scroll back to bottom ONCE (natural chat position)
    const sc = getScrollContainer();
    if (sc) {
      sc.scrollTop = sc.scrollHeight;
      await sleep(500);
    }

    // ── Phase 2: Download with sliding window concurrency ──
    // Dedup by file ID (not URL string) — same file may have different URL formats
    const seenFileIds = new Set<string>();
    const readyToDownload: QueueItem[] = [];
    for (const item of Array.from(videoQueue.values())) {
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
      console.log('[TeleDown] No videos ready to download');
      return;
    }

    console.log(`[TeleDown] Phase 2: Downloading ${readyToDownload.length} unique videos...`);

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
 * Auto-scroll through the entire chat history, detect videos AND resolve URLs
 * in a single pass, then download.
 *
 * Chat scrolls UPWARD to load older messages (newest at bottom, oldest at top).
 *
 * Strategy:
 * 1. Scan + resolve at current position (bottom — newest messages)
 * 2. Scroll UP step-by-step to discover older messages
 * 3. At each step, detect videos AND immediately resolve URLs
 *    (containers are guaranteed connected at this point)
 * 4. When top is reached (scrollTop=0) and no more history loads, stop
 * 5. Scroll back to bottom, then download all resolved videos
 *
 * This eliminates the need for scrollToBubble — URLs are resolved while
 * containers are still in the DOM, avoiding virtual scroll detachment issues.
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

  console.log('[TeleDown] Scan+Resolve started (scrolling UP through history)');

  const startScrollTop = scrollContainer.scrollTop;
  let totalResolved = 0;

  try {
    // Step 1: Scan + resolve at current position (bottom)
    processScannedVideos();
    totalResolved += await resolveConnectedUrls();

    if (scanAborted) return;

    // Step 2: Scroll UP step-by-step
    const viewportHeight = scrollContainer.clientHeight;
    const scrollStep = Math.max(viewportHeight * 0.7, 200);

    let lastScrollHeight = scrollContainer.scrollHeight;
    let lastScrollTop = scrollContainer.scrollTop;
    let stuckCount = 0;

    while (!scanAborted) {
      const currentScrollTop = scrollContainer.scrollTop;

      // Update progress
      if (startScrollTop > 0) {
        const totalScrolledUp = startScrollTop - currentScrollTop;
        scanProgress = Math.min(99, (totalScrolledUp / startScrollTop) * 100);
      } else {
        scanProgress = 99;
      }
      updateControlPanel(computePanelState());

      // Check if we've reached the top
      if (currentScrollTop <= 0) {
        await sleep(1500);
        const newScrollHeight = scrollContainer.scrollHeight;
        if (newScrollHeight <= lastScrollHeight + 100) {
          break; // No more history
        }
        lastScrollHeight = newScrollHeight;
      }

      // Scroll UP one step (gentler — avoid triggering Telegram's intersection observer debugger)
      const targetScrollTop = Math.max(0, currentScrollTop - scrollStep);
      scrollContainer.scrollTop = targetScrollTop;

      // Wait for Telegram to lazy-load + render
      await sleep(1000);

      if (scanAborted) break;

      // Detect videos at current position
      processScannedVideos();

      // Immediately resolve URLs while containers are connected
      totalResolved += await resolveConnectedUrls();

      if (scanAborted) break;

      // Stuck detection
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

    // Final scan + resolve at topmost position
    if (!scanAborted) {
      processScannedVideos();
      totalResolved += await resolveConnectedUrls();
    }

    scanProgress = 100;
    updateControlPanel(computePanelState());

    const pending = Array.from(videoQueue.values()).filter(v => v.status === 'pending').length;
    const withUrl = Array.from(videoQueue.values()).filter(v => v.status === 'pending' && v.videoUrl).length;
    console.log(`[TeleDown] Scan+Resolve complete: ${videoQueue.size} detected, ${totalResolved} resolved, ${pending} pending (${withUrl} with URL)`);
  } finally {
    isScanning = false;
    scanProgress = 0;
    updateControlPanel(computePanelState());
  }

  // Start downloading all resolved videos
  if (!scanAborted) {
    broadcastSettings();
    await startAllPendingDownloads();
  }
}

/**
 * Resolve URLs for all pending videos that have connected containers.
 * Called during the scroll scan — containers are guaranteed to be in the DOM.
 * Returns the number of newly resolved URLs.
 */
async function resolveConnectedUrls(): Promise<number> {
  const toResolve = Array.from(videoQueue.values()).filter(
    (v) => v.status === 'pending' && !v.videoUrl && v.containerElement?.isConnected,
  );

  if (toResolve.length === 0) return 0;

  let resolved = 0;
  for (const item of toResolve) {
    if (scanAborted) break;

    // Fast check: already has src?
    const url = tryGetVideoUrl(item.containerElement!);
    if (url) {
      item.videoUrl = url;
      resolved++;
      continue;
    }

    // Need click to trigger loading
    const loadedUrl = await triggerVideoLoad(item.containerElement!);
    if (loadedUrl) {
      item.videoUrl = loadedUrl;
      resolved++;
    }

    // Brief pause between clicks to let Telegram stabilize
    await sleep(300);
  }

  if (resolved > 0) {
    console.log(`[TeleDown] Resolved ${resolved} URLs at current scroll position`);
  }

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
// Virtual Scroll: Re-find bubbles removed from DOM
// ============================================================

/**
 * Find a message bubble by its video ID, scrolling through chat if the
 * element has been virtualized away (removed from DOM by Telegram's
 * virtual scrolling).
 *
 * Videos are processed in ascending mid order, so the scroll direction
 * is always forward (downward) for maximum efficiency.
 */
async function scrollToBubble(
  videoId: string,
  scrollContainer: HTMLElement,
): Promise<HTMLElement | null> {
  // Build the DOM selector from the video ID prefix
  let selector: string;
  let midAttr: string;
  if (videoId.startsWith('k-')) {
    selector = `.bubble[data-mid="${videoId.substring(2)}"]`;
    midAttr = 'data-mid';
  } else if (videoId.startsWith('a-')) {
    selector = `[data-message-id="${videoId.substring(2)}"]`;
    midAttr = 'data-message-id';
  } else {
    return null; // viewer/story IDs can't be scrolled to
  }

  // Already in DOM?
  let el = document.querySelector<HTMLElement>(selector);
  if (el?.isConnected) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    await sleep(300);
    return el;
  }

  // Determine scroll direction from currently visible message IDs
  const visibleIds = Array.from(
    document.querySelectorAll<HTMLElement>(`[${midAttr}]`),
  )
    .map((b) => parseInt(b.getAttribute(midAttr) || '0', 10))
    .filter((m) => m > 0);

  const targetId = parseInt(videoId.replace(/^[ka]-/, ''), 10);
  if (isNaN(targetId) || visibleIds.length === 0) return null;

  const minVisible = Math.min(...visibleIds);
  const maxVisible = Math.max(...visibleIds);
  const direction = targetId < minVisible ? -1 : 1;
  const step = scrollContainer.clientHeight * 0.6;
  const maxAttempts = 80;

  for (let i = 0; i < maxAttempts; i++) {
    scrollContainer.scrollTop += direction * step;
    await sleep(400);

    el = document.querySelector<HTMLElement>(selector);
    if (el?.isConnected) {
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      await sleep(300);
      return el;
    }

    // Boundary: hit top — wait for Telegram to load older messages
    if (direction < 0 && scrollContainer.scrollTop <= 0) {
      const prevHeight = scrollContainer.scrollHeight;
      for (let retry = 0; retry < 3; retry++) {
        await sleep(1000);
        el = document.querySelector<HTMLElement>(selector);
        if (el?.isConnected) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          await sleep(300);
          return el;
        }
        // If Telegram loaded more history (scrollHeight grew), keep trying
        if (scrollContainer.scrollHeight > prevHeight + 100) {
          scrollContainer.scrollTop = 0; // Stay at top to load more
          continue;
        }
      }
      break;
    }
    // Boundary: hit bottom
    if (
      direction > 0 &&
      scrollContainer.scrollTop + scrollContainer.clientHeight >=
        scrollContainer.scrollHeight - 10
    ) {
      break;
    }
  }

  return null;
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
