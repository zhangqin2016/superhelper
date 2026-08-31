"use strict";

const crypto = require("node:crypto");
const MAX_PART_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9_=-]{1,200}$/.test(value);
const partNumber = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 10000;
const expiry = (value) => Number.isSafeInteger(value) && value > 0;
function failure(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}
function check(condition, response = false) {
  if (!condition) throw failure(response ? "COLLAB_TRANSFER_RESPONSE_INVALID" : "COLLAB_TRANSFER_INPUT_INVALID");
}

// Qiniu multipart v2 retains base64 padding; Content-MD5 uses hex, as in
// the official Node SDK (qiniu/util.js getMd5).
function endpoint(ticket, uploadId) {
  check(ticket && typeof ticket.bucket === "string" && /^[A-Za-z0-9-]{1,63}$/.test(ticket.bucket)
    && /^collaboration\/[a-f0-9]{64}$/.test(ticket.objectKey)
    && typeof ticket.token === "string" && /^[\x21-\x7e]{1,8192}$/.test(ticket.token));
  let url;
  try { url = new URL(ticket.uploadUrl); } catch { check(false); }
  check(url.protocol === "https:" && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === "/");
  if (uploadId !== undefined) check(safeId(uploadId));
  const encoded = Buffer.from(ticket.objectKey).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
  return `${url.origin}/buckets/${ticket.bucket}/objects/${encoded}/uploads${uploadId === undefined ? "" : `/${uploadId}`}`;
}
async function readJson(response) {
  const reader = response.body?.getReader();
  check(reader, true);
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); }
      catch { throw failure("COLLAB_TRANSFER_RESPONSE_UNKNOWN", true); }
      const { value, done } = chunk;
      if (done) break;
      length += value.byteLength;
      check(length <= MAX_RESPONSE_BYTES, true);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (["COLLAB_TRANSFER_RESPONSE_INVALID", "COLLAB_TRANSFER_RESPONSE_UNKNOWN"].includes(error.code)) throw error;
    throw failure("COLLAB_TRANSFER_RESPONSE_INVALID");
  } finally { reader.releaseLock(); }
}
function createQiniuMultipartTransport({ fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  check(typeof fetchImpl === "function" && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000);
  async function request(ticket, url, method, { body, headers = {}, empty = false } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `UpToken ${ticket.token}`, ...headers }, ...(body === undefined ? {} : { body }),
      });
    } catch { throw failure("COLLAB_TRANSFER_RESPONSE_UNKNOWN", true); }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      const status = response.status;
      if (status === 401 || status === 403) throw failure("COLLAB_TRANSFER_AUTH_REQUIRED");
      if (status === 404 || status === 612) throw failure("COLLAB_TRANSFER_SESSION_MISSING");
      if (status === 614) throw failure("COLLAB_TRANSFER_OBJECT_EXISTS");
      throw failure("COLLAB_TRANSFER_HTTP_ERROR", status === 408 || status === 429 || (status >= 500 && status <= 599));
    }
    if (empty) { await response.body?.cancel?.().catch(() => {}); return; }
    return readJson(response);
  }
  return {
    async initiate({ ticket }) {
      const value = await request(ticket, endpoint(ticket), "POST");
      check(value && safeId(value.uploadId) && expiry(value.expireAt), true);
      return { uploadId: value.uploadId, expireAt: value.expireAt };
    },
    async uploadPart({ ticket, uploadId, partNumber: number, bytes }) {
      check(safeId(uploadId));
      const url = endpoint(ticket, uploadId);
      check(partNumber(number) && Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_PART_BYTES);
      const md5 = crypto.createHash("md5").update(bytes).digest("hex");
      const value = await request(ticket, `${url}/${number}`, "PUT", {
        body: bytes, headers: { "content-type": "application/octet-stream", "content-md5": md5 },
      });
      check(value && safeId(value.etag) && value.md5 === md5, true);
      return { partNumber: number, etag: value.etag };
    },
    async listParts({ ticket, uploadId, marker = 0 }) {
      check(safeId(uploadId));
      const url = endpoint(ticket, uploadId);
      check(marker === 0 || partNumber(marker));
      const value = await request(ticket, `${url}?max-parts=1000&part-number-marker=${marker}`, "GET");
      check(value && value.uploadId === uploadId && expiry(value.expireAt)
        && Array.isArray(value.parts) && value.parts.length <= 1000, true);
      let previous = marker;
      const parts = value.parts.map((part) => {
        check(part && partNumber(part.partNumber) && part.partNumber > previous && safeId(part.etag)
          && Number.isSafeInteger(part.size) && part.size > 0 && part.size <= MAX_PART_BYTES, true);
        previous = part.partNumber;
        return { partNumber: part.partNumber, etag: part.etag, size: part.size };
      });
      check(value.partNumberMarker === 0 || (partNumber(value.partNumberMarker)
        && parts.length > 0 && value.partNumberMarker === previous), true);
      return { uploadId, expireAt: value.expireAt, marker: value.partNumberMarker, parts };
    },
    async complete({ ticket, uploadId, parts }) {
      check(safeId(uploadId));
      const url = endpoint(ticket, uploadId);
      check(Array.isArray(parts) && parts.length > 0 && parts.length <= 10000);
      let previous = 0;
      const projected = parts.map((part) => {
        check(part && partNumber(part.partNumber) && part.partNumber > previous && safeId(part.etag));
        previous = part.partNumber;
        return { partNumber: part.partNumber, etag: part.etag };
      });
      const value = await request(ticket, url, "POST", {
        body: JSON.stringify({ parts: projected, mimeType: "application/octet-stream" }),
        headers: { "content-type": "application/json" },
      });
      check(value && value.key === ticket.objectKey && safeId(value.hash), true);
      return { etag: value.hash };
    },
    async abort({ ticket, uploadId }) {
      check(safeId(uploadId));
      return request(ticket, endpoint(ticket, uploadId), "DELETE", { empty: true });
    },
  };
}

module.exports = { createQiniuMultipartTransport, MAX_PART_BYTES };
