/**
 * TeleDown - Content Script UI
 *
 * Injects download buttons onto detected video messages
 * and manages progress display.
 */

import type { DetectedVideo } from './detector';

// ============================================================
// CSS Injection
// ============================================================

const STYLES = `
.tele-down-btn {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  padding: 0;
}

.tele-down-btn:hover {
  background: rgba(0, 0, 0, 0.85);
  transform: scale(1.1);
}

.tele-down-btn:active {
  transform: scale(0.95);
}

.tele-down-btn svg {
  width: 18px;
  height: 18px;
  fill: white;
}

.tele-down-btn.downloading {
  pointer-events: none;
}

.tele-down-btn.downloading svg {
  display: none;
}

.tele-down-progress {
  width: 20px;
  height: 20px;
  position: relative;
}

.tele-down-progress-ring {
  transform: rotate(-90deg);
}

.tele-down-progress-ring circle {
  fill: none;
  stroke-width: 3;
}

.tele-down-progress-ring .bg {
  stroke: rgba(255, 255, 255, 0.2);
}

.tele-down-progress-ring .fg {
  stroke: #4fc3f7;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.3s ease;
}

.tele-down-progress-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 7px;
  font-weight: bold;
  color: white;
  line-height: 1;
}

.tele-down-btn.completed {
  background: rgba(76, 175, 80, 0.8);
}

.tele-down-btn.error {
  background: rgba(244, 67, 54, 0.8);
}

/* Ensure parent containers have position relative */
.bubble .media-container,
.Message .media-inner {
  position: relative;
}
`;

let styleInjected = false;

function injectStyles(): void {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.textContent = STYLES;
  style.id = 'tele-down-styles';
  document.head.appendChild(style);
  styleInjected = true;
}

// ============================================================
// Download Button SVG Icon
// ============================================================

const DOWNLOAD_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
</svg>
`;

const CHECK_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
</svg>
`;

const ERROR_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
</svg>
`;

// ============================================================
// Progress Ring Component
// ============================================================

function createProgressRing(progress: number): string {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (progress / 100) * circumference;

  return `
    <div class="tele-down-progress">
      <svg class="tele-down-progress-ring" width="20" height="20" viewBox="0 0 20 20">
        <circle class="bg" cx="10" cy="10" r="${radius}" />
        <circle class="fg" cx="10" cy="10" r="${radius}"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${offset}" />
      </svg>
      <span class="tele-down-progress-text">${Math.round(progress)}%</span>
    </div>
  `;
}

// ============================================================
// Button Management
// ============================================================

export type DownloadHandler = (videoUrl: string, videoId: string) => void;

let downloadHandler: DownloadHandler | null = null;

export function setDownloadHandler(handler: DownloadHandler): void {
  downloadHandler = handler;
}

/** Inject download button onto a detected video */
export function injectDownloadButton(video: DetectedVideo): void {
  injectStyles();

  const { containerElement, videoId, videoUrl } = video;

  // Skip if button already exists
  if (containerElement.querySelector('.tele-down-btn')) return;

  // Ensure container has relative positioning
  const mediaContainer =
    containerElement.querySelector('.media-container') ||
    containerElement.querySelector('.media-inner') ||
    containerElement;

  const computed = window.getComputedStyle(mediaContainer);
  if (computed.position === 'static') {
    (mediaContainer as HTMLElement).style.position = 'relative';
  }

  // Create button
  const btn = document.createElement('button');
  btn.className = 'tele-down-btn';
  btn.dataset.videoId = videoId;
  btn.dataset.videoUrl = videoUrl;
  btn.innerHTML = DOWNLOAD_ICON;
  btn.title = 'Download Video';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (btn.classList.contains('downloading') || btn.classList.contains('completed')) {
      return;
    }

    if (downloadHandler) {
      downloadHandler(videoUrl, videoId);
    }
  });

  mediaContainer.appendChild(btn);
}

/** Update button to show download progress */
export function updateButtonProgress(videoId: string, progress: number): void {
  const btn = document.querySelector(
    `.tele-down-btn[data-video-id="${videoId}"]`,
  ) as HTMLElement | null;

  if (!btn) return;

  btn.classList.add('downloading');
  btn.innerHTML = createProgressRing(progress);
  btn.title = `Downloading: ${Math.round(progress)}%`;
}

/** Update button to show completed state */
export function updateButtonCompleted(videoId: string): void {
  const btn = document.querySelector(
    `.tele-down-btn[data-video-id="${videoId}"]`,
  ) as HTMLElement | null;

  if (!btn) return;

  btn.classList.remove('downloading');
  btn.classList.add('completed');
  btn.innerHTML = CHECK_ICON;
  btn.title = 'Download Complete';

  // Reset after 5 seconds
  setTimeout(() => {
    btn.classList.remove('completed');
    btn.innerHTML = DOWNLOAD_ICON;
    btn.title = 'Download Video';
  }, 5000);
}

/** Update button to show error state */
export function updateButtonError(videoId: string): void {
  const btn = document.querySelector(
    `.tele-down-btn[data-video-id="${videoId}"]`,
  ) as HTMLElement | null;

  if (!btn) return;

  btn.classList.remove('downloading');
  btn.classList.add('error');
  btn.innerHTML = ERROR_ICON;
  btn.title = 'Download Failed (click to retry)';

  // Allow retry after error
  setTimeout(() => {
    btn.classList.remove('error');
    btn.innerHTML = DOWNLOAD_ICON;
    btn.title = 'Download Video';
  }, 3000);
}

/** Inject buttons for multiple videos */
export function injectDownloadButtons(videos: DetectedVideo[]): void {
  videos.forEach(injectDownloadButton);
}
