/**
 * TeleDown - Content Script (Main Entry)
 *
 * Runs on web.telegram.org pages.
 * Responsibilities:
 * 1. Inject the downloader script into the page context
 * 2. Detect video elements and add download buttons
 * 3. Handle download requests from UI buttons
 * 4. Forward progress updates to the background service worker
 */

import { startWatching, type DetectedVideo } from './detector';
import {
  injectDownloadButtons,
  setDownloadHandler,
  updateButtonProgress,
  updateButtonCompleted,
  updateButtonError,
} from './ui';

// ============================================================
// Inject Download Script into Page Context
// ============================================================

/**
 * The downloader script needs to run in the PAGE context
 * (not the isolated content script context) because it needs
 * access to the page's fetch/network for authenticated requests.
 */
function injectDownloaderScript(): void {
  const scriptUrl = chrome.runtime.getURL('src/inject/downloader.ts');
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.type = 'module';
  script.onload = () => {
    console.log('[TeleDown] Downloader script injected');
    script.remove();
  };
  script.onerror = () => {
    console.error('[TeleDown] Failed to inject downloader script');
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

// ============================================================
// Download Request Dispatching
// ============================================================

let downloadCounter = 0;

function generateDownloadId(): string {
  return `dl-${Date.now()}-${++downloadCounter}`;
}

function requestDownload(videoUrl: string, videoId: string): void {
  const downloadId = generateDownloadId();

  console.log(`[TeleDown] Requesting download: ${videoId}`, videoUrl);

  // Notify background that download started
  chrome.runtime.sendMessage({
    action: 'downloadStarted',
    data: {
      videoId,
      downloadId,
      progress: 0,
      status: 'downloading' as const,
      fileName: videoId,
    },
  }).catch(() => {
    // Background may not be active
  });

  // Listen for progress events from the injected script
  const progressHandler = ((event: CustomEvent) => {
    const { progress } = event.detail;
    const progressNum = parseFloat(progress);

    updateButtonProgress(videoId, progressNum);

    // Forward to background
    chrome.runtime.sendMessage({
      action: 'downloadProgress',
      data: {
        videoId,
        downloadId,
        progress: progressNum,
        status: 'downloading' as const,
      },
    }).catch(() => {});

    // If progress reaches 100, treat as completed
    if (progressNum >= 99.9) {
      updateButtonCompleted(videoId);

      chrome.runtime.sendMessage({
        action: 'downloadCompleted',
        data: {
          videoId,
          downloadId,
          progress: 100,
          status: 'completed' as const,
        },
      }).catch(() => {});

      // Remove listener
      document.removeEventListener(
        `${videoId}_video_download_progress`,
        progressHandler as EventListener,
      );
    }
  }) as EventListener;

  // Listen for error events
  const errorHandler = ((event: CustomEvent) => {
    updateButtonError(videoId);

    chrome.runtime.sendMessage({
      action: 'downloadError',
      data: {
        videoId,
        downloadId,
        progress: 0,
        status: 'error' as const,
        error: event.detail?.error || 'Unknown error',
      },
    }).catch(() => {});

    // Clean up listeners
    document.removeEventListener(
      `${videoId}_video_download_progress`,
      progressHandler as EventListener,
    );
    document.removeEventListener(
      `${videoId}_video_download_error`,
      errorHandler as EventListener,
    );
  }) as EventListener;

  document.addEventListener(
    `${videoId}_video_download_progress`,
    progressHandler,
  );
  document.addEventListener(
    `${videoId}_video_download_error`,
    errorHandler,
  );

  // Dispatch the download event to the injected script
  const downloadEvent = new CustomEvent('video_download', {
    detail: {
      type: 'single',
      video_src: {
        video_url: videoUrl,
        video_id: videoId,
        page: window.location.href,
        download_id: downloadId,
      },
    },
  });
  document.dispatchEvent(downloadEvent);
}

// ============================================================
// Video Discovery Callback
// ============================================================

function onVideosDetected(videos: DetectedVideo[]): void {
  console.log(`[TeleDown] Detected ${videos.length} new video(s)`);
  injectDownloadButtons(videos);
}

// ============================================================
// Initialization
// ============================================================

function init(): void {
  console.log('[TeleDown] Content script initializing...');

  // 1. Inject the downloader script into the page
  injectDownloaderScript();

  // 2. Set up the download handler for UI buttons
  setDownloadHandler(requestDownload);

  // 3. Start watching for videos
  startWatching(onVideosDetected);

  console.log('[TeleDown] Content script ready');
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
