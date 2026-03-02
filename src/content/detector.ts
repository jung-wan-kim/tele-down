/**
 * TeleDown - Video Detector
 *
 * Monitors the Telegram Web DOM for video elements and extracts
 * their source URLs for downloading.
 *
 * Supports:
 * - Telegram Web K (web.telegram.org/k/) - uses .bubble, data-mid, video.full-media
 * - Telegram Web A (web.telegram.org/a/) - uses data-message-id, .full-media
 * - Chat messages (inline videos, round videos, document videos)
 * - Media viewer (full-screen video overlay)
 * - Shared media panel (right column search results)
 * - Stories viewer
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
  /** Source context: 'chat' | 'viewer' | 'panel' | 'story' */
  source?: string;
}

// ============================================================
// Platform Detection
// ============================================================

type TelegramPlatform = 'k' | 'a' | 'unknown';

function detectPlatform(): TelegramPlatform {
  const url = window.location.href;
  if (url.includes('/k/') || url.includes('/k#') || url.endsWith('/k')) return 'k';
  if (url.includes('/a/') || url.includes('/a#') || url.endsWith('/a')) return 'a';

  // Heuristic: Web K uses .bubbles-group, Web A uses .messages-container
  if (document.querySelector('.bubbles-group') || document.querySelector('.bubbles')) return 'k';
  if (document.querySelector('.messages-container') || document.querySelector('.MessageList')) return 'a';

  return 'unknown';
}

// ============================================================
// Video Source Extraction
// ============================================================

/**
 * Extract video URL from a video element.
 * Telegram Web uses <video src="...">, <video><source src="...">, or blob URLs.
 * Videos may also have currentSrc set by the player.
 */
function getVideoUrl(video: HTMLVideoElement): string | null {
  // Direct src attribute (most common in Telegram Web)
  const src = video.getAttribute('src');
  if (src && (src.includes('stream/') || src.includes('progressive/') || src.startsWith('blob:') || src.startsWith('http'))) {
    return src;
  }

  // Check source child elements (used in stories)
  const sourceEl = video.querySelector('source');
  if (sourceEl) {
    const sourceSrc = sourceEl.getAttribute('src');
    if (sourceSrc) return sourceSrc;
  }

  // currentSrc (set by the media player)
  if (video.currentSrc) {
    return video.currentSrc;
  }

  // Raw src as last resort
  if (video.src) {
    return video.src;
  }

  return null;
}

/**
 * Check if a URL looks like a valid Telegram video URL.
 */
function isValidVideoUrl(url: string | null): url is string {
  if (!url) return false;
  // Must be blob, stream, progressive, or http(s) URL
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

/**
 * Extract a unique video ID from the message container.
 * Web K: data-mid attribute
 * Web A: data-message-id attribute
 */
function getVideoId(element: HTMLElement, platform: TelegramPlatform): string {
  // Walk up the DOM looking for message ID attributes
  let current: HTMLElement | null = element;
  while (current) {
    // Web K: data-mid
    const mid = current.getAttribute('data-mid');
    if (mid) return `k-${mid}`;

    // Web A: data-message-id
    const msgId = current.getAttribute('data-message-id');
    if (msgId) return `a-${msgId}`;

    // Also check parent's data-mid (video elements are nested deeply)
    current = current.parentElement;
  }

  // Fallback: generate from content/position
  return `vid-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Get video ID specifically for media viewer context.
 * The media viewer may have URL fragments like #msgId or data attributes.
 */
function getMediaViewerVideoId(): string {
  // Try to extract from URL hash (Telegram often has message ID in hash)
  const hash = window.location.hash;
  const hashMatch = hash.match(/(\d+)$/);
  if (hashMatch) return `viewer-${hashMatch[1]}`;

  return `viewer-${Date.now()}`;
}

// ============================================================
// Chat Message Video Detection
// ============================================================

/**
 * Scan chat messages for video elements.
 * Telegram Web K: .bubble contains video.full-media or .media-video
 * Telegram Web A: [data-message-id] contains video.full-media
 */
function scanChatVideos(platform: TelegramPlatform): DetectedVideo[] {
  const detected: DetectedVideo[] = [];

  // Strategy 1: Find all video elements with full-media class (primary for both K and A)
  const fullMediaVideos = document.querySelectorAll<HTMLVideoElement>('video.full-media');
  fullMediaVideos.forEach((video) => {
    processVideoElement(video, platform, 'chat', detected);
  });

  // Strategy 2: Find .media-video elements (Web K specific)
  const mediaVideos = document.querySelectorAll<HTMLVideoElement>('video.media-video');
  mediaVideos.forEach((video) => {
    processVideoElement(video, platform, 'chat', detected);
  });

  // Strategy 3: Find any video inside message bubbles/containers that wasn't caught above
  const videoSelectors = platform === 'k'
    ? '.bubble video, .document-container video'
    : '[data-message-id] video, .Message video';

  const bubbleVideos = document.querySelectorAll<HTMLVideoElement>(videoSelectors);
  bubbleVideos.forEach((video) => {
    processVideoElement(video, platform, 'chat', detected);
  });

  // Strategy 4: Generic fallback - any video on the page that has a valid src
  const allVideos = document.querySelectorAll<HTMLVideoElement>('video');
  allVideos.forEach((video) => {
    processVideoElement(video, platform, 'chat', detected);
  });

  return detected;
}

// ============================================================
// Media Viewer Detection
// ============================================================

/**
 * Scan the media viewer overlay for video.
 * Web K: .media-viewer-movers .media-viewer-aspecter video
 * Web A: .MediaViewerSlide--active video
 */
function scanMediaViewer(platform: TelegramPlatform): DetectedVideo[] {
  const detected: DetectedVideo[] = [];

  // Web K media viewer
  const kViewerVideo = document.querySelector<HTMLVideoElement>(
    '.media-viewer-movers .media-viewer-aspecter video'
  );
  if (kViewerVideo) {
    const url = getVideoUrl(kViewerVideo);
    if (isValidVideoUrl(url)) {
      const container = kViewerVideo.closest<HTMLElement>('.media-viewer-aspecter') ||
        kViewerVideo.closest<HTMLElement>('.media-viewer-movers') ||
        kViewerVideo.parentElement!;
      const videoId = getMediaViewerVideoId();

      if (!container.querySelector('.tele-down-btn')) {
        detected.push({
          videoId,
          videoUrl: url,
          containerElement: container,
          source: 'viewer',
        });
      }
    }
  }

  // Web A media viewer
  const aViewerVideos = document.querySelectorAll<HTMLVideoElement>(
    '.MediaViewerSlide--active video'
  );
  aViewerVideos.forEach((video) => {
    const url = getVideoUrl(video);
    if (isValidVideoUrl(url)) {
      const container = video.closest<HTMLElement>('.MediaViewerSlide--active') ||
        video.parentElement!;
      const videoId = getMediaViewerVideoId();

      if (!container.querySelector('.tele-down-btn')) {
        detected.push({
          videoId,
          videoUrl: url,
          containerElement: container,
          source: 'viewer',
        });
      }
    }
  });

  // Generic: div.media-viewer-whole
  const genericViewerVideos = document.querySelectorAll<HTMLVideoElement>(
    'div.media-viewer-whole video'
  );
  genericViewerVideos.forEach((video) => {
    const url = getVideoUrl(video);
    if (isValidVideoUrl(url)) {
      const container = video.closest<HTMLElement>('.media-viewer-whole') || video.parentElement!;
      if (!container.querySelector('.tele-down-btn')) {
        detected.push({
          videoId: getMediaViewerVideoId(),
          videoUrl: url,
          containerElement: container,
          source: 'viewer',
        });
      }
    }
  });

  return detected;
}

// ============================================================
// Stories Viewer Detection
// ============================================================

/**
 * Scan stories viewer for video.
 * Web K: #stories-viewer video.media-video source
 * Web A: #StoryViewer .YiuvOPgT video source
 */
function scanStoriesViewer(): DetectedVideo[] {
  const detected: DetectedVideo[] = [];

  // Web K stories
  const kStoryVideos = document.querySelectorAll<HTMLVideoElement>('#stories-viewer video.media-video');
  kStoryVideos.forEach((video) => {
    const sourceEl = video.querySelector('source');
    const url = sourceEl?.getAttribute('src') || getVideoUrl(video);
    if (isValidVideoUrl(url)) {
      const container = video.closest<HTMLElement>('#stories-viewer') || video.parentElement!;
      if (!container.querySelector('.tele-down-btn')) {
        detected.push({
          videoId: `story-${Date.now()}`,
          videoUrl: url,
          containerElement: container,
          source: 'story',
        });
      }
    }
  });

  // Web A stories
  const aStoryVideos = document.querySelectorAll<HTMLVideoElement>('#StoryViewer video');
  aStoryVideos.forEach((video) => {
    const sourceEl = video.querySelector('source');
    const url = sourceEl?.getAttribute('src') || getVideoUrl(video);
    if (isValidVideoUrl(url)) {
      const container = video.closest<HTMLElement>('#StoryViewer') || video.parentElement!;
      if (!container.querySelector('.tele-down-btn')) {
        detected.push({
          videoId: `story-${Date.now()}`,
          videoUrl: url,
          containerElement: container,
          source: 'story',
        });
      }
    }
  });

  return detected;
}

// ============================================================
// Shared Media Panel Detection (Right Column Search)
// ============================================================

/**
 * Scan the shared media panel for video thumbnails.
 * Web K: #column-right .search-super-container-media.active .media-container
 * Web A: #RightColumn .Transition_slide-active .scroll-item
 */
function scanSharedMediaPanel(platform: TelegramPlatform): DetectedVideo[] {
  const detected: DetectedVideo[] = [];

  if (platform === 'k') {
    const mediaContainers = document.querySelectorAll<HTMLElement>(
      '.search-super-container-media.active .media-container'
    );
    mediaContainers.forEach((container) => {
      // Check if it has a video-time indicator (means it's a video, not a photo)
      const hasVideoTime = container.querySelector('.video-time') !== null;
      if (!hasVideoTime) return;

      const video = container.querySelector<HTMLVideoElement>('video');
      if (video) {
        processVideoElement(video, platform, 'panel', detected);
      }
    });
  }

  return detected;
}

// ============================================================
// Process a Single Video Element
// ============================================================

/** Set of already-seen video IDs to prevent duplicates */
const seenVideoIds = new Set<string>();

/**
 * Process a video element and add it to the detected list if valid.
 * Deduplicates by videoId.
 */
function processVideoElement(
  video: HTMLVideoElement,
  platform: TelegramPlatform,
  source: string,
  detected: DetectedVideo[],
): void {
  const url = getVideoUrl(video);
  if (!isValidVideoUrl(url)) return;

  // Find the best container element for placing the download button
  const container = findBestContainer(video, platform);
  if (!container) return;

  // Skip if already has a download button
  if (container.querySelector('.tele-down-btn')) return;

  // Get video ID
  const videoId = getVideoId(video, platform);

  // Skip duplicates
  if (seenVideoIds.has(videoId)) return;
  seenVideoIds.add(videoId);

  detected.push({
    videoId,
    videoUrl: url,
    containerElement: container,
    source,
  });
}

/**
 * Find the best container element for a video.
 * This is used both for extracting the video ID and for placing the download button.
 */
function findBestContainer(video: HTMLVideoElement, platform: TelegramPlatform): HTMLElement | null {
  if (platform === 'k') {
    // Web K hierarchy: .bubble > ... > .media-container > video.full-media
    return (
      video.closest<HTMLElement>('.media-container') ||
      video.closest<HTMLElement>('.document-container') ||
      video.closest<HTMLElement>('.bubble') ||
      video.closest<HTMLElement>('.message') ||
      video.parentElement
    );
  }

  if (platform === 'a') {
    // Web A hierarchy: [data-message-id] > ... > .media-inner > video.full-media
    return (
      video.closest<HTMLElement>('.media-inner') ||
      video.closest<HTMLElement>('[data-message-id]') ||
      video.closest<HTMLElement>('.Message') ||
      video.parentElement
    );
  }

  // Unknown platform: try common selectors
  return (
    video.closest<HTMLElement>('.media-container') ||
    video.closest<HTMLElement>('.media-inner') ||
    video.closest<HTMLElement>('.bubble') ||
    video.closest<HTMLElement>('.Message') ||
    video.closest<HTMLElement>('[data-mid]') ||
    video.closest<HTMLElement>('[data-message-id]') ||
    video.parentElement
  );
}

// ============================================================
// Main Scanner
// ============================================================

/** Clear seen video IDs (call on chat change to allow re-detection) */
export function clearSeenVideos(): void {
  seenVideoIds.clear();
}

/** Scan the current page for all video elements */
export function scanForVideos(): DetectedVideo[] {
  const platform = detectPlatform();
  const allDetected: DetectedVideo[] = [];

  // 1. Chat message videos (primary use case)
  const chatVideos = scanChatVideos(platform);
  allDetected.push(...chatVideos);

  // 2. Media viewer (full-screen overlay)
  const viewerVideos = scanMediaViewer(platform);
  allDetected.push(...viewerVideos);

  // 3. Stories viewer
  const storyVideos = scanStoriesViewer();
  allDetected.push(...storyVideos);

  // 4. Shared media panel (right column)
  const panelVideos = scanSharedMediaPanel(platform);
  allDetected.push(...panelVideos);

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
    }, 300);
  };

  observer = new MutationObserver((mutations) => {
    // Check if any mutation added video-related elements
    const hasRelevantChanges = mutations.some((mutation) => {
      if (mutation.type === 'childList') {
        // Check added nodes for video elements or video-containing elements
        return Array.from(mutation.addedNodes).some((node) => {
          if (!(node instanceof HTMLElement)) return false;

          // Direct video element added
          if (node.tagName === 'VIDEO') return true;

          // Container with video inside
          if (node.querySelector?.('video') !== null) return true;

          // Media viewer opened (Web K)
          if (node.classList?.contains('media-viewer-whole')) return true;

          // Media viewer slide (Web A)
          if (node.classList?.contains('MediaViewerSlide--active')) return true;

          // Stories viewer
          if (node.id === 'stories-viewer' || node.id === 'StoryViewer') return true;

          // Bubble with media (Web K) - may contain video that hasn't loaded yet
          if (node.classList?.contains('bubble')) {
            const hasVideoTime = node.querySelector('.video-time') !== null;
            const hasMediaVideo = node.querySelector('.media-video') !== null;
            if (hasVideoTime || hasMediaVideo) return true;
          }

          // Message with media (Web A)
          if (node.hasAttribute?.('data-message-id')) {
            if (node.querySelector('video, .media-inner video')) return true;
          }

          return false;
        });
      }

      // Watch for src/currentSrc attribute changes on video elements
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

  // Also re-scan periodically to catch lazy-loaded videos
  // Telegram Web loads video sources lazily when they come into viewport
  setInterval(() => {
    const videos = scanForVideos();
    if (videos.length > 0) {
      callback(videos);
    }
  }, 3000);

  console.log('[TeleDown] Video watcher started');
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
