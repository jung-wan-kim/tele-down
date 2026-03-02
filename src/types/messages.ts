/** Message types for communication between extension components */

/** Video source information */
export interface VideoSource {
  videoUrl: string;
  videoId: string;
  fileName?: string;
  page?: string;
  downloadId?: string;
}

/** Download status */
export type VideoStatus = 'pending' | 'downloading' | 'merging' | 'completed' | 'error';

/** Download progress update */
export interface DownloadProgress {
  videoId: string;
  downloadId: string;
  progress: number; // 0-100
  status: VideoStatus;
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
  | { action: 'saveSettings'; data: ExtensionSettings }
  | { action: 'saveToDisk'; data: { blobUrl: string; fileName: string; folder: string } };

/** Extension settings */
export interface ExtensionSettings {
  /** Number of concurrent segment downloads per file */
  parallelChunks: number;
  /** Number of concurrent video file downloads */
  parallelDownloads: number;
  /** Max number of videos in the download queue */
  downloadQueue: number;
  autoRetry: boolean;
  maxRetries: number;
  /** Subfolder name inside Downloads directory */
  downloadFolder: string;
  /** Automatically download detected videos without clicking Start */
  autoDownload: boolean;
}

/** Default settings */
export const DEFAULT_SETTINGS: ExtensionSettings = {
  parallelChunks: 10,
  parallelDownloads: 3,
  downloadQueue: 500,
  autoRetry: true,
  maxRetries: 3,
  downloadFolder: 'TeleDown',
  autoDownload: false,
};
