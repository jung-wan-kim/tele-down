/**
 * TeleDown - Popup Script
 *
 * Manages the extension popup UI:
 * - Displays active downloads with progress
 * - Settings management
 * - Connection status to Telegram Web
 */

import type { DownloadProgress, ExtensionSettings } from '../types/messages';
import { DEFAULT_SETTINGS } from '../types/messages';

// ============================================================
// DOM Elements
// ============================================================

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const statusBar = $<HTMLDivElement>('statusBar');
const statusText = statusBar.querySelector('.status-text') as HTMLSpanElement;
const downloadCount = $<HTMLSpanElement>('downloadCount');
const downloadList = $<HTMLDivElement>('downloadList');
const emptyState = $<HTMLDivElement>('emptyState');

// Settings inputs
const parallelChunksInput = $<HTMLInputElement>('parallelChunks');
const parallelDownloadsInput = $<HTMLInputElement>('parallelDownloads');
const autoRetryInput = $<HTMLInputElement>('autoRetry');
const maxRetriesInput = $<HTMLInputElement>('maxRetries');

// ============================================================
// State
// ============================================================

const downloads = new Map<string, DownloadProgress>();

// ============================================================
// Status Check
// ============================================================

async function checkTelegramTab(): Promise<boolean> {
  try {
    const tabs = await chrome.tabs.query({
      url: 'https://web.telegram.org/*',
      active: true,
      currentWindow: true,
    });
    return tabs.length > 0;
  } catch {
    return false;
  }
}

async function updateStatus(): Promise<void> {
  const isTelegramOpen = await checkTelegramTab();

  if (isTelegramOpen) {
    statusBar.classList.add('active');
    statusText.textContent = 'Connected to Telegram Web';
  } else {
    statusBar.classList.remove('active');
    statusText.textContent = 'Open Telegram Web to start';
  }
}

// ============================================================
// Download List Rendering
// ============================================================

function createDownloadItemHTML(dl: DownloadProgress): string {
  const statusClass = dl.status;
  const progressWidth = dl.status === 'error' ? 100 : dl.progress;
  const displayName = dl.fileName || dl.videoId || 'Unknown';

  let statusLabel = '';
  switch (dl.status) {
    case 'downloading':
      statusLabel = `${Math.round(dl.progress)}%`;
      break;
    case 'merging':
      statusLabel = 'Merging...';
      break;
    case 'completed':
      statusLabel = 'Done';
      break;
    case 'error':
      statusLabel = 'Error';
      break;
    default:
      statusLabel = 'Pending';
  }

  return `
    <div class="download-item" data-download-id="${dl.downloadId}">
      <div class="download-item-header">
        <span class="download-item-name" title="${displayName}">${displayName}</span>
        <span class="download-item-status ${statusClass}">${statusLabel}</span>
      </div>
      <div class="progress-bar">
        <div class="progress-bar-fill ${statusClass}" style="width: ${progressWidth}%"></div>
      </div>
      ${dl.error ? `<div class="download-item-meta"><span>${dl.error}</span></div>` : ''}
    </div>
  `;
}

function renderDownloads(): void {
  const activeCount = Array.from(downloads.values()).filter(
    (d) => d.status === 'downloading' || d.status === 'merging',
  ).length;

  downloadCount.textContent = String(downloads.size);
  downloadCount.classList.toggle('active', activeCount > 0);

  if (downloads.size === 0) {
    emptyState.style.display = 'flex';
    // Remove all download items but keep empty state
    const items = downloadList.querySelectorAll('.download-item');
    items.forEach((item) => item.remove());
    return;
  }

  emptyState.style.display = 'none';

  // Build the download list
  const sortedDownloads = Array.from(downloads.values()).sort((a, b) => {
    // Active downloads first, then completed, then errors
    const order: Record<string, number> = {
      downloading: 0,
      merging: 1,
      pending: 2,
      completed: 3,
      error: 4,
    };
    return (order[a.status] || 9) - (order[b.status] || 9);
  });

  const html = sortedDownloads.map(createDownloadItemHTML).join('');

  // Replace existing items
  const existingItems = downloadList.querySelectorAll('.download-item');
  existingItems.forEach((item) => item.remove());

  downloadList.insertAdjacentHTML('beforeend', html);
}

function updateDownload(data: DownloadProgress): void {
  downloads.set(data.downloadId, data);
  renderDownloads();
}

function removeDownload(downloadId: string): void {
  downloads.delete(downloadId);
  renderDownloads();
}

// ============================================================
// Settings Management
// ============================================================

async function loadSettings(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getSettings' });
    const settings: ExtensionSettings = response?.data || DEFAULT_SETTINGS;

    parallelChunksInput.value = String(settings.parallelChunks);
    parallelDownloadsInput.value = String(settings.parallelDownloads);
    autoRetryInput.checked = settings.autoRetry;
    maxRetriesInput.value = String(settings.maxRetries);
  } catch {
    // Use defaults
    parallelChunksInput.value = String(DEFAULT_SETTINGS.parallelChunks);
    parallelDownloadsInput.value = String(DEFAULT_SETTINGS.parallelDownloads);
    autoRetryInput.checked = DEFAULT_SETTINGS.autoRetry;
    maxRetriesInput.value = String(DEFAULT_SETTINGS.maxRetries);
  }
}

async function saveCurrentSettings(): Promise<void> {
  const settings: ExtensionSettings = {
    parallelChunks: parseInt(parallelChunksInput.value, 10) || DEFAULT_SETTINGS.parallelChunks,
    parallelDownloads: parseInt(parallelDownloadsInput.value, 10) || DEFAULT_SETTINGS.parallelDownloads,
    autoRetry: autoRetryInput.checked,
    maxRetries: parseInt(maxRetriesInput.value, 10) || DEFAULT_SETTINGS.maxRetries,
  };

  try {
    await chrome.runtime.sendMessage({ action: 'saveSettings', data: settings });
  } catch {
    console.error('[TeleDown] Failed to save settings');
  }
}

function setupSettingsListeners(): void {
  const inputs = [parallelChunksInput, parallelDownloadsInput, autoRetryInput, maxRetriesInput];
  inputs.forEach((input) => {
    input.addEventListener('change', saveCurrentSettings);
  });
}

// ============================================================
// Load Existing Downloads
// ============================================================

async function loadDownloads(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getDownloads' });
    if (response?.data) {
      const entries = Object.entries(response.data) as [string, DownloadProgress][];
      entries.forEach(([, dl]) => downloads.set(dl.downloadId, dl));
      renderDownloads();
    }
  } catch {
    // No active downloads
  }
}

// ============================================================
// Listen for Background Updates
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'downloadUpdated' && message.data) {
    updateDownload(message.data);
  } else if (message.type === 'downloadRemoved' && message.data?.downloadId) {
    removeDownload(message.data.downloadId);
  }
});

// ============================================================
// Initialization
// ============================================================

async function init(): Promise<void> {
  await Promise.all([
    updateStatus(),
    loadSettings(),
    loadDownloads(),
  ]);
  setupSettingsListeners();
  renderDownloads();
}

init();
