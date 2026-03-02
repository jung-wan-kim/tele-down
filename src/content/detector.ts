/**
 * TeleDown - Video Detector
 *
 * Monitors the Telegram Web DOM for video elements and extracts
 * their source URLs for downloading.
 */

export interface DetectedVideo {
  /** Unique identifier derived from the message */
  videoId: string;
  /** The video source URL (streaming or blob) */
  videoUrl: string;
  /** The DOM element containing the video */
  containerElement: HTMLElement;
  /** Optional file name hint */
  fileName?: string;
}

// ============================================================
// Video Source Extraction
// ============================================================

/**
 * Extract video URL from a video element.
 * Telegram Web uses either <video src="..."> or blob URLs.
 */
function getVideoUrl(video: HTMLVideoElement): string | null {
  // Direct src attribute
  if (video.src && video.src.startsWith('http')) {
    return video.src;
  }
  if (video.src && video.src.startsWith('blob:')) {
    return video.src;
  }

  // Check source child elements
  const source = video.querySelector('source');
  if (source?.src) {
    return source.src;
  }

  // Check currentSrc
  if (video.currentSrc) {
    return video.currentSrc;
  }

  return null;
}

/**
 * Extract a unique video ID from the message container.
 * Telegram Web assigns data-mid or similar attributes to messages.
 */
function getVideoId(messageElement: HTMLElement): string {
  // Try data-mid (message ID) from Telegram Web K
  const mid = messageElement.getAttribute('data-mid');
  if (mid) return `msg-${mid}`;

  // Try data-peer-id + data-mid combination
  const peerId = messageElement.getAttribute('data-peer-id');
  if (peerId && mid) return `${peerId}-${mid}`;

  // Fallback: use a hash of position/content
  const rect = messageElement.getBoundingClientRect();
  return `vid-${Math.round(rect.top)}-${Math.round(rect.left)}-${Date.now()}`;
}

// ============================================================
// Message Container Detection
// ============================================================

/**
 * Find the closest message container for a video element.
 * Works with both Telegram Web A and K versions.
 */
function findMessageContainer(video: HTMLVideoElement): HTMLElement | null {
  // Telegram Web K: .message, .bubble
  // Telegram Web A: .Message, .message-content-wrapper
  const selectors = [
    '.bubble',           // Web K
    '.message',          // Web K fallback
    '.Message',          // Web A
    '.media-container',  // Generic
  ];

  for (const selector of selectors) {
    const container = video.closest<HTMLElement>(selector);
    if (container) return container;
  }

  // Fallback to parent
  return video.parentElement;
}

// ============================================================
// Scanner
// ============================================================

/** Scan the current page for video elements */
export function scanForVideos(): DetectedVideo[] {
  const videos = document.querySelectorAll('video');
  const detected: DetectedVideo[] = [];

  videos.forEach((video) => {
    const videoUrl = getVideoUrl(video);
    if (!videoUrl) return;

    const container = findMessageContainer(video);
    if (!container) return;

    // Skip if already processed
    if (container.querySelector('.tele-down-btn')) return;

    const videoId = getVideoId(container);

    detected.push({
      videoId,
      videoUrl,
      containerElement: container,
    });
  });

  return detected;
}

// ============================================================
// MutationObserver - Watch for new videos
// ============================================================

type VideoCallback = (videos: DetectedVideo[]) => void;

let observer: MutationObserver | null = null;
let scanTimeout: ReturnType<typeof setTimeout> | null = null;

/** Start watching for new video elements in the DOM */
export function startWatching(callback: VideoCallback): void {
  if (observer) return;

  const debouncedScan = () => {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      const videos = scanForVideos();
      if (videos.length > 0) {
        callback(videos);
      }
    }, 500);
  };

  observer = new MutationObserver((mutations) => {
    // Check if any mutation added video-related elements
    const hasRelevantChanges = mutations.some((mutation) => {
      if (mutation.type === 'childList') {
        return Array.from(mutation.addedNodes).some(
          (node) =>
            node instanceof HTMLElement &&
            (node.tagName === 'VIDEO' ||
              node.querySelector?.('video') !== null),
        );
      }
      // Also watch for src attribute changes on video elements
      if (
        mutation.type === 'attributes' &&
        mutation.target instanceof HTMLVideoElement
      ) {
        return true;
      }
      return false;
    });

    if (hasRelevantChanges) {
      debouncedScan();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  // Initial scan
  debouncedScan();
}

/** Stop watching for new videos */
export function stopWatching(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (scanTimeout) {
    clearTimeout(scanTimeout);
    scanTimeout = null;
  }
}
