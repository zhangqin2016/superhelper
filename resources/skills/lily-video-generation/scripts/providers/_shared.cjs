"use strict";

// Shared helpers for video-generation provider adapters. Each adapter owns its
// own submit/poll/extract flow (sync vs async, Bearer vs JWT vs GroupId differ
// too much to force a common shape), but they share HTTP + polling primitives so
// the wire behaviour stays identical across providers.

const crypto = require("node:crypto");

// Transient = worth retrying: undici socket failures ("fetch failed", ECONNRESET,
// socket hang up — typically a stale keep-alive connection reused after the server
// dropped it), aborts/timeouts, and 5xx/429. NOT 4xx (real API errors).
function isRetryableError(err) {
  if (err && err.__retryStatus) return true;
  if (err && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
  const msg = String((err && err.message) || err || "");
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|terminated|aborted/i.test(msg);
}

async function requestJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 60_000;
  const retries = Number.isInteger(options.retries) ? options.retries : 3;
  const { timeoutMs: _omitT, retries: _omitR, ...init } = options;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!response.ok) {
        const message = data?.message || data?.code || text || `${response.status} ${response.statusText}`;
        const error = new Error(message);
        // Server-side/ratelimit → retry; client errors (4xx) fail fast.
        if (response.status >= 500 || response.status === 429) error.__retryStatus = true;
        throw error;
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryableError(err)) {
        await sleep(Math.min(8000, 500 * 2 ** attempt)); // 0.5s, 1s, 2s, …
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pollIntervalMs(fallback) {
  return Math.max(50, Number(process.env.LILY_MEDIA_POLL_INTERVAL_MS || fallback));
}

function base64urlEncode(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Mint a short-lived HS256 JWT for Kling-style auth (iss=accessKey, exp=+ttl,
// nbf=-5s skew). Used by the Kling adapter in BYOK/direct mode; in gateway mode
// the server signs it instead so the SecretKey never reaches the client.
function signHs256Jwt({ accessKey, secretKey, ttlSeconds = 1800 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64urlEncode(JSON.stringify({ iss: accessKey, exp: now + ttlSeconds, nbf: now - 5 }));
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${payload}.${signature}`;
}

module.exports = { requestJson, isRetryableError, sleep, pollIntervalMs, signHs256Jwt };
