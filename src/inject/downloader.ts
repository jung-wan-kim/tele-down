/**
 * TeleDown - Injected Download Script
 *
 * This script runs in the PAGE context (not the extension context).
 * It is injected via <script> tag by the content script.
 * It handles the actual video download using Range requests.
 */

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
  info: (msg: string, ctx?: string) => {
    console.log(`[TeleDown] ${ctx ? `[${ctx}] ` : ''}${msg}`);
  },
  error: (msg: string | Error, ctx?: string) => {
    console.error(`[TeleDown] ${ctx ? `[${ctx}] ` : ''}${msg}`);
  },
};

// ============================================================
// File Name Extraction
// ============================================================

/** Extract file name from a Telegram streaming URL */
function extractFileName(url: string, videoId: string, extension: string): string {
  try {
    // Pattern: .../stream/{encodedJSON}?...
    if (url.includes('stream/')) {
      const encodedPart = url.substring(url.indexOf('stream/') + 7).split('?')[0];
      const parsed = JSON.parse(decodeURIComponent(encodedPart));
      if (parsed?.fileName) return parsed.fileName;
      if (parsed?.location?.id) return `${parsed.location.id}.${extension}`;
    }

    // Pattern: .../progressive/...document{id}...
    if (url.includes('progressive/')) {
      const docPart = url.split('document').slice(1).join('');
      if (docPart) return `${docPart}.${extension}`;
    }
  } catch {
    // Fallback to random name
  }

  // Use videoId if available, otherwise generate random name
  if (videoId) return `${videoId}.${extension}`;
  return `${randomString()}.${extension}`;
}

function randomString(len = 8): string {
  return Math.random().toString(36).substring(2, 2 + len);
}

// ============================================================
// Progress Dispatcher
// ============================================================

function dispatchProgress(
  videoId: string,
  progress: number,
  page?: string,
  downloadId?: string,
): void {
  if (!videoId) return;

  const event = new CustomEvent(`${videoId}_video_download_progress`, {
    detail: {
      video_id: videoId,
      progress: progress.toFixed(0),
      page,
      download_id: downloadId,
    },
  });
  document.dispatchEvent(event);
}

// ============================================================
// Blob Download (fallback for blob: URLs)
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
  let fileName = extractFileName(url, videoId, extension);

  const fetchNext = async (): Promise<void> => {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: `bytes=${offset}-` },
    });

    if (![200, 206].includes(response.status)) {
      throw new Error(`Unexpected HTTP status: ${response.status}`);
    }

    // Update extension from Content-Type
    const contentType = response.headers.get('Content-Type')?.split(';')[0] || '';
    const ext = contentType.split('/')[1];
    if (ext) {
      extension = ext;
      fileName = fileName.replace(/\.[^.]+$/, `.${ext}`);
    }

    // Parse Content-Range
    const rangeHeader = response.headers.get('Content-Range') || '';
    const match = rangeHeader.match(CONTENT_RANGE_REGEX);
    if (!match) {
      throw new Error('Invalid Content-Range header');
    }

    const rangeStart = parseInt(match[1], 10);
    const rangeEnd = parseInt(match[2], 10);
    const total = parseInt(match[3], 10);

    // Validate continuity
    if (rangeStart !== offset) {
      throw new Error(`Gap detected: expected offset ${offset}, got ${rangeStart}`);
    }
    if (totalSize !== null && total !== totalSize) {
      throw new Error('Total size mismatch between responses');
    }

    offset = rangeEnd + 1;
    totalSize = total;

    const progress = (offset / totalSize) * 100;
    logger.info(`Progress: ${progress.toFixed(0)}%`, fileName);
    dispatchProgress(videoId, progress, page, downloadId);

    const blob = await response.blob();
    blobs.push(blob);

    if (offset < totalSize) {
      await fetchNext();
    }
  };

  await fetchNext();

  // Merge blobs and trigger download
  logger.info('Merging blobs...', fileName);
  const finalBlob = new Blob(blobs, { type: 'video/mp4' });
  triggerDownload(finalBlob, fileName);
}

// ============================================================
// Segmented Parallel Download (primary method)
// ============================================================

/** Probe the server to get segment info */
async function probeSegmentInfo(url: string): Promise<SegmentInfo> {
  const response = await fetch(url, {
    headers: { Range: 'bytes=0-' },
  });

  if (!response.ok) {
    throw new Error(`HTTP error during probe: ${response.status}`);
  }

  const contentSize = parseInt(
    response.headers.get('Content-Range')?.split('/')[1] || '0',
    10,
  );
  const segmentSize = parseInt(
    response.headers.get('Content-Length') || '0',
    10,
  );
  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
  const acceptRanges = response.headers.get('Accept-Ranges');

  if (acceptRanges !== 'bytes') {
    throw new Error('Server does not support byte-range requests');
  }

  if (contentSize === 0 || segmentSize === 0) {
    throw new Error('Unable to determine content/segment size');
  }

  return {
    contentType,
    segmentCount: Math.ceil(contentSize / segmentSize),
    segmentSize,
    contentSize,
  };
}

/** Create fetch functions for each segment */
function createSegmentFetchers(
  url: string,
  segmentInfo: SegmentInfo,
  videoId: string,
  page?: string,
  downloadId?: string,
): Array<() => Promise<ArrayBuffer>> {
  const { segmentSize, contentSize } = segmentInfo;

  return Array.from({ length: segmentInfo.segmentCount }, (_, index) => {
    const start = index * segmentSize;
    const end = Math.min(start + segmentSize - 1, contentSize - 1);

    return async (): Promise<ArrayBuffer> => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
      });

      if (response.status === 408) {
        throw new FetchRetryError(`Timeout on segment ${index}`, index, `bytes=${start}-${end}`);
      }

      if (!response.ok && response.status !== 206) {
        throw new Error(`Segment ${index} failed: HTTP ${response.status}`);
      }

      // Dispatch progress based on segment end position
      const progress = (end / contentSize) * 100;
      dispatchProgress(videoId, progress, page, downloadId);
      logger.info(`Segment ${index}/${segmentInfo.segmentCount}: ${progress.toFixed(1)}%`);

      return response.arrayBuffer();
    };
  });
}

/** Custom error for fetch retries */
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

/** Execute fetchers in parallel batches with retry support */
async function executeBatched(
  fetchers: Array<() => Promise<ArrayBuffer>>,
  batchSize: number,
  enableRetry: boolean,
): Promise<ArrayBuffer[]> {
  const results: ArrayBuffer[] = [];
  let offset = 0;

  while (offset < fetchers.length) {
    const batch = fetchers.slice(offset, offset + batchSize);
    const batchPromises = batch.map((fn) => fn());

    try {
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      offset += batchSize;
    } catch (error) {
      if (enableRetry && error instanceof FetchRetryError) {
        // Retry from the failed segment
        logger.info(`Retrying from segment ${error.segmentIndex}...`);
        offset = error.segmentIndex;
        await delay(1000);
      } else {
        throw error;
      }
    }
  }

  return results;
}

/** Parallel segmented download */
async function downloadSegmented(
  url: string,
  videoId: string,
  page?: string,
  downloadId?: string,
): Promise<void> {
  const segmentInfo = await probeSegmentInfo(url);

  const fetchers = createSegmentFetchers(url, segmentInfo, videoId, page, downloadId);

  const fileName = extractFileName(url, videoId, segmentInfo.contentType.split('/')[1] || 'mp4');

  logger.info(`Starting segmented download: ${segmentInfo.segmentCount} segments, ${formatBytes(segmentInfo.contentSize)}`, fileName);

  const segments = await executeBatched(fetchers, 20, true);

  logger.info('All segments downloaded. Merging...', fileName);
  const finalBlob = new Blob(segments, { type: segmentInfo.contentType });

  dispatchProgress(videoId, 100, page, downloadId);
  triggerDownload(finalBlob, fileName);
}

// ============================================================
// Download Trigger
// ============================================================

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  logger.info(`Download triggered: ${fileName} (${formatBytes(blob.size)})`);
}

// ============================================================
// Utilities
// ============================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ============================================================
// Main Entry - Event Listener
// ============================================================

async function handleSingleDownload(src: SingleVideoSource): Promise<void> {
  const { video_url, video_id, page, download_id } = src;

  if (!video_url) {
    logger.error('No video URL provided');
    return;
  }

  try {
    if (video_url.startsWith('blob:')) {
      await downloadBlobUrl(video_url, video_id, page, download_id);
    } else {
      await downloadSegmented(video_url, video_id, page, download_id);
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error), video_id);
    // Dispatch error event
    const evt = new CustomEvent(`${video_id}_video_download_error`, {
      detail: {
        video_id,
        error: error instanceof Error ? error.message : String(error),
        download_id,
      },
    });
    document.dispatchEvent(evt);
  }
}

document.addEventListener('video_download', ((event: CustomEvent<VideoDownloadDetail>) => {
  const { type, video_src } = event.detail;

  if (type === 'single') {
    handleSingleDownload(video_src as SingleVideoSource);
  } else if (type === 'batch') {
    const sources = video_src as SingleVideoSource[];
    // Process batch downloads sequentially to avoid overwhelming the network
    sources.reduce(
      (chain, src) => chain.then(() => handleSingleDownload(src)),
      Promise.resolve(),
    );
  }
}) as EventListener);

logger.info('Download script injected and ready.');
