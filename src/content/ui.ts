/**
 * TeleDown - Content Script UI
 *
 * 1. Download buttons on each video
 * 2. Floating control panel (Start Download / Auto-download toggle)
 */

import type { DetectedVideo } from './detector';

// ============================================================
// CSS
// ============================================================

const STYLES = `
/* === Download button on video === */
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
  background: rgba(0, 0, 0, 0.65);
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  padding: 0;
}
.tele-down-btn:hover { background: rgba(0, 0, 0, 0.88); transform: scale(1.1); }
.tele-down-btn:active { transform: scale(0.95); }
.tele-down-btn svg { width: 18px; height: 18px; fill: white; }
.tele-down-btn.downloading { pointer-events: none; }
.tele-down-btn.downloading svg { display: none; }

.tele-down-progress { width: 20px; height: 20px; position: relative; }
.tele-down-progress-ring { transform: rotate(-90deg); }
.tele-down-progress-ring circle { fill: none; stroke-width: 3; }
.tele-down-progress-ring .bg { stroke: rgba(255,255,255,0.2); }
.tele-down-progress-ring .fg {
  stroke: #4fc3f7;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.3s ease;
}
.tele-down-progress-text {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  font-size: 7px; font-weight: bold; color: white; line-height: 1;
}
.tele-down-btn.completed { background: rgba(76, 175, 80, 0.85); }
.tele-down-btn.error { background: rgba(244, 67, 54, 0.85); }

/* Ensure relative positioning for download button placement */
.bubble .media-container,
.bubble .document-container,
.Message .media-inner,
.media-viewer-aspecter,
.MediaViewerSlide--active,
.media-viewer-whole,
#stories-viewer,
#StoryViewer { position: relative; }

/* === Floating control panel === */
#tele-down-panel {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 99999;
  width: 260px;
  background: #1e1e2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  color: #e0e0e0;
  user-select: none;
  transition: opacity 0.2s, transform 0.2s;
}
#tele-down-panel.hidden {
  opacity: 0;
  pointer-events: none;
  transform: translateY(8px);
}

.tdp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
}
.tdp-title {
  font-size: 13px;
  font-weight: 700;
  color: #4fc3f7;
  letter-spacing: 0.3px;
}
.tdp-close {
  background: none;
  border: none;
  cursor: pointer;
  color: #6c6c80;
  padding: 0;
  display: flex;
  align-items: center;
  line-height: 1;
  font-size: 16px;
}
.tdp-close:hover { color: #e0e0e0; }

.tdp-body { padding: 10px 14px; }

.tdp-stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.tdp-stat-label { color: #a0a0b0; font-size: 12px; }
.tdp-stat-value {
  font-weight: 700;
  color: #e0e0e0;
  font-size: 13px;
}
.tdp-stat-value.highlight { color: #4fc3f7; }

.tdp-progress-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 11px;
  color: #a0a0b0;
}
.tdp-progress-row span { flex: 1; text-align: center; }
.tdp-progress-row .cnt-downloading { color: #4fc3f7; font-weight: 600; }
.tdp-progress-row .cnt-done { color: #66bb6a; font-weight: 600; }
.tdp-progress-row .cnt-error { color: #ef5350; font-weight: 600; }

.tdp-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  padding: 6px 0;
  border-top: 1px solid rgba(255,255,255,0.06);
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.tdp-toggle-label { font-size: 12px; color: #a0a0b0; }

/* Toggle switch */
.tdp-toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
}
.tdp-toggle input { opacity: 0; width: 0; height: 0; }
.tdp-toggle-slider {
  position: absolute;
  inset: 0;
  background: #353550;
  border-radius: 20px;
  transition: background 0.2s;
}
.tdp-toggle-slider::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #6c6c80;
  transition: transform 0.2s, background 0.2s;
}
.tdp-toggle input:checked + .tdp-toggle-slider { background: rgba(79,195,247,0.25); }
.tdp-toggle input:checked + .tdp-toggle-slider::before {
  transform: translateX(16px);
  background: #4fc3f7;
}

.tdp-folder-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 11px;
  color: #6c6c80;
}
.tdp-folder-row svg { flex-shrink: 0; }

.tdp-btn-start {
  width: 100%;
  padding: 9px 0;
  background: #4fc3f7;
  border: none;
  border-radius: 8px;
  color: #0d0d1a;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.tdp-btn-start:hover { background: #29b6f6; }
.tdp-btn-start:active { transform: scale(0.97); }
.tdp-btn-start:disabled {
  background: #353550;
  color: #6c6c80;
  cursor: not-allowed;
  transform: none;
}
.tdp-btn-start svg { width: 14px; height: 14px; fill: currentColor; }

/* Scanning state */
.tdp-btn-start.scanning {
  background: #353550;
  color: #4fc3f7;
  cursor: default;
}
.tdp-btn-stop {
  width: 100%;
  padding: 7px 0;
  margin-top: 6px;
  background: transparent;
  border: 1px solid rgba(239, 83, 80, 0.4);
  border-radius: 8px;
  color: #ef5350;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.tdp-btn-stop:hover { background: rgba(239, 83, 80, 0.1); }

@keyframes tdp-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.tdp-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(79,195,247,0.3);
  border-top-color: #4fc3f7;
  border-radius: 50%;
  animation: tdp-spin 0.8s linear infinite;
}

.tdp-scan-bar {
  height: 3px;
  background: #353550;
  border-radius: 2px;
  margin-bottom: 10px;
  overflow: hidden;
}
.tdp-scan-bar-fill {
  height: 100%;
  background: #4fc3f7;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.tdp-btn-clear {
  width: 100%;
  padding: 7px 0;
  margin-top: 6px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: #6c6c80;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.tdp-btn-clear:hover { background: rgba(255,255,255,0.05); color: #a0a0b0; }
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
// SVG Icons
// ============================================================

const ICON_DOWNLOAD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
const ICON_CHECK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
const ICON_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;

// ============================================================
// Progress Ring
// ============================================================

function createProgressRing(progress: number): string {
  const r = 8;
  const circ = 2 * Math.PI * r;
  const offset = circ - (progress / 100) * circ;
  return `
    <div class="tele-down-progress">
      <svg class="tele-down-progress-ring" width="20" height="20" viewBox="0 0 20 20">
        <circle class="bg" cx="10" cy="10" r="${r}"/>
        <circle class="fg" cx="10" cy="10" r="${r}"
          stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
      </svg>
      <span class="tele-down-progress-text">${Math.round(progress)}%</span>
    </div>`;
}

// ============================================================
// Per-video Download Button
// ============================================================

export type DownloadHandler = (videoUrl: string, videoId: string) => void;
let downloadHandler: DownloadHandler | null = null;
export function setDownloadHandler(handler: DownloadHandler): void {
  downloadHandler = handler;
}

export function injectDownloadButton(video: DetectedVideo): void {
  injectStyles();
  const { containerElement, videoId, videoUrl } = video;
  if (containerElement.querySelector('.tele-down-btn')) return;

  const mediaContainer =
    containerElement.querySelector<HTMLElement>('.media-container') ||
    containerElement.querySelector<HTMLElement>('.media-inner') ||
    containerElement.querySelector<HTMLElement>('.document-container') ||
    containerElement.querySelector<HTMLElement>('.media-viewer-aspecter') ||
    containerElement;

  if (window.getComputedStyle(mediaContainer).position === 'static') {
    mediaContainer.style.position = 'relative';
  }

  const btn = document.createElement('button');
  btn.className = 'tele-down-btn';
  btn.dataset.videoId = videoId;
  btn.dataset.videoUrl = videoUrl;
  btn.innerHTML = ICON_DOWNLOAD;
  btn.title = '동영상 다운로드';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.classList.contains('downloading') || btn.classList.contains('completed')) return;
    downloadHandler?.(videoUrl, videoId);
  });

  mediaContainer.appendChild(btn);
}

export function injectDownloadButtons(videos: DetectedVideo[]): void {
  videos.forEach(injectDownloadButton);
}

export function updateButtonProgress(videoId: string, progress: number): void {
  const btn = document.querySelector<HTMLElement>(`.tele-down-btn[data-video-id="${videoId}"]`);
  if (!btn) return;
  btn.classList.add('downloading');
  btn.innerHTML = createProgressRing(progress);
  btn.title = `다운로드 중: ${Math.round(progress)}%`;
}

export function updateButtonCompleted(videoId: string): void {
  const btn = document.querySelector<HTMLElement>(`.tele-down-btn[data-video-id="${videoId}"]`);
  if (!btn) return;
  btn.classList.remove('downloading');
  btn.classList.add('completed');
  btn.innerHTML = ICON_CHECK;
  btn.title = '다운로드 완료';
  setTimeout(() => {
    btn.classList.remove('completed');
    btn.innerHTML = ICON_DOWNLOAD;
    btn.title = '동영상 다운로드';
  }, 5000);
}

export function updateButtonError(videoId: string): void {
  const btn = document.querySelector<HTMLElement>(`.tele-down-btn[data-video-id="${videoId}"]`);
  if (!btn) return;
  btn.classList.remove('downloading');
  btn.classList.add('error');
  btn.innerHTML = ICON_ERROR;
  btn.title = '다운로드 실패 (클릭하여 재시도)';
  setTimeout(() => {
    btn.classList.remove('error');
    btn.innerHTML = ICON_DOWNLOAD;
    btn.title = '동영상 다운로드';
  }, 3000);
}

// ============================================================
// Floating Control Panel
// ============================================================

export interface PanelState {
  totalDetected: number;
  pending: number;
  downloading: number;
  completed: number;
  errored: number;
  autoDownload: boolean;
  downloadFolder: string;
  scanning?: boolean;
  scanProgress?: number; // 0-100
}

type StartDownloadCallback = () => void;
type AutoDownloadToggleCallback = (enabled: boolean) => void;
type StopScanCallback = () => void;
type ClearCallback = () => void;

let panel: HTMLElement | null = null;
let onStartDownload: StartDownloadCallback | null = null;
let onAutoDownloadToggle: AutoDownloadToggleCallback | null = null;
let onStopScan: StopScanCallback | null = null;
let onClear: ClearCallback | null = null;

export function setControlPanelCallbacks(
  onStart: StartDownloadCallback,
  onToggle: AutoDownloadToggleCallback,
  onStop?: StopScanCallback,
  onClearHistory?: ClearCallback,
): void {
  onStartDownload = onStart;
  onAutoDownloadToggle = onToggle;
  onStopScan = onStop ?? null;
  onClear = onClearHistory ?? null;
}

export function showControlPanel(state: PanelState): void {
  injectStyles();

  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'tele-down-panel';
    document.body.appendChild(panel);
  }

  const pendingCount = state.pending;
  const isScanning = state.scanning ?? false;
  const scanPct = state.scanProgress ?? 0;
  const startDisabled = !isScanning && pendingCount === 0 && state.downloading === 0;

  // Button text logic
  let btnHtml: string;
  if (isScanning) {
    btnHtml = `<span class="tdp-spinner"></span> 스캔 중... (${state.totalDetected}개 감지)`;
  } else if (pendingCount > 0) {
    btnHtml = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 스캔 + 다운로드 (${pendingCount}개)`;
  } else if (state.downloading > 0) {
    btnHtml = '다운로드 중...';
  } else {
    btnHtml = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> 스캔 + 다운로드`;
  }

  panel.innerHTML = `
    <div class="tdp-header">
      <span class="tdp-title">⬇ TeleDown</span>
      <button class="tdp-close" id="tdp-close" title="패널 닫기">×</button>
    </div>
    <div class="tdp-body">
      <div class="tdp-stat">
        <span class="tdp-stat-label">감지된 동영상</span>
        <span class="tdp-stat-value highlight">${state.totalDetected}개</span>
      </div>
      ${isScanning ? `<div class="tdp-scan-bar"><div class="tdp-scan-bar-fill" style="width:${scanPct}%"></div></div>` : ''}
      <div class="tdp-progress-row">
        <span>대기 <b>${state.pending}</b></span>
        <span class="cnt-downloading">다운로드 중 <b>${state.downloading}</b></span>
        <span class="cnt-done">완료 <b>${state.completed}</b></span>
        ${state.errored > 0 ? `<span class="cnt-error">오류 <b>${state.errored}</b></span>` : ''}
      </div>
      <div class="tdp-toggle-row">
        <span class="tdp-toggle-label">자동 다운로드</span>
        <label class="tdp-toggle">
          <input type="checkbox" id="tdp-auto-toggle" ${state.autoDownload ? 'checked' : ''}>
          <span class="tdp-toggle-slider"></span>
        </label>
      </div>
      <div class="tdp-folder-row">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="#6c6c80">
          <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
        </svg>
        <span>Downloads/<b>${state.downloadFolder}</b>/</span>
      </div>
      <button class="tdp-btn-start ${isScanning ? 'scanning' : ''}" id="tdp-start-btn" ${startDisabled || isScanning ? 'disabled' : ''}>
        ${btnHtml}
      </button>
      ${isScanning ? '<button class="tdp-btn-stop" id="tdp-stop-btn">스캔 중지</button>' : ''}
      ${!isScanning && state.totalDetected > 0 ? '<button class="tdp-btn-clear" id="tdp-clear-btn">기록 초기화</button>' : ''}
    </div>
  `;

  panel.classList.remove('hidden');

  // Event listeners
  panel.querySelector('#tdp-close')?.addEventListener('click', () => {
    panel?.classList.add('hidden');
  });

  panel.querySelector('#tdp-start-btn')?.addEventListener('click', () => {
    if (!startDisabled && !isScanning) onStartDownload?.();
  });

  panel.querySelector('#tdp-stop-btn')?.addEventListener('click', () => {
    onStopScan?.();
  });

  panel.querySelector('#tdp-auto-toggle')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    onAutoDownloadToggle?.(checked);
  });

  panel.querySelector('#tdp-clear-btn')?.addEventListener('click', () => {
    onClear?.();
  });
}

export function updateControlPanel(state: PanelState): void {
  if (!panel || panel.classList.contains('hidden')) return;
  showControlPanel(state);
}

export function hideControlPanel(): void {
  panel?.classList.add('hidden');
}

export function isPanelVisible(): boolean {
  return !!panel && !panel.classList.contains('hidden');
}
