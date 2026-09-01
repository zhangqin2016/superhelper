"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { encryptFile } = require("./encrypted-container");
const { MAX_PART_BYTES } = require("./multipart-transport");
const { downloadTransfer, verifiedDownloadFile } = require("./download-transfer");
const fail = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });
const ensure = (value) => { if (!value) throw fail("COLLAB_TRANSFER_RESPONSE_INVALID"); };
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9_=-]{1,200}$/.test(value);

function view(item) {
  const c = item.checkpoint;
  return { ok: true, id: item.id, conversationId: item.conversationId, scopeId: item.scopeId, direction: item.direction, purpose: item.purpose,
    state: c.state || "prepared", ...(c.objectId ? { objectId: c.objectId } : {}), completedParts: c.completedParts?.length || 0,
    ...(c.content ? { originalName: c.content.originalName, totalBytes: c.content.ciphertextSize } : {}) };
}
async function checkedCiphertext(filename, content) {
  const before = await fs.promises.lstat(filename);
  if (!before.isFile() || before.nlink !== 1 || before.size !== content.ciphertextSize) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
  const file = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino || stat.size !== content.ciphertextSize) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
    const hash = crypto.createHash("sha256"), bytes = Buffer.alloc(65536);
    for (let position = 0; position < stat.size;) {
      const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, stat.size - position), position);
      if (!bytesRead) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
      hash.update(bytes.subarray(0, bytesRead)); position += bytesRead;
    }
    if (hash.digest("hex") !== content.ciphertextSha256) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
    return file;
  } catch (error) { await file.close(); throw error; }
}

/** Owns one independent lane per transfer, never the text-message outbox lane.
 * assertAuthorized is a synchronous main-owned account/scope/lifecycle guard.
 * Provider responses are hints; server status/complete are the authority.
 */
function createTransferManager({ manifests, objectClient, multipart, deviceId, assertAuthorized, fetchImpl = globalThis.fetch } = {}) {
  if (!manifests || !objectClient || !multipart || !deviceId || typeof assertAuthorized !== "function") throw new TypeError("Transfer dependencies are required.");
  const running = new Map();
  const cancelled = new Set();
  const paused = new Set();
  let stopped = false;
  const deviceChanged = (item) => item.direction === "upload" && (item.checkpoint?.state || item.checkpoint?.content) && item.checkpoint.deviceId !== deviceId;
  function guard(item, allowCancelled = false, checkDevice = true) {
    if (stopped) throw fail("COLLABORATION_STOPPED");
    const result = assertAuthorized({ id: item.id, accountId: item.accountId, scopeId: item.scopeId, conversationId: item.conversationId, direction: item.direction, purpose: item.purpose });
    if (result === false || result?.then) throw fail("COLLAB_ACCESS_REVOKED");
    // Server receipts are partitioned by device, not only command ID. Legacy
    // uploads without identity are also ambiguous and must not be adopted.
    if (checkDevice && deviceChanged(item)) throw fail("COLLAB_TRANSFER_DEVICE_CHANGED");
    if (!allowCancelled && (cancelled.has(item.id) || item.checkpoint?.state === "cancelled")) throw fail("COLLAB_TRANSFER_CANCELLED");
    if (!allowCancelled && paused.has(item.id)) throw fail("COLLAB_TRANSFER_PAUSED");
  }
  function save(item, patch) {
    guard(item);
    return manifests.update({ id: item.id, expectedRevision: item.revision, checkpoint: { ...item.checkpoint, ...patch } });
  }
  function failureView(error, item) {
    const code = /^(COLLAB[A-Z_]*|LILYENC_[A-Z_]+)$/.test(error?.code || "") ? error.code : "COLLAB_TRANSFER_FAILED";
    const retryable = error?.retryable === true || ["COLLAB_RESPONSE_UNKNOWN", "COLLAB_NETWORK_UNAVAILABLE", "COLLAB_TRANSFER_AUTH_REQUIRED"].includes(code);
    if (item && !stopped) {
      try { item = save(item, { state: retryable ? "paused" : "failed" }); } catch { /* Revocation/stale revision cannot be overwritten by failure handling. */ }
    }
    const fenced = stopped || ["COLLAB_ACCESS_REVOKED", "COLLAB_ACCOUNT_CHANGED"].includes(code);
    return { ...(!fenced && item ? view(item) : {}), ok: false, code, retryable, state: code === "COLLAB_TRANSFER_CANCELLED" ? "cancelled" : stopped || retryable || ["COLLAB_TRANSFER_DEVICE_CHANGED", "COLLAB_TRANSFER_PAUSED"].includes(code) ? "paused" : "failed" };
  }
  async function resume(id) {
    let item, file;
    try {
      item = manifests.read(id); guard(item);
      if (item.direction !== "upload" || !item.checkpoint.content || item.checkpoint.state === "cancelled") throw fail("COLLAB_TRANSFER_NOT_READY");
      const content = item.checkpoint.content;
      let status;
      if (item.checkpoint.objectId) {
        status = await objectClient.status({ deviceId, objectId: item.checkpoint.objectId, clientCommandId: `${item.commandIds.init}:status` });
        guard(item);
        ensure(status?.objectId === item.checkpoint.objectId && status.ciphertextSize === content.ciphertextSize && status.ciphertextSha256 === content.ciphertextSha256);
      } else {
        file = await checkedCiphertext(path.join(manifests.directory(id), "ciphertext.lilyenc"), content); guard(item);
        const result = await objectClient.init({ deviceId, clientCommandId: item.commandIds.init, conversationId: item.conversationId, purpose: item.purpose, ...content });
        guard(item); ensure(safeId(result?.objectId) && result.state === "uploading" && result.upload);
        item = save(item, { objectId: result.objectId, state: "uploading" });
        status = { ...result, provider: { state: "missing" } };
      }
      if (["verified", "bound"].includes(status.state)) return view(save(item, { state: status.state }));
      ensure(status.state === "uploading" && status.upload && ["present", "missing"].includes(status.provider?.state));
      let etag = status.provider.etag;
      const ticket = status.upload;
      if (status.provider.state === "missing") {
        if (!file) file = await checkedCiphertext(path.join(manifests.directory(id), "ciphertext.lilyenc"), content);
        guard(item);
        let parts = [], uploadId = item.checkpoint.uploadId;
        if (uploadId) {
          let marker = 0;
          try {
            do {
              const page = await multipart.listParts({ ticket, uploadId, marker }); guard(item);
              ensure(page?.uploadId === uploadId && Array.isArray(page.parts) && (page.marker === 0 || page.marker > marker));
              parts.push(...page.parts); marker = page.marker;
              ensure(parts.length <= Math.ceil(content.ciphertextSize / MAX_PART_BYTES));
            } while (marker);
          } catch (error) {
            if (error.code !== "COLLAB_TRANSFER_SESSION_MISSING") throw error;
            // A missing upload ID can also mean complete committed. Re-probe
            // instead of treating that provider error as absence of the object.
            const fresh = await objectClient.status({ deviceId, objectId: item.checkpoint.objectId, clientCommandId: `${item.commandIds.init}:status` });
            guard(item);
            ensure(fresh?.objectId === item.checkpoint.objectId && fresh.ciphertextSize === content.ciphertextSize && fresh.ciphertextSha256 === content.ciphertextSha256);
            if (["verified", "bound"].includes(fresh.state)) return view(save(item, { state: fresh.state }));
            ensure(fresh.state === "uploading" && ["present", "missing"].includes(fresh.provider?.state));
            if (fresh.provider.state === "present") etag = fresh.provider.etag;
            else { uploadId = null; parts = []; }
          }
        }
        if (!etag) {
          if (!uploadId) {
            const session = await multipart.initiate({ ticket }); guard(item);
            ensure(safeId(session?.uploadId)); uploadId = session.uploadId;
            item = save(item, { uploadId, state: "uploading", completedParts: [] });
          }
          const byNumber = new Map();
          for (const part of parts) {
            const size = Math.min(MAX_PART_BYTES, content.ciphertextSize - (part.partNumber - 1) * MAX_PART_BYTES);
            ensure(Number.isSafeInteger(part.partNumber) && part.partNumber >= 1 && size > 0 && part.size === size && safeId(part.etag) && !byNumber.has(part.partNumber));
            byNumber.set(part.partNumber, part.etag);
          }
          const completed = () => [...byNumber].sort((a, b) => a[0] - b[0]).map(([number, value]) => ({ number, etag: value }));
          item = save(item, { state: "uploading", completedParts: completed() });
          for (let number = 1; number <= Math.ceil(content.ciphertextSize / MAX_PART_BYTES); number++) {
            if (byNumber.has(number)) continue;
            guard(item);
            const position = (number - 1) * MAX_PART_BYTES;
            const bytes = Buffer.alloc(Math.min(MAX_PART_BYTES, content.ciphertextSize - position));
            for (let offset = 0; offset < bytes.length;) {
              const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, position + offset);
              if (!bytesRead) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED"); offset += bytesRead;
            }
            guard(item);
            const result = await multipart.uploadPart({ ticket, uploadId, partNumber: number, bytes }); guard(item);
            ensure(result?.partNumber === number && safeId(result.etag)); byNumber.set(number, result.etag);
            item = save(item, { completedParts: completed() });
          }
          const result = await multipart.complete({ ticket, uploadId, parts: completed().map(({ number, etag: value }) => ({ partNumber: number, etag: value })) });
          guard(item); etag = result?.etag;
        }
      }
      ensure(safeId(etag)); item = save(item, { state: "uploaded", etag });
      const verified = await objectClient.complete({ deviceId, objectId: item.checkpoint.objectId, clientCommandId: item.commandIds.complete,
        etag, ciphertextSize: content.ciphertextSize, ciphertextSha256: content.ciphertextSha256 });
      guard(item); ensure(verified?.objectId === item.checkpoint.objectId && verified.state === "verified");
      return view(save(item, { state: "verified" }));
    } catch (error) {
      return failureView(error, item);
    } finally { await file?.close(); }
  }
  return Object.freeze({
    stop() { stopped = true; },
    list() {
      if (stopped) return { transfers: [] };
      const scan = manifests.scan();
      return { transfers: scan.transfers.filter((item) => { try { guard(item, true, false); return true; } catch { return false; } })
        .map((item) => deviceChanged(item) ? { ...view(item), state: "paused", code: "COLLAB_TRANSFER_DEVICE_CHANGED", retryable: false } : view(item)), unrecognizedCount: scan.unrecognized.length };
    },
    pause(id) {
      let item = manifests.read(id); guard(item, true);
      if (["verified", "bound", "ready", "cancelled"].includes(item.checkpoint.state)) return view(item);
      item = manifests.update({ id, expectedRevision: item.revision, checkpoint: { ...item.checkpoint, state: "paused",
        schedule: { ...(item.checkpoint.schedule || { attempts: 0, nextAttemptAt: 0 }), enabled: false } } });
      paused.add(id);
      return view(item);
    },
    async cancel(id) {
      let item = manifests.read(id); guard(item, true);
      if (item.checkpoint.state === "bound") return { ...view(item), ok: false, code: "COLLAB_TRANSFER_ALREADY_BOUND" };
      if (item.checkpoint.state !== "cancelled") item = manifests.update({ id, expectedRevision: item.revision, checkpoint: { ...item.checkpoint, state: "cancelled" } });
      cancelled.add(id);
      if (item.direction === "upload" && item.checkpoint.objectId) {
        try {
          await objectClient.abort({ deviceId, objectId: item.checkpoint.objectId, clientCommandId: `${item.commandIds.init}:abort` });
          guard(item, true);
          return { ...view(item), serverCancelled: true };
        } catch {
          try { guard(item, true); }
          catch (error) { return failureView(error, item); }
          return { ...view(item), serverCancelled: false };
        }
      }
      // An in-flight init may commit later; cancellation only guarantees local
      // fencing. Server orphan cleanup owns objects whose ACK was never known.
      return { ...view(item), serverCancelled: false };
    },
    async prepareUpload({ inputPath, conversationId, scopeId, purpose = "attachment", originalName, mimeType = "application/octet-stream" }) {
      guard({ conversationId, scopeId, direction: "upload", purpose });
      let item = manifests.create({ scopeId, conversationId, direction: "upload", purpose });
      item = save(item, { state: "encrypting", deviceId });
      const key = crypto.randomBytes(32);
      try {
        const result = await encryptFile({ inputPath, outputPath: path.join(manifests.directory(item.id), "ciphertext.lilyenc"), key, fileName: originalName || path.basename(inputPath), contentType: mimeType });
        try {
          guard(item);
          if (result.ciphertextSize > (purpose === "workspace" ? 256 * 1024 ** 2 : 1024 ** 3)) throw fail("COLLAB_OBJECT_SIZE_INVALID");
          item = save(item, { state: "prepared", content: { dek: key.toString("base64"), originalName: result.metadata.fileName, mimeType,
            ciphertextSize: result.ciphertextSize, ciphertextSha256: result.ciphertextSha256 } });
          return view(item);
        } finally { result.key.fill(0); }
      } finally { key.fill(0); }
    },
    resumeUpload(id) {
      if (running.has(id)) return running.get(id);
      paused.delete(id);
      const promise = resume(id).finally(() => { if (running.get(id) === promise) running.delete(id); });
      running.set(id, promise); return promise;
    },
    prepareDownload({ objectId, conversationId, scopeId, purpose = "attachment" }) {
      guard({ conversationId, scopeId, direction: "download", purpose }); ensure(safeId(objectId));
      return view(save(manifests.create({ scopeId, conversationId, direction: "download", purpose }), { state: "prepared", objectId }));
    },
    resumeDownload(id) {
      if (running.has(id)) return running.get(id);
      paused.delete(id);
      let item;
      const promise = (async () => {
        try {
          item = manifests.read(id); guard(item);
          item = await downloadTransfer({ item, manifests, objectClient, deviceId, fetchImpl, guard, save: (previous, patch) => { item = save(previous, patch); return item; } });
          return view(item);
        } catch (error) { return failureView(error, item); }
      })().finally(() => { if (running.get(id) === promise) running.delete(id); });
      running.set(id, promise); return promise;
    },
    async verifiedFile(id) { return verifiedDownloadFile({ manifests, item: manifests.read(id), guard }); },
  });
}

module.exports = { createTransferManager };
