/**
 * TeleDown - Background Service Worker
 *
 * Handles:
 * - Message routing between popup and content scripts
 * - Download state management via chrome.storage
 * - Extension settings management
 */

import type { DownloadProgress, ExtensionSettings, BackgroundMessage } from '../types/messages';
import { DEFAULT_SETTINGS } from '../types/messages';

// ============================================================
// Download State
// ============================================================

const activeDownloads = new Map<string, DownloadProgress>();

async function saveDownloadsToStorage(): Promise<void> {
  await chrome.storage.local.set({ downloads: Object.fromEntries(activeDownloads) });
}

async function loadDownloadsFromStorage(): Promise<void> {
  const result = await chrome.storage.local.get('downloads');
  if (result.downloads) {
    const entries = Object.entries(result.downloads) as [string, DownloadProgress][];
    entries.forEach(([key, value]) => activeDownloads.set(key, value));
  }
}

// ============================================================
// Settings
// ============================================================

async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get('settings');
  return (result.settings as ExtensionSettings) || { ...DEFAULT_SETTINGS };
}

async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.sync.set({ settings });
}

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener(
  (message: BackgroundMessage, _sender, sendResponse) => {
    handleMessage(message, sendResponse);
    return true;
  },
);

async function handleMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    switch (message.action) {
      case 'getDownloads': {
        sendResponse({ success: true, data: Object.fromEntries(activeDownloads) });
        break;
      }

      case 'downloadStarted': {
        activeDownloads.set(message.data.downloadId, message.data);
        await saveDownloadsToStorage();
        notifyPopup('downloadUpdated', message.data);
        sendResponse({ success: true });
        break;
      }

      case 'downloadProgress': {
        activeDownloads.set(message.data.downloadId, message.data);
        notifyPopup('downloadUpdated', message.data);
        sendResponse({ success: true });
        break;
      }

      case 'downloadCompleted': {
        const data = { ...message.data, status: 'completed' as const, progress: 100 };
        activeDownloads.set(data.downloadId, data);
        await saveDownloadsToStorage();
        notifyPopup('downloadUpdated', data);

        // Clean up after 60s
        setTimeout(() => {
          activeDownloads.delete(data.downloadId);
          saveDownloadsToStorage();
          notifyPopup('downloadRemoved', { downloadId: data.downloadId });
        }, 60000);

        sendResponse({ success: true });
        break;
      }

      case 'downloadError': {
        const data = { ...message.data, status: 'error' as const };
        activeDownloads.set(data.downloadId, data);
        await saveDownloadsToStorage();
        notifyPopup('downloadUpdated', data);
        sendResponse({ success: true });
        break;
      }

      case 'getSettings': {
        const settings = await getSettings();
        sendResponse({ success: true, data: settings });
        break;
      }

      case 'saveSettings': {
        await saveSettings(message.data);
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  } catch (error) {
    console.error('[TeleDown BG] Error:', error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================================
// Notify Popup
// ============================================================

function notifyPopup(type: string, data: unknown): void {
  chrome.runtime.sendMessage({ type, data }).catch(() => {});
}

// ============================================================
// Init
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    saveSettings(DEFAULT_SETTINGS);
    console.log('[TeleDown] Installed with default settings');
  }
});

loadDownloadsFromStorage();
console.log('[TeleDown] Background service worker started');
