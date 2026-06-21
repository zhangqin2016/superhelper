"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const code = error?.cause?.code || error?.code || "";
  if (error?.name === "AbortError") return true;
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
  ].includes(code);
}

async function fetchArtifactBuffer(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120_000);
  const maxBytes = Number(options.maxBytes || 50 * 1024 * 1024);
  const attempts = Math.max(1, Number(options.attempts || DEFAULT_ATTEMPTS));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          // These artifacts are verified byte-for-byte by sha256. Do not let
          // the transport negotiate compressed payloads for zip objects.
          "Accept-Encoding": "identity",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const length = Number(response.headers.get("content-length") || 0);
      if (length > maxBytes) {
        throw new Error("ARTIFACT_TOO_LARGE");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new Error("ARTIFACT_TOO_LARGE");
      }
      return buffer;
    } catch (error) {
      lastError = error;
      const retry = attempt < attempts && isRetryableError(error);
      if (!retry) break;
      // Exponential backoff with jitter (500ms, 1s, 2s… capped at 8s) so repeated
      // transient failures don't hammer the server in lockstep.
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
      await sleep(backoff + Math.floor(Math.random() * 250));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("DOWNLOAD_FAILED");
}

async function downloadArtifactToFile(url, destPath, options = {}) {
  const buffer = await fetchArtifactBuffer(url, options);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
  return buffer;
}

module.exports = {
  downloadArtifactToFile,
  fetchArtifactBuffer,
};
