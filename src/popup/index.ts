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
const folderFullPath = $<HTMLSpanElement>('folderFullPath');

// Advanced settings
const parallelChunksInput = $<HTMLInputElement>('parallelChunks');
const parallelDownloadsInput = $<HTMLInputElement>('parallelDownloads');
const autoRetryInput = $<HTMLInputElement>('autoRetry');
const maxRetriesInput = $<HTMLInputElement>('maxRetries');
const btnSaveSettings = $<HTMLButtonElement>('btnSaveSettings');
const saveFeedback = $<HTMLDivElement>('saveFeedback');

// ============================================================
// State
// ============================================================

const downloads = new Map<string, DownloadProgress>();
let currentSettings: ExtensionSettings = { ...DEFAULT_SETTINGS };
let defaultDownloadPath = '';

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

/** Get the default download directory path via chrome.downloads API */
async function detectDownloadPath(): Promise<void> {
  try {
    // Use a temporary download to detect the default path (cancelled immediately)
    // Alternative: use platform info to build the path
    const platformInfo = await chrome.runtime.getPlatformInfo();
    const isWindows = platformInfo.os === 'win';
    const isMac = platformInfo.os === 'mac';

    if (isWindows) {
      // Windows: C:\Users\<username>\Downloads
      // We can't get the exact username, but chrome.downloads.download
      // returns the full path. Use a simpler approach with env hint.
      defaultDownloadPath = 'C:\\Users\\<사용자>\\Downloads';
    } else if (isMac) {
      defaultDownloadPath = '/Users/<사용자>/Downloads';
    } else {
      defaultDownloadPath = '~/Downloads';
    }

    // Try to get actual path using a dummy download trick
    try {
      const downloadId = await chrome.downloads.download({
        url: 'data:text/plain,test',
        filename: '.tele-down-path-detect.tmp',
        conflictAction: 'uniquify',
      });

      const items = await new Promise<chrome.downloads.DownloadItem[]>((resolve) => {
        chrome.downloads.search({ id: downloadId }, resolve);
      });

      if (items.length > 0 && items[0].filename) {
        // Extract the Downloads directory from the full path
        const fullPath = items[0].filename;
        const sep = fullPath.includes('\\') ? '\\' : '/';
        const parts = fullPath.split(sep);
        // Remove the filename to get the Downloads dir
        parts.pop();
        defaultDownloadPath = parts.join(sep);
      }

      // Cancel and remove the temp download
      chrome.downloads.cancel(downloadId);
      chrome.downloads.removeFile(downloadId);
      chrome.downloads.erase({ id: downloadId });
    } catch {
      // Permission or other error, use the guessed path
    }
  } catch {
    defaultDownloadPath = 'Downloads';
  }
}

function updateFolderPathDisplay(): void {
  const folder = downloadFolderInput.value.trim() || 'TeleDown';
  const sep = defaultDownloadPath.includes('\\') ? '\\' : '/';
  folderFullPath.textContent = `${defaultDownloadPath}${sep}${folder}${sep}`;
}

function applySettingsToUI(settings: ExtensionSettings): void {
  autoDownloadInput.checked = settings.autoDownload;
  downloadFolderInput.value = settings.downloadFolder;
  parallelChunksInput.value = String(settings.parallelChunks);
  parallelDownloadsInput.value = String(settings.parallelDownloads);
  autoRetryInput.checked = settings.autoRetry;
  maxRetriesInput.value = String(settings.maxRetries);
  updateFolderPathDisplay();
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

/** Read all current form values into currentSettings */
function readFormValues(): void {
  currentSettings.autoDownload = autoDownloadInput.checked;
  currentSettings.downloadFolder = downloadFolderInput.value.trim() || 'TeleDown';
  currentSettings.parallelChunks = parseInt(parallelChunksInput.value, 10) || 20;
  currentSettings.parallelDownloads = parseInt(parallelDownloadsInput.value, 10) || 3;
  currentSettings.autoRetry = autoRetryInput.checked;
  currentSettings.maxRetries = parseInt(maxRetriesInput.value, 10) || 3;
}

/** Save settings and broadcast to all Telegram Web tabs */
async function saveAndBroadcast(): Promise<void> {
  readFormValues();
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
}

function showSaveFeedback(): void {
  saveFeedback.classList.remove('hidden');
  setTimeout(() => saveFeedback.classList.add('hidden'), 1500);
}

function setupSettingsListeners(): void {
  // Auto-download & folder: save immediately on change (quick settings)
  autoDownloadInput.addEventListener('change', async () => {
    await saveAndBroadcast();
    showSaveFeedback();
  });

  downloadFolderInput.addEventListener('input', () => {
    updateFolderPathDisplay();
  });

  downloadFolderInput.addEventListener('change', async () => {
    await saveAndBroadcast();
    showSaveFeedback();
  });

  // Save button for advanced settings
  btnSaveSettings.addEventListener('click', async () => {
    await saveAndBroadcast();
    showSaveFeedback();
    btnSaveSettings.textContent = '저장 완료!';
    setTimeout(() => { btnSaveSettings.textContent = '설정 저장'; }, 1500);
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
  await Promise.all([updateStatus(), loadSettings(), loadDownloads(), detectDownloadPath()]);
  updateFolderPathDisplay();
  setupSettingsListeners();
  renderDownloads();
}

init();
