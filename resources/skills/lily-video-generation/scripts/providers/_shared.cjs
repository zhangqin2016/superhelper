"use strict";

// Shared helpers for video-generation provider adapters. Each adapter owns its
// own submit/poll/extract flow (sync vs async, Bearer vs JWT vs GroupId differ
// too much to force a common shape), but they share HTTP + polling primitives so
// the wire behaviour stays identical across providers.

const crypto = require("node:crypto");

async function requestJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 60_000;
  const { timeoutMs: _omit, ...init } = options;
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
    throw new Error(message);
  }
  return data;
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

module.exports = { requestJson, sleep, pollIntervalMs, signHs256Jwt };
