"use strict";
(() => {
  // src/inject/downloader.ts
  var currentSettings = {
    downloadFolder: "TeleDown",
    parallelChunks: 3,
    downloadQueue: 50
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.type !== "tele_down_settings") return;
    const { downloadFolder, parallelChunks } = e.data;
    if (downloadFolder !== void 0) currentSettings.downloadFolder = downloadFolder;
    if (parallelChunks !== void 0) currentSettings.parallelChunks = parallelChunks;
    if (e.data.downloadQueue !== void 0) currentSettings.downloadQueue = e.data.downloadQueue;
    console.log("[TeleDown] Settings updated:", currentSettings);
  });
  var logger = {
    info: (msg, ctx) => console.log(`[TeleDown] ${ctx ? `[${ctx}] ` : ""}${msg}`),
    error: (msg, ctx) => console.error(`[TeleDown] ${ctx ? `[${ctx}] ` : ""}${msg}`)
  };
  var activeDownloads = /* @__PURE__ */ new Set();
  var completedDownloads = /* @__PURE__ */ new Set();
  var downloadedFileIds = /* @__PURE__ */ new Set();
  function extractFileId(url) {
    try {
      if (!url.includes("stream/")) return null;
      const encoded = url.substring(url.indexOf("stream/") + 7).split("?")[0];
      const parsed = JSON.parse(decodeURIComponent(encoded));
      return parsed?.location?.id ? String(parsed.location.id) : null;
    } catch {
      return null;
    }
  }
  function resolveVideoUrl(url) {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:")) {
      return url;
    }
    try {
      return new URL(url, window.location.href).href;
    } catch {
      const base = window.location.origin + window.location.pathname;
      const prefix = url.startsWith("/") ? "" : "/";
      return `${base.replace(/\/$/, "")}${prefix}${url}`;
    }
  }
  function buildFileName(url, videoId, extension, chatName, timestamp) {
    let fileId = videoId;
    try {
      if (url.includes("stream/")) {
        const encodedPart = url.substring(url.indexOf("stream/") + 7).split("?")[0];
        const parsed = JSON.parse(decodeURIComponent(encodedPart));
        if (parsed?.location?.id) fileId = String(parsed.location.id);
        if (parsed?.fileName) {
          const originalName = parsed.fileName;
          const prefix2 = buildPrefix(chatName, timestamp);
          return prefix2 ? `${prefix2} ${originalName}` : originalName;
        }
      }
    } catch {
    }
    const prefix = buildPrefix(chatName, timestamp);
    const baseName = `${fileId}.${extension}`;
    return prefix ? `${prefix} ${baseName}` : baseName;
  }
  function buildPrefix(chatName, timestamp) {
    const parts = [];
    if (chatName) parts.push(`[${chatName}]`);
    if (timestamp) parts.push(timestamp);
    return parts.join(" ");
  }
  function dispatchProgress(videoId, progress, page, downloadId) {
    if (!videoId) return;
    window.postMessage({
      type: "tele_down_progress",
      video_id: videoId,
      progress: progress.toFixed(0),
      page,
      download_id: downloadId
    }, "*");
  }
  var MAX_RETRIES = 5;
  async function fetchWithRetry(url, init, label) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok || response.status === 206) {
          return response;
        }
        if (response.status >= 500 || response.status === 408 || response.status === 400) {
          const delay = response.status === 400 ? 2e3 * (attempt + 1) : 1e3 * (attempt + 1);
          logger.info(`${label}: HTTP ${response.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`${label}: HTTP ${response.status}`);
      } catch (err) {
        if (attempt < MAX_RETRIES - 1) {
          const delay = 1e3 * (attempt + 1);
          logger.info(`${label}: Network error, retry in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`);
          await sleep(delay);
        } else {
          throw err;
        }
      }
    }
    throw new Error(`${label}: All ${MAX_RETRIES} retries failed`);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  var CONTENT_RANGE_REGEX = /^bytes (\d+)-(\d+)\/(\d+)$/;
  async function downloadBlobUrl(url, videoId, page, downloadId, chatName, timestamp) {
    const blobs = [];
    let offset = 0;
    let totalSize = null;
    let extension = "mp4";
    let baseName = buildFileName(url, videoId, extension, chatName, timestamp);
    const fetchNext = async () => {
      const response = await fetchWithRetry(
        url,
        { method: "GET", headers: { Range: `bytes=${offset}-` } },
        `Blob seg@${offset}`
      );
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
      dispatchProgress(videoId, offset / totalSize * 100, page, downloadId);
      blobs.push(await response.blob());
      if (offset < totalSize) await fetchNext();
    };
    await fetchNext();
    const finalBlob = new Blob(blobs, { type: "video/mp4" });
    triggerDownload(finalBlob, baseName);
  }
  var CHUNK_ALIGN = 4096;
  var MAX_CHUNK = 1048576;
  var MIN_CHUNK = 524288;
  function alignChunkSize(totalSize, targetSegments) {
    let size = Math.floor(totalSize / Math.max(1, targetSegments));
    size = Math.floor(size / CHUNK_ALIGN) * CHUNK_ALIGN;
    return Math.max(MIN_CHUNK, Math.min(size, MAX_CHUNK));
  }
  async function downloadSegmented(url, videoId, page, downloadId, chatName, timestamp) {
    const probeResp = await fetchWithRetry(url, { headers: { Range: "bytes=0-0" } }, "Probe");
    const contentSize = parseInt(probeResp.headers.get("Content-Range")?.split("/")[1] || "0", 10);
    const contentType = probeResp.headers.get("Content-Type") || "application/octet-stream";
    if (!contentSize) throw new Error("Cannot determine content size");
    const targetQueue = Math.max(1, Math.min(currentSettings.downloadQueue || 50, 200));
    const segmentSize = alignChunkSize(contentSize, targetQueue);
    const numSegments = Math.ceil(contentSize / segmentSize);
    const maxConcurrent = Math.max(1, Math.min(currentSettings.parallelChunks || 3, 5));
    const ext = contentType.split("/")[1] || "mp4";
    const fileName = buildFileName(url, videoId, ext, chatName, timestamp);
    logger.info(
      `Download: ${numSegments} segs queued, ${formatBytes(contentSize)}, segSize=${formatBytes(segmentSize)}, concurrent=${maxConcurrent}`,
      fileName
    );
    const segments = [];
    for (let i = 0; i < numSegments; i++) {
      const start = i * segmentSize;
      const end = Math.min(start + segmentSize - 1, contentSize - 1);
      segments.push({ start, end, idx: i });
    }
    const buffers = new Array(numSegments);
    let completedSegments = 0;
    for (let i = 0; i < segments.length; i += maxConcurrent) {
      const batch = segments.slice(i, i + maxConcurrent);
      await Promise.all(
        batch.map(
          ({ start, end, idx }) => fetchWithRetry(
            url,
            { headers: { Range: `bytes=${start}-${end}` } },
            `Seg ${idx + 1}/${numSegments}`
          ).then(async (resp) => {
            buffers[idx] = await resp.arrayBuffer();
            completedSegments++;
            dispatchProgress(videoId, completedSegments / numSegments * 100, page, downloadId);
          })
        )
      );
      if (i + maxConcurrent < segments.length) {
        await sleep(150);
      }
    }
    const finalBlob = new Blob(buffers, { type: contentType });
    dispatchProgress(videoId, 100, page, downloadId);
    triggerDownload(finalBlob, fileName);
  }
  function triggerDownload(blob, fileName) {
    const blobUrl = URL.createObjectURL(blob);
    const folder = currentSettings.downloadFolder || "TeleDown";
    window.postMessage({
      type: "tele_down_save",
      blobUrl,
      fileName,
      folder
    }, "*");
    logger.info(`Download dispatched: ${folder}/${fileName} (${formatBytes(blob.size)})`);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 12e4);
  }
  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }
  async function handleSingleDownload(src) {
    const { video_url, video_id, page, download_id, chat_name, timestamp } = src;
    if (!video_url) return;
    if (activeDownloads.has(video_id) || completedDownloads.has(video_id)) {
      logger.info(`Skipping duplicate download: ${video_id} (${completedDownloads.has(video_id) ? "already completed" : "in progress"})`);
      return;
    }
    const resolvedUrl = resolveVideoUrl(video_url);
    const fileId = extractFileId(resolvedUrl);
    if (fileId && downloadedFileIds.has(fileId)) {
      logger.info(`Skipping duplicate file: ${video_id} (fileId=${fileId} already downloaded)`);
      dispatchProgress(video_id, 100, page, download_id);
      completedDownloads.add(video_id);
      return;
    }
    if (fileId) downloadedFileIds.add(fileId);
    activeDownloads.add(video_id);
    try {
      if (resolvedUrl.startsWith("blob:")) {
        await downloadBlobUrl(resolvedUrl, video_id, page, download_id, chat_name, timestamp);
      } else {
        await downloadSegmented(resolvedUrl, video_id, page, download_id, chat_name, timestamp);
      }
      completedDownloads.add(video_id);
    } catch (error) {
      if (fileId) downloadedFileIds.delete(fileId);
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(msg, video_id);
      window.postMessage({
        type: "tele_down_error",
        video_id,
        error: msg,
        download_id
      }, "*");
    } finally {
      activeDownloads.delete(video_id);
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
