/**
 * TeleDown - Injected Download Script (runs in PAGE context)
 *
 * Injected via <script> tag by the content script.
 * Has access to page's fetch / cookies (for authenticated Telegram requests).
 *
 * Features:
 * - Range-based parallel chunk download
 * - Blob URL fallback (sequential)
 * - Download to configured subfolder (e.g. Downloads/TeleDown/)
 * - Listens for settings from content script
 */

// ============================================================
// Settings (received from content script via custom event)
// ============================================================

interface InjectSettings {
  downloadFolder: string;  // subfolder inside Downloads
  parallelChunks: number;
}

let currentSettings: InjectSettings = {
  downloadFolder: 'TeleDown',
  parallelChunks: 4,
};

document.addEventListener('tele_down_settings', ((e: CustomEvent<InjectSettings>) => {
  currentSettings = { ...currentSettings, ...e.detail };
  console.log('[TeleDown] Settings updated:', currentSettings);
}) as EventListener);

// ============================================================
// Types
// ============================================================

interface VideoDownloadDetail {
  type: 'single' | 'batch';
  video_src: SingleVideoSource | SingleVideoSource[];
}

interface SingleVideoSource {
  video_url: string;
  video_id: string;
  page?: string;
  download_id?: string;
}

interface SegmentInfo {
  contentType: string;
  segmentCount: number;
  segmentSize: number;
  contentSize: number;
}

// ============================================================
// Logger
// ============================================================

const logger = {
  info: (msg: string, ctx?: string) =>
    console.log(`[TeleDown] ${ctx ? `[${ctx}] ` : ''}${msg}`),
  error: (msg: string | Error, ctx?: string) =>
    console.error(`[TeleDown] ${ctx ? `[${ctx}] ` : ''}${msg}`),
};

// ============================================================
// Active download tracking (prevent duplicates)
// ============================================================

const activeDownloads = new Set<string>();

// ============================================================
// URL Resolution
// ============================================================

/**
 * Resolve a relative Telegram stream/progressive URL to absolute.
 * Telegram Web uses relative URLs like "stream/{encoded}" which
 * are intercepted by its Service Worker under /k/ or /a/ path.
 * Using new URL() properly resolves relative to current page base.
 */
function resolveVideoUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
    return url;
  }
  try {
    // new URL resolves relative to current page: e.g.
    // "stream/..." + "https://web.telegram.org/k/#chat" → "https://web.telegram.org/k/stream/..."
    return new URL(url, window.location.href).href;
  } catch {
    // Fallback: manual concatenation with pathname
    const base = window.location.origin + window.location.pathname;
    const prefix = url.startsWith('/') ? '' : '/';
    return `${base.replace(/\/$/, '')}${prefix}${url}`;
  }
}

// ============================================================
// File Name & Folder
// ============================================================

function extractFileName(url: string, videoId: string, extension: string): string {
  try {
    if (url.includes('stream/')) {
      const encodedPart = url.substring(url.indexOf('stream/') + 7).split('?')[0];
      const parsed = JSON.parse(decodeURIComponent(encodedPart));
      if (parsed?.fileName) return parsed.fileName;
      if (parsed?.location?.id) return `${parsed.location.id}.${extension}`;
    }
    if (url.includes('progressive/')) {
      const docPart = url.split('document').slice(1).join('');
      if (docPart) return `${docPart}.${extension}`;
    }
  } catch {
    // Fallback
  }
  if (videoId) return `${videoId}.${extension}`;
  return `${Math.random().toString(36).substring(2, 10)}.${extension}`;
}

/**
 * Prefix the file name with the configured download folder.
 * Setting anchor.download = "TeleDown/video.mp4" makes the browser
 * create Downloads/TeleDown/ automatically.
 */
function withFolder(fileName: string): string {
  const folder = currentSettings.downloadFolder?.trim();
  if (!folder) return fileName;
  return `${folder}/${fileName}`;
}

// ============================================================
// Progress
// ============================================================

function dispatchProgress(videoId: string, progress: number, page?: string, downloadId?: string): void {
  if (!videoId) return;
  document.dispatchEvent(
    new CustomEvent(`${videoId}_video_download_progress`, {
      detail: { video_id: videoId, progress: progress.toFixed(0), page, download_id: downloadId },
    }),
  );
}

// ============================================================
// Blob URL (sequential) download — fallback
// ============================================================

const CONTENT_RANGE_REGEX = /^bytes (\d+)-(\d+)\/(\d+)$/;

async function downloadBlobUrl(
  url: string,
  videoId: string,
  page?: string,
  downloadId?: string,
): Promise<void> {
  const blobs: Blob[] = [];
  let offset = 0;
  let totalSize: number | null = null;
  let extension = 'mp4';
  let baseName = extractFileName(url, videoId, extension);

  const fetchNext = async (): Promise<void> => {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: `bytes=${offset}-` },
    });

    if (![200, 206].includes(response.status)) {
      throw new Error(`HTTP ${response.status}`);
    }

    const ct = response.headers.get('Content-Type')?.split(';')[0] || '';
    const ext = ct.split('/')[1];
    if (ext) {
      extension = ext;
      baseName = baseName.replace(/\.[^.]+$/, `.${ext}`);
    }

    const rangeHeader = response.headers.get('Content-Range') || '';
    const match = rangeHeader.match(CONTENT_RANGE_REGEX);
    if (!match) throw new Error('Invalid Content-Range header');

    const rangeStart = parseInt(match[1], 10);
    const rangeEnd = parseInt(match[2], 10);
    const total = parseInt(match[3], 10);

    if (rangeStart !== offset) throw new Error(`Gap: expected ${offset}, got ${rangeStart}`);
    if (totalSize !== null && total !== totalSize) throw new Error('Total size mismatch');

    offset = rangeEnd + 1;
    totalSize = total;

    const progress = (offset / totalSize) * 100;
    dispatchProgress(videoId, progress, page, downloadId);

    blobs.push(await response.blob());

    if (offset < totalSize) await fetchNext();
  };

  await fetchNext();

  const finalBlob = new Blob(blobs, { type: 'video/mp4' });
  triggerDownload(finalBlob, baseName);
}

// ============================================================
// Segmented parallel download (primary)
// ============================================================

async function probeSegmentInfo(url: string): Promise<SegmentInfo> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-' } });
  if (!response.ok) throw new Error(`Probe failed: HTTP ${response.status}`);

  const contentSize = parseInt(response.headers.get('Content-Range')?.split('/')[1] || '0', 10);
  const segmentSize = parseInt(response.headers.get('Content-Length') || '0', 10);
  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

  if (response.headers.get('Accept-Ranges') !== 'bytes') {
    throw new Error('Server does not support byte-range requests');
  }
  if (!contentSize || !segmentSize) throw new Error('Cannot determine content size');

  return {
    contentType,
    segmentCount: Math.ceil(contentSize / segmentSize),
    segmentSize,
    contentSize,
  };
}

class FetchRetryError extends Error {
  constructor(
    message: string,
    public readonly segmentIndex: number,
    public readonly range: string,
  ) {
    super(message);
    this.name = 'FetchRetryError';
  }
}

function createSegmentFetchers(
  url: string,
  info: SegmentInfo,
  videoId: string,
  page?: string,
  downloadId?: string,
): Array<() => Promise<ArrayBuffer>> {
  return Array.from({ length: info.segmentCount }, (_, index) => {
    const start = index * info.segmentSize;
    const end = Math.min(start + info.segmentSize - 1, info.contentSize - 1);

    return async (): Promise<ArrayBuffer> => {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });

      if (response.status === 408) {
        throw new FetchRetryError(`Timeout on segment ${index}`, index, `bytes=${start}-${end}`);
      }
      if (!response.ok && response.status !== 206) {
        throw new Error(`Segment ${index}: HTTP ${response.status}`);
      }

      const progress = (end / info.contentSize) * 100;
      dispatchProgress(videoId, progress, page, downloadId);

      return response.arrayBuffer();
    };
  });
}

async function executeBatched(
  fetchers: Array<() => Promise<ArrayBuffer>>,
  batchSize: number,
): Promise<ArrayBuffer[]> {
  const results: ArrayBuffer[] = [];
  let offset = 0;

  while (offset < fetchers.length) {
    const batch = fetchers.slice(offset, offset + batchSize).map((fn) => fn());
    try {
      const batchResults = await Promise.all(batch);
      results.push(...batchResults);
      offset += batchSize;

      // Delay between batches to avoid overwhelming Telegram's Service Worker
      if (offset < fetchers.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      if (err instanceof FetchRetryError) {
        offset = err.segmentIndex;
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }

  return results;
}

async function downloadSegmented(
  url: string,
  videoId: string,
  page?: string,
  downloadId?: string,
): Promise<void> {
  const info = await probeSegmentInfo(url);
  const ext = info.contentType.split('/')[1] || 'mp4';
  const fileName = extractFileName(url, videoId, ext);

  logger.info(
    `Segmented download: ${info.segmentCount} segments, ${formatBytes(info.contentSize)}`,
    fileName,
  );

  const fetchers = createSegmentFetchers(url, info, videoId, page, downloadId);
  const batchSize = currentSettings.parallelChunks || 4;
  const segments = await executeBatched(fetchers, batchSize);

  const finalBlob = new Blob(segments, { type: info.contentType });
  dispatchProgress(videoId, 100, page, downloadId);
  triggerDownload(finalBlob, fileName);
}

// ============================================================
// Download trigger
// ============================================================

function triggerDownload(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);

  // Dispatch to content script → background → chrome.downloads.download()
  // This properly saves to the configured subfolder (e.g. Downloads/TeleDown/)
  document.dispatchEvent(
    new CustomEvent('tele_down_save', {
      detail: {
        blobUrl,
        fileName,
        folder: currentSettings.downloadFolder || 'TeleDown',
      },
    }),
  );

  logger.info(`Download dispatched: ${currentSettings.downloadFolder}/${fileName} (${formatBytes(blob.size)})`);

  // Revoke blob URL after a delay (give chrome.downloads time to start)
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

// ============================================================
// Utilities
// ============================================================

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ============================================================
// Main entry
// ============================================================

async function handleSingleDownload(src: SingleVideoSource): Promise<void> {
  const { video_url, video_id, page, download_id } = src;
  if (!video_url) return;

  // Prevent duplicate downloads for the same video
  if (activeDownloads.has(video_id)) {
    logger.info(`Skipping duplicate download: ${video_id}`);
    return;
  }
  activeDownloads.add(video_id);

  // Resolve relative URLs to absolute
  const resolvedUrl = resolveVideoUrl(video_url);

  try {
    if (resolvedUrl.startsWith('blob:')) {
      await downloadBlobUrl(resolvedUrl, video_id, page, download_id);
    } else {
      await downloadSegmented(resolvedUrl, video_id, page, download_id);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(msg, video_id);
    document.dispatchEvent(
      new CustomEvent(`${video_id}_video_download_error`, {
        detail: { video_id, error: msg, download_id },
      }),
    );
  } finally {
    activeDownloads.delete(video_id);
  }
}

document.addEventListener('video_download', ((event: CustomEvent<VideoDownloadDetail>) => {
  const { type, video_src } = event.detail;

  if (type === 'single') {
    handleSingleDownload(video_src as SingleVideoSource);
  } else if (type === 'batch') {
    const sources = video_src as SingleVideoSource[];
    sources.reduce(
      (chain, src) => chain.then(() => handleSingleDownload(src)),
      Promise.resolve(),
    );
  }
}) as EventListener);

logger.info('Downloader ready (folder: ' + currentSettings.downloadFolder + ')');
