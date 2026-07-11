"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { finished } = require("node:stream/promises");

const DEFAULT_RETRY_DELAYS_MS = [250, 750, 1750];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function safeArtifactUrl(value) {
  const parsed = new URL(String(value || ""));
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("INVALID_RUNTIME_PACK_URL");
  }
  return parsed.toString();
}

async function availableBytesForPath(targetPath) {
  if (typeof fs.statfsSync !== "function") return Number.POSITIVE_INFINITY;
  const stats = fs.statfsSync(path.dirname(targetPath));
  return Number(stats.bavail || 0) * Number(stats.bsize || 0);
}

function partSize(partPath) {
  try {
    return fs.statSync(partPath).size;
  } catch {
    return 0;
  }
}

async function writeResponseBody(response, partPath, { append, initialBytes, maxBytes, totalBytes, attempt, onProgress }) {
  fs.mkdirSync(path.dirname(partPath), { recursive: true });
  const output = fs.createWriteStream(partPath, { flags: append ? "a" : "w" });
  let writtenBytes = append ? initialBytes : 0;
  try {
    for await (const chunk of response.body) {
      writtenBytes += chunk.length;
      if (writtenBytes > maxBytes) throw new Error("RUNTIME_PACK_TOO_LARGE");
      if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
      if (typeof onProgress === "function") {
        onProgress({ writtenBytes, totalBytes: totalBytes || null, attempt, resumed: append });
      }
    }
  } finally {
    output.end();
  }
  await finished(output);
  return writtenBytes;
}

async function downloadArtifact(options = {}) {
  const {
    partPath,
    expectedBytes = 0,
    maxBytes = 2 * 1024 * 1024 * 1024,
    maxAttempts = 3,
    requestTimeoutMs = 300_000,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    freeBytes = availableBytesForPath,
    onProgress,
  } = options;
  let url;
  try {
    url = safeArtifactUrl(options.url);
  } catch (error) {
    return { ok: false, error: error?.message || "INVALID_RUNTIME_PACK_URL" };
  }
  if (!partPath) return { ok: false, error: "INVALID_RUNTIME_PACK_PART_PATH" };

  const initialBytes = partSize(partPath);
  const remainingBytes = Math.max(0, Number(expectedBytes || 0) - initialBytes);
  if (expectedBytes > 0) {
    const available = await freeBytes(partPath);
    if (Number.isFinite(available) && available < remainingBytes * 2) {
      return {
        ok: false,
        error: "INSUFFICIENT_DISK_SPACE",
        requiredBytes: remainingBytes * 2,
        availableBytes: available,
      };
    }
  }
  if (expectedBytes > 0 && initialBytes === expectedBytes) {
    return { ok: true, path: partPath, writtenBytes: initialBytes, totalBytes: expectedBytes, resumed: true };
  }

  let lastError = "RUNTIME_PACK_DOWNLOAD_FAILED";
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    const existingBytes = partSize(partPath);
    const headers = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok && response.status !== 206) {
        lastError = `RUNTIME_PACK_DOWNLOAD_FAILED_${response.status}`;
        if (!isRetryableStatus(response.status) || attempt >= maxAttempts) {
          return { ok: false, error: lastError, status: response.status };
        }
      } else {
        const append = existingBytes > 0 && response.status === 206;
        const contentLength = Number(response.headers.get("content-length") || 0);
        const totalBytes = Number(expectedBytes || (append ? existingBytes + contentLength : contentLength));
        const writtenBytes = await writeResponseBody(response, partPath, {
          append,
          initialBytes: existingBytes,
          maxBytes,
          totalBytes,
          attempt,
          onProgress,
        });
        if (expectedBytes > 0 && writtenBytes !== expectedBytes) {
          lastError = "RUNTIME_PACK_SIZE_MISMATCH";
          if (attempt >= maxAttempts) return { ok: false, error: lastError, writtenBytes, totalBytes: expectedBytes };
        } else {
          return {
            ok: true,
            path: partPath,
            writtenBytes,
            totalBytes: totalBytes || writtenBytes,
            resumed: initialBytes > 0,
            attempts: attempt,
            etag: response.headers.get("etag") || "",
            lastModified: response.headers.get("last-modified") || "",
          };
        }
      }
    } catch (error) {
      lastError = error?.message || "RUNTIME_PACK_DOWNLOAD_FAILED";
      if (lastError === "RUNTIME_PACK_TOO_LARGE") {
        fs.rmSync(partPath, { force: true });
        return { ok: false, error: lastError };
      }
      if (attempt >= maxAttempts) return { ok: false, error: lastError };
    } finally {
      clearTimeout(timer);
    }
    const baseDelay = Number(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0);
    const jitter = retryDelaysMs === DEFAULT_RETRY_DELAYS_MS ? Math.floor(Math.random() * 100) : 0;
    await sleep(baseDelay + jitter);
  }
  return { ok: false, error: lastError };
}

module.exports = {
  availableBytesForPath,
  downloadArtifact,
  safeArtifactUrl,
};
