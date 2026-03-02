"use strict";
(() => {
  // src/inject/downloader.ts
  var currentSettings = {
    downloadFolder: "TeleDown",
    parallelChunks: 20
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.type !== "tele_down_settings") return;
    const { downloadFolder, parallelChunks } = e.data;
    if (downloadFolder !== void 0) currentSettings.downloadFolder = downloadFolder;
    if (parallelChunks !== void 0) currentSettings.parallelChunks = parallelChunks;
    console.log("[TeleDown] Settings updated:", currentSettings);
  });
  var logger = {
    info: (msg, ctx) => console.log(`[TeleDown] ${ctx ? `[${ctx}] ` : ""}${msg}`),
    error: (msg, ctx) => console.error(`[TeleDown] ${ctx ? `[${ctx}] ` : ""}${msg}`)
  };
  var activeDownloads = /* @__PURE__ */ new Set();
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
  function dispatchProgress(videoId, progress, page, downloadId) {
    if (!videoId) return;
    document.dispatchEvent(
      new CustomEvent(`${videoId}_video_download_progress`, {
        detail: { video_id: videoId, progress: progress.toFixed(0), page, download_id: downloadId }
      })
    );
  }
  var MAX_RETRIES = 5;
  async function fetchWithRetry(url, init, label) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok || response.status === 206) {
          return response;
        }
        if (response.status >= 500 || response.status === 408) {
          logger.info(`${label}: HTTP ${response.status}, retry ${attempt + 1}/${MAX_RETRIES}`);
          await sleep(1e3 * (attempt + 1));
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
  async function downloadBlobUrl(url, videoId, page, downloadId) {
    const blobs = [];
    let offset = 0;
    let totalSize = null;
    let extension = "mp4";
    let baseName = extractFileName(url, videoId, extension);
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
  async function downloadSegmented(url, videoId, page, downloadId) {
    const probeResp = await fetchWithRetry(url, { headers: { Range: "bytes=0-" } }, "Probe");
    const contentSize = parseInt(probeResp.headers.get("Content-Range")?.split("/")[1] || "0", 10);
    const segmentSize = parseInt(probeResp.headers.get("Content-Length") || "0", 10);
    const contentType = probeResp.headers.get("Content-Type") || "application/octet-stream";
    if (!contentSize || !segmentSize) throw new Error("Cannot determine content size");
    const ext = contentType.split("/")[1] || "mp4";
    const fileName = extractFileName(url, videoId, ext);
    const numSegments = Math.ceil(contentSize / segmentSize);
    const maxConcurrent = Math.max(1, currentSettings.parallelChunks || 20);
    logger.info(
      `Download: ${numSegments} segments, ${formatBytes(contentSize)}, segSize=${formatBytes(segmentSize)}, concurrent=${maxConcurrent}`,
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
    const { video_url, video_id, page, download_id } = src;
    if (!video_url) return;
    if (activeDownloads.has(video_id)) {
      logger.info(`Skipping duplicate download: ${video_id}`);
      return;
    }
    activeDownloads.add(video_id);
    const resolvedUrl = resolveVideoUrl(video_url);
    try {
      if (resolvedUrl.startsWith("blob:")) {
        await downloadBlobUrl(resolvedUrl, video_id, page, download_id);
      } else {
        await downloadSegmented(resolvedUrl, video_id, page, download_id);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(msg, video_id);
      document.dispatchEvent(
        new CustomEvent(`${video_id}_video_download_error`, {
          detail: { video_id, error: msg, download_id }
        })
      );
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
