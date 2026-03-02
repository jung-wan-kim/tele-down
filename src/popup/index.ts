/**
 * TeleDown - Popup Script
 */

import type { DownloadProgress, ExtensionSettings } from '../types/messages';
import { DEFAULT_SETTINGS } from '../types/messages';

// ============================================================
// DOM
// ============================================================

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusBar = $<HTMLDivElement>('statusBar');
const statusText = statusBar.querySelector('.status-text') as HTMLSpanElement;
const downloadCount = $<HTMLSpanElement>('downloadCount');
const downloadList = $<HTMLDivElement>('downloadList');
const emptyState = $<HTMLDivElement>('emptyState');

// Quick settings
const autoDownloadInput = $<HTMLInputElement>('autoDownload');
const downloadFolderInput = $<HTMLInputElement>('downloadFolder');
const folderPreview = $<HTMLSpanElement>('folderPreview');

// Advanced settings
const parallelChunksInput = $<HTMLInputElement>('parallelChunks');
const parallelDownloadsInput = $<HTMLInputElement>('parallelDownloads');
const autoRetryInput = $<HTMLInputElement>('autoRetry');
const maxRetriesInput = $<HTMLInputElement>('maxRetries');

// ============================================================
// State
// ============================================================

const downloads = new Map<string, DownloadProgress>();
let currentSettings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

// ============================================================
// Status
// ============================================================

async function updateStatus(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({
      url: 'https://web.telegram.org/*',
      active: true,
      currentWindow: true,
    });
    if (tabs.length > 0) {
      statusBar.classList.add('active');
      statusText.textContent = 'Telegram Web 연결됨';
    } else {
      statusBar.classList.remove('active');
      statusText.textContent = 'Telegram Web을 열어주세요';
    }
  } catch {
    statusBar.classList.remove('active');
  }
}

// ============================================================
// Downloads
// ============================================================

function createDownloadItemHTML(dl: DownloadProgress): string {
  const displayName = dl.fileName || dl.videoId || 'Unknown';
  const progressWidth = dl.status === 'error' ? 100 : dl.progress;

  const statusLabels: Record<string, string> = {
    downloading: `${Math.round(dl.progress)}%`,
    merging: '병합 중...',
    completed: '완료',
    error: '오류',
    pending: '대기 중',
  };

  return `
    <div class="download-item" data-download-id="${dl.downloadId}">
      <div class="download-item-header">
        <span class="download-item-name" title="${displayName}">${displayName}</span>
        <span class="download-item-status ${dl.status}">${statusLabels[dl.status] || '대기 중'}</span>
      </div>
      <div class="progress-bar">
        <div class="progress-bar-fill ${dl.status}" style="width: ${progressWidth}%"></div>
      </div>
      ${dl.error ? `<div class="download-item-meta"><span>${dl.error}</span></div>` : ''}
    </div>`;
}

function renderDownloads(): void {
  const activeCount = Array.from(downloads.values()).filter(
    (d) => d.status === 'downloading' || d.status === 'merging',
  ).length;

  downloadCount.textContent = String(downloads.size);
  downloadCount.classList.toggle('active', activeCount > 0);

  const items = downloadList.querySelectorAll('.download-item');
  items.forEach((item) => item.remove());

  if (downloads.size === 0) {
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  const order: Record<string, number> = {
    downloading: 0, merging: 1, pending: 2, completed: 3, error: 4,
  };

  const sorted = Array.from(downloads.values()).sort(
    (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9),
  );

  downloadList.insertAdjacentHTML('beforeend', sorted.map(createDownloadItemHTML).join(''));
}

function updateDownload(data: DownloadProgress): void {
  downloads.set(data.downloadId, data);
  renderDownloads();
}

function removeDownload(downloadId: string): void {
  downloads.delete(downloadId);
  renderDownloads();
}

async function loadDownloads(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getDownloads' });
    if (response?.data) {
      const entries = Object.entries(response.data) as [string, DownloadProgress][];
      entries.forEach(([, dl]) => downloads.set(dl.downloadId, dl));
      renderDownloads();
    }
  } catch { /* No active downloads */ }
}

// ============================================================
// Settings
// ============================================================

function applySettingsToUI(settings: ExtensionSettings): void {
  autoDownloadInput.checked = settings.autoDownload;
  downloadFolderInput.value = settings.downloadFolder;
  folderPreview.textContent = settings.downloadFolder || 'TeleDown';
  parallelChunksInput.value = String(settings.parallelChunks);
  parallelDownloadsInput.value = String(settings.parallelDownloads);
  autoRetryInput.checked = settings.autoRetry;
  maxRetriesInput.value = String(settings.maxRetries);
}

async function loadSettings(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    if (response?.data) {
      currentSettings = { ...DEFAULT_SETTINGS, ...response.data };
    }
  } catch { /* Use defaults */ }
  applySettingsToUI(currentSettings);
}

/** Debounced save + broadcast to content script */
function scheduleSettingsSave(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'saveSettings', data: currentSettings });

      // Broadcast to all Telegram Web tabs
      const tabs = await chrome.tabs.query({ url: 'https://web.telegram.org/*' });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'settingsUpdated',
            data: currentSettings,
          }).catch(() => {});
        }
      }
    } catch { /* Ignore */ }
  }, 500);
}

function setupSettingsListeners(): void {
  autoDownloadInput.addEventListener('change', () => {
    currentSettings.autoDownload = autoDownloadInput.checked;
    scheduleSettingsSave();
  });

  downloadFolderInput.addEventListener('input', () => {
    const val = downloadFolderInput.value.trim() || 'TeleDown';
    currentSettings.downloadFolder = val;
    folderPreview.textContent = val;
    scheduleSettingsSave();
  });

  parallelChunksInput.addEventListener('change', () => {
    currentSettings.parallelChunks = parseInt(parallelChunksInput.value, 10) || 20;
    scheduleSettingsSave();
  });

  parallelDownloadsInput.addEventListener('change', () => {
    currentSettings.parallelDownloads = parseInt(parallelDownloadsInput.value, 10) || 3;
    scheduleSettingsSave();
  });

  autoRetryInput.addEventListener('change', () => {
    currentSettings.autoRetry = autoRetryInput.checked;
    scheduleSettingsSave();
  });

  maxRetriesInput.addEventListener('change', () => {
    currentSettings.maxRetries = parseInt(maxRetriesInput.value, 10) || 3;
    scheduleSettingsSave();
  });
}

// ============================================================
// Background message listener
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'downloadUpdated' && message.data) {
    updateDownload(message.data);
  } else if (message.type === 'downloadRemoved' && message.data?.downloadId) {
    removeDownload(message.data.downloadId);
  }
});

// ============================================================
// Init
// ============================================================

async function init(): Promise<void> {
  await Promise.all([updateStatus(), loadSettings(), loadDownloads()]);
  setupSettingsListeners();
  renderDownloads();
}

init();
