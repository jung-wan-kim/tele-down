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
// Download State Management
// ============================================================

/** In-memory download state (also persisted to chrome.storage) */
const activeDownloads = new Map<string, DownloadProgress>();

async function saveDownloadsToStorage(): Promise<void> {
  const data = Object.fromEntries(activeDownloads);
  await chrome.storage.local.set({ downloads: data });
}

async function loadDownloadsFromStorage(): Promise<void> {
  const result = await chrome.storage.local.get('downloads');
  if (result.downloads) {
    const entries = Object.entries(result.downloads) as [string, DownloadProgress][];
    entries.forEach(([key, value]) => activeDownloads.set(key, value));
  }
}

// ============================================================
// Settings Management
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
    return true; // Keep the message channel open for async response
  },
);

async function handleMessage(
  message: BackgroundMessage,
  sendResponse: (response: unknown) => void,
): Promise<void> {
  try {
    switch (message.action) {
      case 'getDownloads': {
        const downloads = Object.fromEntries(activeDownloads);
        sendResponse({ success: true, data: downloads });
        break;
      }

      case 'downloadStarted': {
        const { data } = message;
        activeDownloads.set(data.downloadId, data);
        await saveDownloadsToStorage();
        // Notify popup of change
        notifyPopup('downloadUpdated', data);
        sendResponse({ success: true });
        break;
      }

      case 'downloadProgress': {
        const { data } = message;
        activeDownloads.set(data.downloadId, data);
        // Don't persist every progress update (too frequent)
        notifyPopup('downloadUpdated', data);
        sendResponse({ success: true });
        break;
      }

      case 'downloadCompleted': {
        const { data } = message;
        data.status = 'completed';
        data.progress = 100;
        activeDownloads.set(data.downloadId, data);
        await saveDownloadsToStorage();
        notifyPopup('downloadUpdated', data);

        // Clean up completed downloads after 60 seconds
        setTimeout(() => {
          activeDownloads.delete(data.downloadId);
          saveDownloadsToStorage();
          notifyPopup('downloadRemoved', { downloadId: data.downloadId });
        }, 60000);

        sendResponse({ success: true });
        break;
      }

      case 'downloadError': {
        const { data } = message;
        data.status = 'error';
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
    console.error('[TeleDown BG] Error handling message:', error);
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
  chrome.runtime.sendMessage({ type, data }).catch(() => {
    // Popup not open, ignore
  });
}

// ============================================================
// Initialization
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[TeleDown] Extension installed');
    // Set default settings
    saveSettings(DEFAULT_SETTINGS);
  }
});

// Load persisted downloads on startup
loadDownloadsFromStorage();

console.log('[TeleDown] Background service worker started');
