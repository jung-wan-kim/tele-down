/**
 * TeleDown - Injected Download Script (runs in PAGE context)
 *
 * Injected via <script> tag by the content script.
 * Has access to page's fetch / cookies (for authenticated Telegram requests).
 *
 * Features:
 * - Range-based chunk download with retry
 * - Blob URL fallback (sequential)
 * - Download to configured subfolder via chrome.downloads API
 * - Listens for settings from content script
 */

// ============================================================
// Settings (received from content script via custom event)
// ============================================================

interface InjectSettings {
  downloadFolder: string;
  parallelChunks: number;
}

let currentSettings: InjectSettings = {
  downloadFolder: 'TeleDown',
  parallelChunks: 2,
};

// Use window.postMessage (NOT CustomEvent) — CustomEvent.detail is null across Chrome world boundary
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.type !== 'tele_down_settings') return;
  const { downloadFolder, parallelChunks } = e.data;
  if (downloadFolder !== undefined) currentSettings.downloadFolder = downloadFolder;
  if (parallelChunks !== undefined) currentSettings.parallelChunks = parallelChunks;
  console.log('[TeleDown] Settings updated:', currentSettings);
});

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

function resolveVideoUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
    return url;
  }
  try {
    return new URL(url, window.location.href).href;
  } catch {
    const base = window.location.origin + window.location.pathname;
    const prefix = url.startsWith('/') ? '' : '/';
    return `${base.replace(/\/$/, '')}${prefix}${url}`;
  }
}

// ============================================================
// File Name
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
  } catch { /* fallback */ }
  if (videoId) return `${videoId}.${extension}`;
  return `${Math.random().toString(36).substring(2, 10)}.${extension}`;
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
// Retry helper
// ============================================================

const MAX_RETRIES = 5;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || response.status === 206) {
        return response;
      }
      // Server error → retry
      if (response.status >= 500 || response.status === 408) {
        logger.info(`${label}: HTTP ${response.status}, retry ${attempt + 1}/${MAX_RETRIES}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(`${label}: HTTP ${response.status}`);
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = 1000 * (attempt + 1);
        logger.info(`${label}: Network error, retry in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error(`${label}: All ${MAX_RETRIES} retries failed`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    const response = await fetchWithRetry(
      url,
      { method: 'GET', headers: { Range: `bytes=${offset}-` } },
      `Blob seg@${offset}`,
    );

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

    dispatchProgress(videoId, (offset / totalSize) * 100, page, downloadId);
    blobs.push(await response.blob());

    if (offset < totalSize) await fetchNext();
  };

  await fetchNext();

  const finalBlob = new Blob(blobs, { type: 'video/mp4' });
  triggerDownload(finalBlob, baseName);
}

// ============================================================
// Segmented download (primary) — user-controlled chunk count
// ============================================================

const MIN_CHUNK_SIZE = 64 * 1024; // 64KB minimum per chunk

async function downloadSegmented(
  url: string,
  videoId: string,
  page?: string,
  downloadId?: string,
): Promise<void> {
  // Probe: minimal range request to get total file size
  const probeResp = await fetchWithRetry(url, { headers: { Range: 'bytes=0-0' } }, 'Probe');
  const rangeHeader = probeResp.headers.get('Content-Range') || '';
  const totalMatch = rangeHeader.match(/\/(\d+)$/);
  if (!totalMatch) throw new Error('Cannot determine content size from Content-Range');

  const contentSize = parseInt(totalMatch[1], 10);
  const contentType = probeResp.headers.get('Content-Type') || 'application/octet-stream';
  if (!contentSize) throw new Error('Content size is 0');

  const ext = contentType.split('/')[1] || 'mp4';
  const fileName = extractFileName(url, videoId, ext);

  // User-controlled chunk count (capped by minimum chunk size)
  const desired = Math.max(1, currentSettings.parallelChunks || 2);
  const numChunks = Math.min(desired, Math.ceil(contentSize / MIN_CHUNK_SIZE));
  const chunkSize = Math.ceil(contentSize / numChunks);

  logger.info(
    `Download: ${numChunks} chunks (requested ${desired}), ${formatBytes(contentSize)}, chunkSize=${formatBytes(chunkSize)}`,
    fileName,
  );

  // Create all chunk ranges
  const chunks: Array<{ start: number; end: number; idx: number }> = [];
  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize - 1, contentSize - 1);
    chunks.push({ start, end, idx: i });
  }

  // Fetch ALL chunks in parallel
  const buffers: ArrayBuffer[] = new Array(numChunks);
  let completedChunks = 0;

  const promises = chunks.map(({ start, end, idx }) =>
    fetchWithRetry(
      url,
      { headers: { Range: `bytes=${start}-${end}` } },
      `Chunk ${idx + 1}/${numChunks}`,
    ).then(async (resp) => {
      buffers[idx] = await resp.arrayBuffer();
      completedChunks++;
      dispatchProgress(videoId, (completedChunks / numChunks) * 100, page, downloadId);
    }),
  );

  await Promise.all(promises);

  const finalBlob = new Blob(buffers, { type: contentType });
  dispatchProgress(videoId, 100, page, downloadId);
  triggerDownload(finalBlob, fileName);
}

// ============================================================
// Download trigger
// ============================================================

function triggerDownload(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const folder = currentSettings.downloadFolder || 'TeleDown';

  // Use window.postMessage (NOT CustomEvent) for page → content script communication
  // CustomEvent.detail may be null across Chrome's world isolation boundary
  window.postMessage({
    type: 'tele_down_save',
    blobUrl,
    fileName,
    folder,
  }, '*');

  logger.info(`Download dispatched: ${folder}/${fileName} (${formatBytes(blob.size)})`);

  // Keep blob URL alive for 2 minutes to give chrome.downloads time
  setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
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

  if (activeDownloads.has(video_id)) {
    logger.info(`Skipping duplicate download: ${video_id}`);
    return;
  }
  activeDownloads.add(video_id);

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
