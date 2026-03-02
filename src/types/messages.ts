/** Message types for communication between extension components */

/** Video source information */
export interface VideoSource {
  videoUrl: string;
  videoId: string;
  fileName?: string;
  page?: string;
  downloadId?: string;
}

/** Download request from content script to inject script */
export interface DownloadRequest {
  type: 'single' | 'batch';
  videos: VideoSource[];
}

/** Download progress update */
export interface DownloadProgress {
  videoId: string;
  downloadId: string;
  progress: number; // 0-100
  status: 'pending' | 'downloading' | 'merging' | 'completed' | 'error';
  fileName?: string;
  error?: string;
}

/** Messages between content script and background */
export type BackgroundMessage =
  | { action: 'getDownloads' }
  | { action: 'downloadStarted'; data: DownloadProgress }
  | { action: 'downloadProgress'; data: DownloadProgress }
  | { action: 'downloadCompleted'; data: DownloadProgress }
  | { action: 'downloadError'; data: DownloadProgress }
  | { action: 'getSettings' }
  | { action: 'saveSettings'; data: ExtensionSettings };

/** Extension settings */
export interface ExtensionSettings {
  parallelChunks: number;    // Number of parallel chunk downloads (default: 20)
  parallelDownloads: number; // Number of parallel file downloads (default: 3)
  autoRetry: boolean;        // Auto-retry on failure (default: true)
  maxRetries: number;        // Max retry attempts (default: 3)
}

/** Default settings */
export const DEFAULT_SETTINGS: ExtensionSettings = {
  parallelChunks: 20,
  parallelDownloads: 3,
  autoRetry: true,
  maxRetries: 3,
};
