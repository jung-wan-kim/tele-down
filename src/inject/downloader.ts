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
  downloadQueue: number;
}

let currentSettings: InjectSettings = {
  downloadFolder: 'TeleDown',
  parallelChunks: 3,
  downloadQueue: 50,
};

// Use window.postMessage (NOT CustomEvent) — CustomEvent.detail is null across Chrome world boundary
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.type !== 'tele_down_settings') return;
  const { downloadFolder, parallelChunks } = e.data;
  if (downloadFolder !== undefined) currentSettings.downloadFolder = downloadFolder;
  if (parallelChunks !== undefined) currentSettings.parallelChunks = parallelChunks;
  if (e.data.downloadQueue !== undefined) currentSettings.downloadQueue = e.data.downloadQueue;
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
  chat_name?: string;
  timestamp?: string;
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
/** Track completed downloads to prevent re-downloading same video */
const completedDownloads = new Set<string>();

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

/**
 * Build filename: [채팅방이름] 타임스탬프_파일ID.ext
 * e.g. "[개발채널] 20240301_1430_6138491001745972629.mp4"
 */
function buildFileName(
  url: string,
  videoId: string,
  extension: string,
  chatName?: string,
  timestamp?: string,
): string {
  // Extract a short file ID from the stream URL or videoId
  let fileId = videoId;
  try {
    if (url.includes('stream/')) {
      const encodedPart = url.substring(url.indexOf('stream/') + 7).split('?')[0];
      const parsed = JSON.parse(decodeURIComponent(encodedPart));
      if (parsed?.location?.id) fileId = String(parsed.location.id);
      // If Telegram provides a real filename, use it as-is with prefix
      if (parsed?.fileName) {
        const originalName = parsed.fileName;
        const prefix = buildPrefix(chatName, timestamp);
        return prefix ? `${prefix} ${originalName}` : originalName;
      }
    }
  } catch { /* fallback */ }

  const prefix = buildPrefix(chatName, timestamp);
  const baseName = `${fileId}.${extension}`;
  return prefix ? `${prefix} ${baseName}` : baseName;
}

function buildPrefix(chatName?: string, timestamp?: string): string {
  const parts: string[] = [];
  if (chatName) parts.push(`[${chatName}]`);
  if (timestamp) parts.push(timestamp);
  return parts.join(' ');
}

// ============================================================
// Progress
// ============================================================

function dispatchProgress(videoId: string, progress: number, page?: string, downloadId?: string): void {
  if (!videoId) return;
  // Use postMessage (NOT CustomEvent) — CustomEvent.detail is null across Chrome's
  // isolated world boundary (page context → content script)
  window.postMessage({
    type: 'tele_down_progress',
    video_id: videoId,
    progress: progress.toFixed(0),
    page,
    download_id: downloadId,
  }, '*');
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
      // Retryable errors: server errors, timeout, and 400 (LIMIT_INVALID from MTProto)
      if (response.status >= 500 || response.status === 408 || response.status === 400) {
        const delay = response.status === 400 ? 2000 * (attempt + 1) : 1000 * (attempt + 1);
        logger.info(`${label}: HTTP ${response.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
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
  chatName?: string,
  timestamp?: string,
): Promise<void> {
  const blobs: Blob[] = [];
  let offset = 0;
  let totalSize: number | null = null;
  let extension = 'mp4';
  let baseName = buildFileName(url, videoId, extension, chatName, timestamp);

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
// Segmented download (primary)
//
// Telegram's MTProto API requires Range sizes to be valid "limits":
//   - Must be a multiple of 4096 (4KB)
//   - Maximum 1MB (1048576)
//
// `downloadQueue`  → target number of segments (queue size, e.g. 500)
// `parallelChunks` → how many segments download SIMULTANEOUSLY (e.g. 10)
// ============================================================

const CHUNK_ALIGN = 4096; // MTProto minimum alignment
const MAX_CHUNK = 1048576; // MTProto maximum (1MB)
const MIN_CHUNK = 524288; // 512KB — sweet spot to reduce segment count

/** Calculate MTProto-compatible chunk size for target segment count */
function alignChunkSize(totalSize: number, targetSegments: number): number {
  let size = Math.floor(totalSize / Math.max(1, targetSegments));
  // Align down to 4096 boundary
  size = Math.floor(size / CHUNK_ALIGN) * CHUNK_ALIGN;
  // Clamp: min 512KB, max 1MB — fewer segments = fewer MTProto calls
  return Math.max(MIN_CHUNK, Math.min(size, MAX_CHUNK));
}

async function downloadSegmented(
  url: string,
  videoId: string,
  page?: string,
  downloadId?: string,
  chatName?: string,
  timestamp?: string,
): Promise<void> {
  // Probe: request 1 byte to learn total file size + content type
  const probeResp = await fetchWithRetry(url, { headers: { Range: 'bytes=0-0' } }, 'Probe');

  const contentSize = parseInt(probeResp.headers.get('Content-Range')?.split('/')[1] || '0', 10);
  const contentType = probeResp.headers.get('Content-Type') || 'application/octet-stream';

  if (!contentSize) throw new Error('Cannot determine content size');

  const targetQueue = Math.max(1, Math.min(currentSettings.downloadQueue || 50, 200));
  const segmentSize = alignChunkSize(contentSize, targetQueue);
  const numSegments = Math.ceil(contentSize / segmentSize);
  // Hard cap concurrent requests to avoid LIMIT_INVALID flood
  const maxConcurrent = Math.max(1, Math.min(currentSettings.parallelChunks || 3, 5));

  const ext = contentType.split('/')[1] || 'mp4';
  const fileName = buildFileName(url, videoId, ext, chatName, timestamp);

  logger.info(
    `Download: ${numSegments} segs queued, ${formatBytes(contentSize)}, segSize=${formatBytes(segmentSize)}, concurrent=${maxConcurrent}`,
    fileName,
  );

  // Create all segment ranges (full queue)
  const segments: Array<{ start: number; end: number; idx: number }> = [];
  for (let i = 0; i < numSegments; i++) {
    const start = i * segmentSize;
    const end = Math.min(start + segmentSize - 1, contentSize - 1);
    segments.push({ start, end, idx: i });
  }

  // Download with concurrency control: process maxConcurrent at a time
  const buffers: ArrayBuffer[] = new Array(numSegments);
  let completedSegments = 0;

  for (let i = 0; i < segments.length; i += maxConcurrent) {
    const batch = segments.slice(i, i + maxConcurrent);

    await Promise.all(
      batch.map(({ start, end, idx }) =>
        fetchWithRetry(
          url,
          { headers: { Range: `bytes=${start}-${end}` } },
          `Seg ${idx + 1}/${numSegments}`,
        ).then(async (resp) => {
          buffers[idx] = await resp.arrayBuffer();
          completedSegments++;
          dispatchProgress(videoId, (completedSegments / numSegments) * 100, page, downloadId);
        }),
      ),
    );

    // Throttle between batches to avoid Telegram LIMIT_INVALID rate limiting
    if (i + maxConcurrent < segments.length) {
      await sleep(150);
    }
  }

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
  const { video_url, video_id, page, download_id, chat_name, timestamp } = src;
  if (!video_url) return;

  if (activeDownloads.has(video_id) || completedDownloads.has(video_id)) {
    logger.info(`Skipping duplicate download: ${video_id} (${completedDownloads.has(video_id) ? 'already completed' : 'in progress'})`);
    return;
  }
  activeDownloads.add(video_id);

  const resolvedUrl = resolveVideoUrl(video_url);

  try {
    if (resolvedUrl.startsWith('blob:')) {
      await downloadBlobUrl(resolvedUrl, video_id, page, download_id, chat_name, timestamp);
    } else {
      await downloadSegmented(resolvedUrl, video_id, page, download_id, chat_name, timestamp);
    }
    completedDownloads.add(video_id);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(msg, video_id);
    window.postMessage({
      type: 'tele_down_error',
      video_id,
      error: msg,
      download_id,
    }, '*');
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
