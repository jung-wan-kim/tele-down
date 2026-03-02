"use strict";
(() => {
  // src/inject/downloader.ts
  var currentSettings = {
    downloadFolder: "TeleDown",
    parallelChunks: 20
  };
  document.addEventListener("tele_down_settings", ((e) => {
    currentSettings = { ...currentSettings, ...e.detail };
    console.log("[TeleDown] Settings updated:", currentSettings);
  }));
  var logger = {
    info: (msg, ctx) => console.log(`[TeleDown] ${ctx ? `[${ctx}] ` : ""}${msg}`),
    error: (msg, ctx) => console.error(`[TeleDown] ${ctx ? `[${ctx}] ` : ""}${msg}`)
  };
  function extractFileName(url, videoId, extension) {
    try {
      if (url.includes("stream/")) {
        const encodedPart = url.substring(url.indexOf("stream/") + 7).split("?")[0];
        const parsed = JSON.parse(decodeURIComponent(encodedPart));
        if (parsed?.fileName) return parsed.fileName;
        if (parsed?.location?.id) return `${parsed.location.id}.${extension}`;
      }
      if (url.includes("progressive/")) {
        const docPart = url.split("document").slice(1).join("");
        if (docPart) return `${docPart}.${extension}`;
      }
    } catch {
    }
    if (videoId) return `${videoId}.${extension}`;
    return `${Math.random().toString(36).substring(2, 10)}.${extension}`;
  }
  function withFolder(fileName) {
    const folder = currentSettings.downloadFolder?.trim();
    if (!folder) return fileName;
    return `${folder}/${fileName}`;
  }
  function dispatchProgress(videoId, progress, page, downloadId) {
    if (!videoId) return;
    document.dispatchEvent(
      new CustomEvent(`${videoId}_video_download_progress`, {
        detail: { video_id: videoId, progress: progress.toFixed(0), page, download_id: downloadId }
      })
    );
  }
  var CONTENT_RANGE_REGEX = /^bytes (\d+)-(\d+)\/(\d+)$/;
  async function downloadBlobUrl(url, videoId, page, downloadId) {
    const blobs = [];
    let offset = 0;
    let totalSize = null;
    let extension = "mp4";
    let baseName = extractFileName(url, videoId, extension);
    const fetchNext = async () => {
      const response = await fetch(url, {
        method: "GET",
        headers: { Range: `bytes=${offset}-` }
      });
      if (![200, 206].includes(response.status)) {
        throw new Error(`HTTP ${response.status}`);
      }
      const ct = response.headers.get("Content-Type")?.split(";")[0] || "";
      const ext = ct.split("/")[1];
      if (ext) {
        extension = ext;
        baseName = baseName.replace(/\.[^.]+$/, `.${ext}`);
      }
      const rangeHeader = response.headers.get("Content-Range") || "";
      const match = rangeHeader.match(CONTENT_RANGE_REGEX);
      if (!match) throw new Error("Invalid Content-Range header");
      const rangeStart = parseInt(match[1], 10);
      const rangeEnd = parseInt(match[2], 10);
      const total = parseInt(match[3], 10);
      if (rangeStart !== offset) throw new Error(`Gap: expected ${offset}, got ${rangeStart}`);
      if (totalSize !== null && total !== totalSize) throw new Error("Total size mismatch");
      offset = rangeEnd + 1;
      totalSize = total;
      const progress = offset / totalSize * 100;
      dispatchProgress(videoId, progress, page, downloadId);
      blobs.push(await response.blob());
      if (offset < totalSize) await fetchNext();
    };
    await fetchNext();
    const finalBlob = new Blob(blobs, { type: "video/mp4" });
    triggerDownload(finalBlob, baseName);
  }
  async function probeSegmentInfo(url) {
    const response = await fetch(url, { headers: { Range: "bytes=0-" } });
    if (!response.ok) throw new Error(`Probe failed: HTTP ${response.status}`);
    const contentSize = parseInt(response.headers.get("Content-Range")?.split("/")[1] || "0", 10);
    const segmentSize = parseInt(response.headers.get("Content-Length") || "0", 10);
    const contentType = response.headers.get("Content-Type") || "application/octet-stream";
    if (response.headers.get("Accept-Ranges") !== "bytes") {
      throw new Error("Server does not support byte-range requests");
    }
    if (!contentSize || !segmentSize) throw new Error("Cannot determine content size");
    return {
      contentType,
      segmentCount: Math.ceil(contentSize / segmentSize),
      segmentSize,
      contentSize
    };
  }
  var FetchRetryError = class extends Error {
    constructor(message, segmentIndex, range) {
      super(message);
      this.segmentIndex = segmentIndex;
      this.range = range;
      this.name = "FetchRetryError";
    }
  };
  function createSegmentFetchers(url, info, videoId, page, downloadId) {
    return Array.from({ length: info.segmentCount }, (_, index) => {
      const start = index * info.segmentSize;
      const end = Math.min(start + info.segmentSize - 1, info.contentSize - 1);
      return async () => {
        const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (response.status === 408) {
          throw new FetchRetryError(`Timeout on segment ${index}`, index, `bytes=${start}-${end}`);
        }
        if (!response.ok && response.status !== 206) {
          throw new Error(`Segment ${index}: HTTP ${response.status}`);
        }
        const progress = end / info.contentSize * 100;
        dispatchProgress(videoId, progress, page, downloadId);
        return response.arrayBuffer();
      };
    });
  }
  async function executeBatched(fetchers, batchSize) {
    const results = [];
    let offset = 0;
    while (offset < fetchers.length) {
      const batch = fetchers.slice(offset, offset + batchSize).map((fn) => fn());
      try {
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
        offset += batchSize;
      } catch (err) {
        if (err instanceof FetchRetryError) {
          offset = err.segmentIndex;
          await new Promise((r) => setTimeout(r, 1e3));
        } else {
          throw err;
        }
      }
    }
    return results;
  }
  async function downloadSegmented(url, videoId, page, downloadId) {
    const info = await probeSegmentInfo(url);
    const ext = info.contentType.split("/")[1] || "mp4";
    const fileName = extractFileName(url, videoId, ext);
    logger.info(
      `Segmented download: ${info.segmentCount} segments, ${formatBytes(info.contentSize)}`,
      fileName
    );
    const fetchers = createSegmentFetchers(url, info, videoId, page, downloadId);
    const batchSize = currentSettings.parallelChunks || 20;
    const segments = await executeBatched(fetchers, batchSize);
    const finalBlob = new Blob(segments, { type: info.contentType });
    dispatchProgress(videoId, 100, page, downloadId);
    triggerDownload(finalBlob, fileName);
  }
  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = withFolder(fileName);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logger.info(`Download triggered: ${a.download} (${formatBytes(blob.size)})`);
  }
  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }
  async function handleSingleDownload(src) {
    const { video_url, video_id, page, download_id } = src;
    if (!video_url) return;
    try {
      if (video_url.startsWith("blob:")) {
        await downloadBlobUrl(video_url, video_id, page, download_id);
      } else {
        await downloadSegmented(video_url, video_id, page, download_id);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(msg, video_id);
      document.dispatchEvent(
        new CustomEvent(`${video_id}_video_download_error`, {
          detail: { video_id, error: msg, download_id }
        })
      );
    }
  }
  document.addEventListener("video_download", ((event) => {
    const { type, video_src } = event.detail;
    if (type === "single") {
      handleSingleDownload(video_src);
    } else if (type === "batch") {
      const sources = video_src;
      sources.reduce(
        (chain, src) => chain.then(() => handleSingleDownload(src)),
        Promise.resolve()
      );
    }
  }));
  logger.info("Downloader ready (folder: " + currentSettings.downloadFolder + ")");
})();
