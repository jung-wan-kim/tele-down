/**
 * TeleDown - Video Detector
 *
 * Detects video messages in Telegram Web by scanning DOM containers,
 * NOT just <video> elements with src. This allows detection on chat entry
 * before Telegram lazy-loads video sources.
 *
 * Two-phase approach:
 * 1. Container detection: Find .bubble / [data-message-id] with video indicators
 *    (.video-time, video element, .media-video, etc.)
 * 2. URL extraction: Try to get video src; if unavailable, content script
 *    triggers lazy loading by scrolling into view.
 *
 * Supports:
 * - Telegram Web K (web.telegram.org/k/)
 * - Telegram Web A (web.telegram.org/a/)
 * - Chat messages, media viewer, stories, shared media panel
 */

export interface DetectedVideo {
  /** Unique identifier derived from the message */
  videoId: string;
  /** The video source URL (may be empty if not yet loaded) */
  videoUrl: string;
  /** The DOM element containing the video */
  containerElement: HTMLElement;
  /** Optional file name hint */
  fileName?: string;
  /** Source context */
  source?: string;
  /** Video duration in seconds (parsed from .video-time element) */
  durationSeconds?: number;
}

// ============================================================
// Platform Detection
// ============================================================

type TelegramPlatform = 'k' | 'a' | 'unknown';

function detectPlatform(): TelegramPlatform {
  const url = window.location.href;
  if (url.includes('/k/') || url.includes('/k#') || url.endsWith('/k')) return 'k';
  if (url.includes('/a/') || url.includes('/a#') || url.endsWith('/a')) return 'a';

  if (document.querySelector('.bubbles-group') || document.querySelector('.bubbles')) return 'k';
  if (document.querySelector('.messages-container') || document.querySelector('.MessageList')) return 'a';

  return 'unknown';
}

// ============================================================
// Video Source Extraction
// ============================================================

/** Extract video URL from a video element (may return null if not yet loaded) */
function getVideoUrl(video: HTMLVideoElement): string | null {
  const src = video.getAttribute('src');
  if (src && (src.includes('stream/') || src.includes('progressive/') || src.startsWith('blob:') || src.startsWith('http'))) {
    return src;
  }

  const sourceEl = video.querySelector('source');
  if (sourceEl) {
    const sourceSrc = sourceEl.getAttribute('src');
    if (sourceSrc) return sourceSrc;
  }

  if (video.currentSrc) return video.currentSrc;
  if (video.src) return video.src;

  return null;
}

function isValidVideoUrl(url: string | null): url is string {
  if (!url) return false;
  return (
    url.startsWith('blob:') ||
    url.includes('stream/') ||
    url.includes('progressive/') ||
    url.startsWith('https://') ||
    url.startsWith('http://')
  );
}

// ============================================================
// Video ID Extraction
// ============================================================

function getVideoId(element: HTMLElement, _platform: TelegramPlatform): string {
  let current: HTMLElement | null = element;
  while (current) {
    const mid = current.getAttribute('data-mid');
    if (mid) return `k-${mid}`;

    const msgId = current.getAttribute('data-message-id');
    if (msgId) return `a-${msgId}`;

    current = current.parentElement;
  }

  return `vid-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function getMediaViewerVideoId(): string {
  const hash = window.location.hash;
  const hashMatch = hash.match(/(\d+)$/);
  if (hashMatch) return `viewer-${hashMatch[1]}`;
  return `viewer-${Date.now()}`;
}

// ============================================================
// Deduplication
// ============================================================

const seenVideoIds = new Set<string>();

/** Clear seen video IDs (call on chat change) */
export function clearSeenVideos(): void {
  seenVideoIds.clear();
}

// ============================================================
// Duration Parsing
// ============================================================

/** Parse "M:SS" or "H:MM:SS" text from .video-time into seconds */
function parseVideoDuration(element: HTMLElement): number | undefined {
  const timeEl = element.querySelector('.video-time');
  if (!timeEl) return undefined;
  const text = (timeEl.textContent || '').trim();
  const parts = text.split(':').map(Number);
  if (parts.some(isNaN) || parts.length < 2) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

// ============================================================
// Container-Based Video Detection (Phase 1)
// ============================================================

/**
 * Find ALL video message containers in chat, even without loaded video src.
 * Looks for visual indicators: .video-time, video element, .media-video, etc.
 */
function scanVideoContainers(platform: TelegramPlatform): DetectedVideo[] {
  const detected: DetectedVideo[] = [];

  if (platform === 'k' || platform === 'unknown') {
    // Web K: .bubble elements with video indicators
    document.querySelectorAll<HTMLElement>('.bubble').forEach((bubble) => {
      const hasVideoTime = bubble.querySelector('.video-time') !== null;
      const hasVideo = bubble.querySelector('video') !== null;
      const hasMediaVideo = bubble.querySelector('.media-video') !== null;
      const hasRoundVideo = bubble.querySelector('.round-video-wrapper') !== null;

      if (!hasVideoTime && !hasVideo && !hasMediaVideo && !hasRoundVideo) return;

      const videoId = getVideoId(bubble, platform);
      if (seenVideoIds.has(videoId)) return;
      seenVideoIds.add(videoId);

      // Try to get video URL if video element exists
      const videoEl = bubble.querySelector<HTMLVideoElement>('video');
      const url = videoEl ? getVideoUrl(videoEl) : null;

      // Find the best container for the download button
      const container = videoEl
        ? (videoEl.closest<HTMLElement>('.media-container') ||
           videoEl.closest<HTMLElement>('.document-container') ||
           bubble)
        : (bubble.querySelector<HTMLElement>('.media-container') ||
           bubble.querySelector<HTMLElement>('.attachment') ||
           bubble);

      detected.push({
        videoId,
        videoUrl: url || '', // empty string = URL not yet available
        containerElement: container,
        source: 'chat',
        durationSeconds: parseVideoDuration(bubble),
      });
    });
  }

  if (platform === 'a' || platform === 'unknown') {
    // Web A: [data-message-id] elements with video indicators
    document.querySelectorAll<HTMLElement>('[data-message-id]').forEach((msg) => {
      const hasVideo = msg.querySelector('video') !== null;
      const hasVideoTime = msg.querySelector('.video-time') !== null;
      const hasMediaVideo = msg.querySelector('.media-video') !== null;

      if (!hasVideo && !hasVideoTime && !hasMediaVideo) return;

      const videoId = getVideoId(msg, platform);
      if (seenVideoIds.has(videoId)) return;
      seenVideoIds.add(videoId);

      const videoEl = msg.querySelector<HTMLVideoElement>('video');
      const url = videoEl ? getVideoUrl(videoEl) : null;

      const container = videoEl
        ? (videoEl.closest<HTMLElement>('.media-inner') || msg)
        : (msg.querySelector<HTMLElement>('.media-inner') || msg);

      detected.push({
        videoId,
        videoUrl: url || '',
        containerElement: container,
        source: 'chat',
        durationSeconds: parseVideoDuration(msg),
      });
    });
  }

  return detected;
}

// ============================================================
// Media Viewer Detection
// ============================================================

function scanMediaViewer(): DetectedVideo[] {
  const detected: DetectedVideo[] = [];

  // Web K media viewer
  const kViewerVideo = document.querySelector<HTMLVideoElement>(
    '.media-viewer-movers .media-viewer-aspecter video'
  );
  if (kViewerVideo) {
    const url = getVideoUrl(kViewerVideo);
    if (isValidVideoUrl(url)) {
      const container = kViewerVideo.closest<HTMLElement>('.media-viewer-aspecter') ||
        kViewerVideo.parentElement!;
      const videoId = getMediaViewerVideoId();
      if (!seenVideoIds.has(videoId)) {
        seenVideoIds.add(videoId);
        detected.push({ videoId, videoUrl: url, containerElement: container, source: 'viewer' });
      }
    }
  }

  // Web A media viewer
  document.querySelectorAll<HTMLVideoElement>('.MediaViewerSlide--active video').forEach((video) => {
    const url = getVideoUrl(video);
    if (isValidVideoUrl(url)) {
      const container = video.closest<HTMLElement>('.MediaViewerSlide--active') || video.parentElement!;
      const videoId = getMediaViewerVideoId();
      if (!seenVideoIds.has(videoId)) {
        seenVideoIds.add(videoId);
        detected.push({ videoId, videoUrl: url, containerElement: container, source: 'viewer' });
      }
    }
  });

  return detected;
}

// ============================================================
// Stories Viewer Detection
// ============================================================

function scanStoriesViewer(): DetectedVideo[] {
  const detected: DetectedVideo[] = [];

  const storySelectors = ['#stories-viewer video.media-video', '#StoryViewer video'];
  for (const selector of storySelectors) {
    document.querySelectorAll<HTMLVideoElement>(selector).forEach((video) => {
      const sourceEl = video.querySelector('source');
      const url = sourceEl?.getAttribute('src') || getVideoUrl(video);
      if (isValidVideoUrl(url)) {
        const container = video.closest<HTMLElement>('#stories-viewer') ||
          video.closest<HTMLElement>('#StoryViewer') ||
          video.parentElement!;
        const videoId = `story-${Date.now()}`;
        if (!seenVideoIds.has(videoId)) {
          seenVideoIds.add(videoId);
          detected.push({ videoId, videoUrl: url, containerElement: container, source: 'story' });
        }
      }
    });
  }

  return detected;
}

// ============================================================
// URL Resolution: Try to get URLs for detected videos
// ============================================================

/**
 * For a video container that was detected without a URL,
 * try to extract the URL from its video element (which may have loaded since detection).
 */
export function tryGetVideoUrl(container: HTMLElement): string | null {
  const video = container.querySelector<HTMLVideoElement>('video');
  if (!video) return null;
  const url = getVideoUrl(video);
  return isValidVideoUrl(url) ? url : null;
}

/**
 * Scroll a video container into view to trigger Telegram's lazy loading.
 * Returns a promise that resolves after a delay to allow src to be set.
 */
export async function triggerVideoLoad(container: HTMLElement): Promise<string | null> {
  // Find the bubble element to scroll to
  const bubble = container.closest<HTMLElement>('.bubble') ||
    container.closest<HTMLElement>('[data-message-id]') ||
    container;

  // Scroll the bubble into view to trigger Telegram's lazy loading
  // Do NOT save/restore scroll — let Telegram's IntersectionObserver detect the element
  bubble.scrollIntoView({ behavior: 'instant', block: 'center' });

  // Wait for Telegram to detect intersection + fetch + set video src
  await new Promise((r) => setTimeout(r, 1500));

  return tryGetVideoUrl(container);
}

// ============================================================
// Main Scanner
// ============================================================

/** Scan the current page for all video containers */
export function scanForVideos(): DetectedVideo[] {
  const platform = detectPlatform();
  const allDetected: DetectedVideo[] = [];

  // 1. Chat message video containers (primary - detects even without src)
  allDetected.push(...scanVideoContainers(platform));

  // 2. Media viewer
  allDetected.push(...scanMediaViewer());

  // 3. Stories viewer
  allDetected.push(...scanStoriesViewer());

  if (allDetected.length > 0) {
    console.log(`[TeleDown] Detected ${allDetected.length} video(s) [platform: ${platform}]`);
  }

  return allDetected;
}

// ============================================================
// MutationObserver - Watch for new videos
// ============================================================

type VideoCallback = (videos: DetectedVideo[]) => void;

let observer: MutationObserver | null = null;
let scanTimeout: ReturnType<typeof setTimeout> | null = null;

export function startWatching(callback: VideoCallback): void {
  if (observer) return;

  const debouncedScan = () => {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      const videos = scanForVideos();
      if (videos.length > 0) {
        callback(videos);
      }
    }, 300);
  };

  observer = new MutationObserver((mutations) => {
    const hasRelevantChanges = mutations.some((mutation) => {
      if (mutation.type === 'childList') {
        return Array.from(mutation.addedNodes).some((node) => {
          if (!(node instanceof HTMLElement)) return false;

          if (node.tagName === 'VIDEO') return true;
          if (node.querySelector?.('video')) return true;
          if (node.classList?.contains('media-viewer-whole')) return true;
          if (node.classList?.contains('MediaViewerSlide--active')) return true;
          if (node.id === 'stories-viewer' || node.id === 'StoryViewer') return true;

          // Bubble with any video indicators (Web K)
          if (node.classList?.contains('bubble')) {
            if (node.querySelector('.video-time, video, .media-video, .round-video-wrapper')) return true;
          }

          // Message with video (Web A)
          if (node.hasAttribute?.('data-message-id')) {
            if (node.querySelector('video, .video-time, .media-video')) return true;
          }

          return false;
        });
      }

      // Watch for src changes on video elements (lazy loading)
      if (mutation.type === 'attributes' && mutation.target instanceof HTMLVideoElement) {
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
    attributeFilter: ['src', 'currentSrc'],
  });

  // Initial scan
  debouncedScan();

  // Periodic rescan to catch lazy-loaded URLs
  setInterval(() => {
    const videos = scanForVideos();
    if (videos.length > 0) {
      callback(videos);
    }
  }, 3000);

  console.log('[TeleDown] Video watcher started');
}

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
