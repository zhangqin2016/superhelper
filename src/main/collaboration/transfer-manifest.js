"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_BYTES = 128 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FILES = new Set(["manifest.json", "ciphertext.part", "ciphertext.lilyenc", "plaintext.part", "plaintext.verified"]);
const error = (code) => Object.assign(new Error(code), { code, retryable: false });
const unsafe = () => error("COLLAB_TRANSFER_UNSAFE_PATH");
const invalid = () => error("COLLAB_TRANSFER_MANIFEST_INVALID");
const unavailable = () => error("COLLAB_TRANSFER_UNAVAILABLE");
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function assertDirectory(value, { privateMode = false } = {}) {
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe();
  }
  const stat = fs.lstatSync(value);
  if (privateMode && process.platform !== "win32" && (stat.mode & 0o077)) throw unsafe();
  return stat;
}

function syncDirectory(value) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(value, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function privateDirectory(value) {
  try { fs.mkdirSync(value, { mode: 0o700 }); syncDirectory(path.dirname(value)); } catch (cause) { if (cause.code !== "EEXIST") throw cause; }
  return assertDirectory(value, { privateMode: true });
}

function safeCheckpoint(value) {
  // This closed journal vocabulary is deliberately not a serialized HTTP
  // response. Fresh network capabilities must be reacquired after restart.
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !["state", "objectId", "completedParts"].includes(key))) throw invalid();
  if (value.state !== undefined && !["prepared", "encrypting", "uploading", "uploaded", "verifying", "verified", "downloading", "decrypting", "ready", "paused", "failed", "cancelled"].includes(value.state)) throw invalid();
  if (value.objectId !== undefined && (typeof value.objectId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.objectId))) throw invalid();
  if (value.completedParts !== undefined) {
    if (!Array.isArray(value.completedParts) || value.completedParts.length > 1000) throw invalid();
    const seen = new Set();
    for (const part of value.completedParts) {
      if (!part || Object.getPrototypeOf(part) !== Object.prototype || Object.keys(part).some((key) => !["number", "etag"].includes(key))
          || !Number.isSafeInteger(part.number) || part.number < 1 || part.number > 1000 || seen.has(part.number)
          || typeof part.etag !== "string" || !/^[a-zA-Z0-9_=-]{1,200}$/.test(part.etag)) throw invalid();
      seen.add(part.number);
    }
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_BYTES / 2) throw invalid();
  return JSON.parse(encoded);
}

/** Main-only ownership journal, not a network transport or authorization grant.
 * One main process owns mutations; revision CAS also detects stale callbacks.
 * Private directories and identity checks reject replacement between operations;
 * portable Node cannot sandbox a hostile same-user process racing ancestor rename.
 * Process-restart recovery is covered; machine power-loss recovery additionally
 * depends on the OS-backed keyring's own persistence guarantees.
 */
function createTransferManifestStore({ rootPath, accountId, keyring } = {}) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath || path.basename(rootPath) !== "collaboration-transfer") throw unsafe();
  if (!validId(accountId) || typeof keyring?.encrypt !== "function" || typeof keyring?.decrypt !== "function") throw invalid();
  assertDirectory(path.dirname(rootPath));
  const rootIdentity = privateDirectory(rootPath);
  const accountPath = path.join(rootPath, crypto.createHash("sha256").update(accountId).digest("hex"));
  const accountIdentity = privateDirectory(accountPath);
  function assertRoot() {
    if (!sameFile(rootIdentity, assertDirectory(rootPath, { privateMode: true })) || !sameFile(accountIdentity, assertDirectory(accountPath, { privateMode: true }))) throw unsafe();
  }
  function directory(id) {
    if (typeof id !== "string" || !UUID.test(id)) throw unsafe();
    assertRoot();
    const folder = path.join(accountPath, id);
    try { assertDirectory(folder, { privateMode: true }); } catch (cause) { if (cause.code === "ENOENT") throw unavailable(); throw cause; }
    return folder;
  }
  function read(id) {
    const folder = directory(id);
    let fd;
    try {
      const filename = path.join(folder, "manifest.json"), before = fs.lstatSync(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw unavailable();
      fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const stat = fs.fstatSync(fd);
      if (!sameFile(before, stat) || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw unavailable();
      const outer = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (outer.version !== 1 || !validId(outer.scopeId)) throw unavailable();
      const value = JSON.parse(keyring.decrypt({ accountId, scopeId: outer.scopeId, recordId: `transfer:${id}`, envelope: outer.envelope }));
      if (value.id !== id || value.accountId !== accountId || value.scopeId !== outer.scopeId || !validId(value.conversationId)
          || !["upload", "download"].includes(value.direction) || !["attachment", "workspace"].includes(value.purpose)
          || !Number.isSafeInteger(value.revision) || value.revision < 1
          || !["init", "complete", "send"].every((action) => UUID.test(value.commandIds?.[action]))) throw unavailable();
      safeCheckpoint(value.checkpoint);
      return value;
    } catch { throw unavailable(); } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function write(folder, value) {
    const bytes = JSON.stringify({ version: 1, scopeId: value.scopeId,
      envelope: keyring.encrypt({ accountId, scopeId: value.scopeId, recordId: `transfer:${value.id}`, plaintext: JSON.stringify(value) }) });
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw invalid();
    const temp = path.join(folder, `.manifest-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, "wx", 0o600), identity = fs.fstatSync(fd);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      assertRoot(); assertDirectory(folder, { privateMode: true });
      fs.renameSync(temp, path.join(folder, "manifest.json"));
      // Durability of the rename matters for a crash immediately after upload.
      syncDirectory(folder);
    } finally {
      try { if (sameFile(identity, fs.lstatSync(temp))) fs.unlinkSync(temp); } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    }
  }
  return Object.freeze({
    directory,
    create({ scopeId, conversationId, direction, purpose } = {}) {
      if (!validId(scopeId) || !validId(conversationId) || !["upload", "download"].includes(direction) || !["attachment", "workspace"].includes(purpose)) throw invalid();
      assertRoot();
      const id = crypto.randomUUID(), folder = path.join(accountPath, id);
      fs.mkdirSync(folder, { mode: 0o700 });
      syncDirectory(accountPath);
      const value = { id, accountId, scopeId, conversationId, direction, purpose, revision: 1,
        commandIds: Object.fromEntries(["init", "complete", "send"].map((action) => [action, crypto.randomUUID()])), checkpoint: {} };
      // A failed create leaves only this random directory, reported by scan;
      // never recursively remove content we cannot authenticate after a crash.
      write(folder, value);
      return value;
    },
    read,
    update({ id, expectedRevision, checkpoint } = {}) {
      const next = safeCheckpoint(checkpoint), previous = read(id);
      if (previous.revision !== expectedRevision || previous.revision >= Number.MAX_SAFE_INTEGER) throw error("COLLAB_TRANSFER_CONFLICT");
      const value = { ...previous, revision: previous.revision + 1, checkpoint: next };
      write(directory(id), value);
      return value;
    },
    scan() {
      assertRoot();
      const transfers = [], unrecognized = [];
      for (const entry of fs.readdirSync(accountPath).sort()) {
        try { transfers.push(read(entry)); }
        catch { unrecognized.push({ entry, code: "COLLAB_TRANSFER_UNAVAILABLE" }); }
      }
      return { transfers, unrecognized };
    },
    remove(id) {
      read(id); // Authentication precedes even enumerating deletion targets.
      const folder = directory(id);
      const entries = fs.readdirSync(folder).map((name) => ({ name, stat: fs.lstatSync(path.join(folder, name)) }));
      // Validate the complete set before deleting anything; unknown or linked
      // files preserve the whole directory for explicit recovery/inspection.
      if (entries.some(({ name, stat }) => !FILES.has(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw unsafe();
      assertRoot();
      for (const { name, stat } of entries) if (!sameFile(stat, fs.lstatSync(path.join(folder, name)))) throw unsafe();
      for (const { name } of entries) fs.unlinkSync(path.join(folder, name));
      fs.rmdirSync(folder);
      return { removed: true };
    },
  });
}

module.exports = { createTransferManifestStore };
