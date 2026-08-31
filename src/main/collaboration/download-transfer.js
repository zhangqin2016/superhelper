"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Writable } = require("node:stream");
const { decryptFile, decryptStream } = require("./encrypted-container");
const { MAX_PART_BYTES } = require("./multipart-transport");
const fail = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });
const ensure = (value) => { if (!value) throw fail("COLLAB_TRANSFER_RESPONSE_INVALID"); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function ownedFile(filename, { create = false, maxSize = 1024 ** 3 } = {}) {
  let before;
  try { before = await fs.promises.lstat(filename); } catch (error) { if (!create || error.code !== "ENOENT") throw error; }
  if (before && (!before.isFile() || before.nlink !== 1 || before.size > maxSize)) throw fail("COLLAB_TRANSFER_UNSAFE_PATH");
  const flags = (before ? fs.constants.O_RDWR : fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR) | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const file = await fs.promises.open(filename, flags, 0o600);
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxSize || before && !same(before, stat)) { await file.close(); throw fail("COLLAB_TRANSFER_UNSAFE_PATH"); }
  return { file, stat };
}
async function hashFile(file, size) {
  const hash = crypto.createHash("sha256"), bytes = Buffer.alloc(65536);
  for (let position = 0; position < size;) {
    const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, size - position), position);
    if (!bytesRead) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
    hash.update(bytes.subarray(0, bytesRead)); position += bytesRead;
  }
  return hash.digest("hex");
}
async function removeOwned(manifests, id, name, identity) {
  const filename = path.join(manifests.directory(id), name);
  try {
    const stat = await fs.promises.lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1 || identity && !same(identity, stat)) throw fail("COLLAB_TRANSFER_UNSAFE_PATH");
    await fs.promises.unlink(filename);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
async function verifiedDownloadFile({ manifests, item, guard }) {
  guard(item);
  if (item.direction !== "download" || item.checkpoint.state !== "ready" || !item.checkpoint.plaintext) throw fail("COLLAB_TRANSFER_NOT_READY");
  const filename = path.join(manifests.directory(item.id), "plaintext.verified");
  const { file, stat } = await ownedFile(filename);
  try {
    if (stat.size !== item.checkpoint.plaintext.size || await hashFile(file, stat.size) !== item.checkpoint.plaintext.sha256) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
    guard(item); return filename;
  } finally { await file.close(); }
}

/** Range requests are at most 4 MiB and credentials are never journaled.
 * https://developer.qiniu.com/kodo/manual/download-process
 */
async function downloadTransfer({ item, manifests, objectClient, deviceId, fetchImpl, guard, save }) {
  let key, ticket, file, identity, position;
  const filename = () => path.join(manifests.directory(item.id), "ciphertext.part");
  async function freshTicket() {
    const result = await objectClient.downloadTicket({ deviceId, objectId: item.checkpoint.objectId, clientCommandId: crypto.randomUUID() });
    guard(item);
    ensure(result?.objectId === item.checkpoint.objectId && Number.isSafeInteger(result.ciphertextSize) && result.ciphertextSize >= 1
      && result.ciphertextSize <= (item.purpose === "workspace" ? 256 * 1024 ** 2 : 1024 ** 3) && /^[a-f0-9]{64}$/.test(result.ciphertextSha256));
    let url;
    try { url = new URL(result.url); } catch { ensure(false); }
    ensure(typeof result.url === "string" && result.url.length <= 8192 && url.protocol === "https:" && !url.username && !url.password && !url.hash);
    const expires = new Date(result.expiresAt).getTime();
    ensure(Number.isFinite(expires));
    if (expires <= Date.now()) throw fail("COLLAB_TRANSFER_AUTH_REQUIRED", true);
    const secret = Buffer.isBuffer(result.dek) ? Buffer.from(result.dek) : Buffer.from(String(result.dek || ""), "base64");
    if (secret.length !== 32 || typeof result.dek === "string" && secret.toString("base64") !== result.dek) { secret.fill(0); ensure(false); }
    result.dek?.fill?.(0); key?.fill(0); key = secret;
    const projection = { ciphertextSize: result.ciphertextSize, ciphertextSha256: result.ciphertextSha256 };
    if (item.checkpoint.download && (item.checkpoint.download.ciphertextSize !== projection.ciphertextSize || item.checkpoint.download.ciphertextSha256 !== projection.ciphertextSha256)) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
    item = save(item, { state: "downloading", download: projection });
    ticket = { url: result.url, expires, ...projection };
  }
  try {
    guard(item); ensure(item.direction === "download" && item.checkpoint.objectId);
    await freshTicket();
    const opened = await ownedFile(filename(), { create: true, maxSize: ticket.ciphertextSize });
    file = opened.file; identity = opened.stat; position = identity.size;
    let refreshes = 0;
    while (position < ticket.ciphertextSize) {
      guard(item);
      if (ticket.expires <= Date.now() + 1000) { if (++refreshes > 1) throw fail("COLLAB_TRANSFER_AUTH_REQUIRED", true); await freshTicket(); }
      const end = Math.min(position + MAX_PART_BYTES, ticket.ciphertextSize) - 1;
      let response;
      try { response = await fetchImpl(ticket.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30000), headers: { range: `bytes=${position}-${end}` } }); }
      catch { throw fail("COLLAB_TRANSFER_RESPONSE_UNKNOWN", true); }
      guard(item);
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel?.().catch(() => {});
        if (++refreshes > 1) throw fail("COLLAB_TRANSFER_AUTH_REQUIRED", true);
        await freshTicket(); continue;
      }
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw fail("COLLAB_TRANSFER_HTTP_ERROR", [408, 429].includes(response.status) || response.status >= 500 && response.status < 600); }
      const expected = end - position + 1;
      try {
        ensure(response.status === 206 && response.headers.get("content-range") === `bytes ${position}-${end}/${ticket.ciphertextSize}`
          || response.status === 200 && position === 0 && expected === ticket.ciphertextSize);
        const declared = response.headers.get("content-length");
        ensure(declared == null || Number(declared) === expected);
      } catch (error) { await response.body?.cancel?.().catch(() => {}); throw error; }
      const reader = response.body?.getReader(); ensure(reader);
      let received = 0;
      try {
        for (;;) {
          let chunk;
          try { chunk = await reader.read(); } catch { throw fail("COLLAB_TRANSFER_RESPONSE_UNKNOWN", true); }
          guard(item); if (chunk.done) break;
          ensure(received + chunk.value.byteLength <= expected);
          for (let offset = 0; offset < chunk.value.byteLength;) {
            guard(item);
            const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.byteLength - offset, position);
            if (!bytesWritten) throw fail("COLLAB_TRANSFER_WRITE_FAILED");
            offset += bytesWritten; position += bytesWritten; received += bytesWritten;
          }
        }
        if (received !== expected) throw fail("COLLAB_TRANSFER_RESPONSE_UNKNOWN", true);
        await file.sync(); refreshes = 0;
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    if (await hashFile(file, ticket.ciphertextSize) !== ticket.ciphertextSha256) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
    await file.sync(); await file.close(); file = null; guard(item);
    item = save(item, { state: "decrypting" });
    const outputPath = path.join(manifests.directory(item.id), "plaintext.verified");
    let result;
    try { await fs.promises.lstat(outputPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; result = await decryptFile({ inputPath: filename(), outputPath, key }); }
    if (!result) {
      // A crash can follow plaintext publication but precede the ready journal.
      // Reauthenticate the container and compare the existing plaintext bytes.
      result = await decryptStream({ input: fs.createReadStream(filename(), { highWaterMark: 65536, flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }),
        output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }), key });
      const existing = await ownedFile(outputPath);
      try { if (existing.stat.size !== result.metadata.plaintextSize || await hashFile(existing.file, existing.stat.size) !== result.metadata.plaintextSha256) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED"); }
      finally { await existing.file.close(); }
    }
    guard(item);
    return save(item, { state: "ready", plaintext: { size: result.metadata.plaintextSize, sha256: result.metadata.plaintextSha256, originalName: result.metadata.fileName } });
  } catch (error) {
    await file?.sync().catch(() => {}); await file?.close(); file = null;
    if (error.code === "COLLAB_TRANSFER_INTEGRITY_FAILED" || error.code?.startsWith("LILYENC_")) {
      await removeOwned(manifests, item.id, "ciphertext.part", identity);
      await removeOwned(manifests, item.id, "plaintext.verified");
    }
    throw error;
  } finally { key?.fill(0); await file?.close(); }
}

module.exports = { downloadTransfer, verifiedDownloadFile };
