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
  /** Message timestamp text (e.g. "14:30", "2024.12.01 14:30") */
  timestamp?: string;
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
// Deduplication (handled by caller via videoQueue)
// ============================================================

/** No-op — dedup is now handled by index.ts videoQueue */
export function clearSeenVideos(): void {
  // intentionally empty
}

// ============================================================
// Chat Name Extraction
// ============================================================

/** Extract current chat/channel name from Telegram Web K or A */
export function getChatName(): string {
  // Web K: .chat-info .peer-title, or top bar title
  const kTitle =
    document.querySelector<HTMLElement>('.chat-info .peer-title') ||
    document.querySelector<HTMLElement>('.top .peer-title') ||
    document.querySelector<HTMLElement>('.chat-info-container .peer-title');
  if (kTitle?.textContent?.trim()) return sanitizeFileName(kTitle.textContent.trim());

  // Web A: .chat-title, .ChatInfo .title
  const aTitle =
    document.querySelector<HTMLElement>('.chat-title') ||
    document.querySelector<HTMLElement>('.ChatInfo .title');
  if (aTitle?.textContent?.trim()) return sanitizeFileName(aTitle.textContent.trim());

  return 'Unknown';
}

/** Remove characters invalid for file names */
function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
}

// ============================================================
// Timestamp Extraction
// ============================================================

/** Extract message timestamp from a bubble/message element */
function parseMessageTimestamp(element: HTMLElement): string | undefined {
  // Web K: .time .i18n or .time inner-text (e.g. "14:30")
  const timeEl =
    element.querySelector<HTMLElement>('.time .i18n') ||
    element.querySelector<HTMLElement>('.message-time') ||
    element.querySelector<HTMLElement>('.time');
  if (!timeEl) return undefined;

  // Get the time text, ignoring nested elements like status icons
  const text = timeEl.getAttribute('data-timestamp')
    || timeEl.textContent?.trim()
    || undefined;

  if (!text) return undefined;

  // If it's a unix timestamp attribute, convert
  const asNum = Number(text);
  if (!isNaN(asNum) && asNum > 1_000_000_000) {
    const d = new Date(asNum * 1000);
    return formatTimestamp(d);
  }

  // Text like "14:30" — combine with today's date
  if (/^\d{1,2}:\d{2}/.test(text)) {
    return text.replace(/:/g, '');
  }

  return text.replace(/[:/]/g, '').replace(/\s+/g, '_');
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
        timestamp: parseMessageTimestamp(bubble),
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
        timestamp: parseMessageTimestamp(msg),
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
      detected.push({ videoId, videoUrl: url, containerElement: container, source: 'viewer' });
    }
  }

  // Web A media viewer
  document.querySelectorAll<HTMLVideoElement>('.MediaViewerSlide--active video').forEach((video) => {
    const url = getVideoUrl(video);
    if (isValidVideoUrl(url)) {
      const container = video.closest<HTMLElement>('.MediaViewerSlide--active') || video.parentElement!;
      const videoId = getMediaViewerVideoId();
      detected.push({ videoId, videoUrl: url, containerElement: container, source: 'viewer' });
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
        detected.push({ videoId, videoUrl: url, containerElement: container, source: 'story' });
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
 * Simulate a real mouse click by dispatching the full pointer + mouse event
 * sequence. A plain el.click() only fires 'click', but Telegram Web K relies
 * on pointerdown / mousedown events for its UI handlers.
 */
function simulateClick(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const common: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
  };

  el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...common, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0 }));
}

/** Close the media viewer overlay if open */
function closeMediaViewer(): void {
  const closeBtn =
    document.querySelector<HTMLElement>('.media-viewer-close') ||
    document.querySelector<HTMLElement>('.btn-icon.media-viewer-close');
  if (closeBtn) {
    simulateClick(closeBtn);
  }
}

/**
 * Trigger Telegram to load a video's stream URL by simulating user interaction.
 *
 * Approach (same as reference extension):
 * 1. Close any existing media viewer
 * 2. Click the media container → opens media viewer
 * 3. Poll `.media-viewer-movers .media-viewer-aspecter video` for stream URL
 * 4. Return URL (keep viewer open — user wants to see it)
 */
export async function triggerVideoLoad(container: HTMLElement): Promise<string | null> {
  const bubble = container.closest<HTMLElement>('.bubble') ||
    container.closest<HTMLElement>('[data-message-id]') ||
    container;

  // Close any existing media viewer first
  const existingViewer = document.querySelector('.media-viewer-whole');
  if (existingViewer) {
    closeMediaViewer();
    await sleep(600);
  }

  // Scroll into view
  bubble.scrollIntoView({ behavior: 'instant', block: 'center' });
  await sleep(300);

  // Click the media container to open media viewer (same selector priority as reference extension)
  const clickTarget =
    bubble.querySelector<HTMLElement>('.media-container') ||
    bubble.querySelector<HTMLElement>('.media-video') ||
    bubble.querySelector<HTMLElement>('.btn-circle.video-play') ||
    bubble.querySelector<HTMLElement>('video') ||
    container;

  if (clickTarget) {
    console.log(`[TeleDown] simulateClick: ${clickTarget.tagName}.${clickTarget.className?.split(' ')[0] || '?'}`);
    simulateClick(clickTarget);
  }

  // Poll for stream URL in media viewer (reference extension uses same selector)
  const maxWait = 8000;
  const pollInterval = 300;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(pollInterval);

    // Primary: exact selector from reference extension
    const viewerVideo = document.querySelector<HTMLVideoElement>(
      '.media-viewer-movers .media-viewer-aspecter video'
    );
    if (viewerVideo) {
      const src = viewerVideo.getAttribute('src') || viewerVideo.src;
      if (src && src.includes('stream/')) {
        console.log(`[TeleDown] Got stream URL from media viewer`);
        return src;
      }
    }

    // Fallback: any video in the media viewer with stream URL
    const viewerVideos = document.querySelectorAll<HTMLVideoElement>('.media-viewer-whole video');
    for (const v of viewerVideos) {
      const src = v.getAttribute('src') || v.src;
      if (src && src.includes('stream/')) {
        console.log(`[TeleDown] Got stream URL from viewer (fallback)`);
        return src;
      }
    }

    // Log diagnostic after 3 seconds
    if (Date.now() - start > 3000 && Date.now() - start < 3500) {
      const viewerOpen = !!document.querySelector('.media-viewer-whole');
      const videos = document.querySelectorAll('.media-viewer-whole video');
      const srcs = Array.from(videos).map(v => (v as HTMLVideoElement).src || '(none)');
      console.log(`[TeleDown] Waiting for stream URL: viewerOpen=${viewerOpen}, viewerVideos=${videos.length}, srcs=${JSON.stringify(srcs)}`);
    }
  }

  // Timeout: close viewer since we couldn't get URL
  console.warn(`[TeleDown] triggerVideoLoad timeout after ${maxWait}ms`);
  closeMediaViewer();
  return null;
}

// ============================================================
// File ID Extraction from Telegram stream URLs
// ============================================================

/**
 * Extract the unique document file ID from a Telegram stream URL.
 * Works for both relative (stream/...) and absolute (https://.../stream/...) URLs.
 * Returns null for non-stream URLs (blob:, etc.)
 */
export function extractFileIdFromUrl(url: string): string | null {
  try {
    const streamIdx = url.indexOf('stream/');
    if (streamIdx === -1) return null;
    const encoded = url.substring(streamIdx + 7).split('?')[0];
    const parsed = JSON.parse(decodeURIComponent(encoded));
    return parsed?.location?.id ? String(parsed.location.id) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Main Scanner
// ============================================================

/** Scan the current page for all video containers (chat only — manual download mode) */
export function scanForVideos(): DetectedVideo[] {
  const platform = detectPlatform();
  return scanVideoContainers(platform);
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
