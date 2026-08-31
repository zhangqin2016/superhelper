"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createTransferManifestStore } = require("./transfer-manifest");

const MAX_BYTES = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => Object.assign(new Error("COLLAB_ATTACHMENT_INTENT_UNAVAILABLE"), { code: "COLLAB_ATTACHMENT_INTENT_UNAVAILABLE", retryable: false });
const accountFile = (accountId) => crypto.createHash("sha256").update(String(accountId)).digest("hex");

function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function checkedDirectory(value) {
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
  }
  const stat = fs.lstatSync(value);
  if (process.platform !== "win32" && (stat.mode & 0o077)) throw fail();
  return stat;
}

function privateDirectory(value, { create = false } = {}) {
  try { return checkedDirectory(value); }
  catch (error) {
    if (error?.code !== "ENOENT") throw fail();
    if (!create) return null;
  }
  try {
    checkedDirectory(path.dirname(value));
    fs.mkdirSync(value, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw fail();
  }
  try {
    return checkedDirectory(value);
  } catch { throw fail(); }
}

function syncDirectory(value) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(value, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function markerPath(rootPath, accountId, { create = false } = {}) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath || path.basename(rootPath) !== "collaboration-transfer") throw fail();
  if (!privateDirectory(rootPath)) return null;
  const directory = path.join(rootPath, "retirement");
  if (!privateDirectory(directory, { create })) return null;
  return { directory, filename: path.join(directory, `${accountFile(accountId)}.json`) };
}

function readFile(filename) {
  let fd;
  try {
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw fail();
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const after = fs.fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile() || after.nlink !== 1 || after.size > MAX_BYTES) throw fail();
    return fs.readFileSync(fd, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw fail();
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function decode({ keyring, accountId, filename }) {
  const bytes = readFile(filename);
  if (bytes === null) return [];
  try {
    const outer = JSON.parse(bytes);
    if (!outer || Object.getPrototypeOf(outer) !== Object.prototype || outer.version !== 1 || outer.scopeId !== "personal" || !outer.envelope) throw fail();
    const value = JSON.parse(keyring.decrypt({ accountId, scopeId: "personal", recordId: "transfer-retirement:v1", envelope: outer.envelope }));
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || value.version !== 1 || !Array.isArray(value.retiredTransferIds)
      || value.retiredTransferIds.length > 100000 || new Set(value.retiredTransferIds).size !== value.retiredTransferIds.length
      || value.retiredTransferIds.some((id) => !UUID.test(id))) throw fail();
    return value.retiredTransferIds;
  } catch { throw fail(); }
}

function write({ keyring, accountId, marker, retiredTransferIds }) {
  let bytes;
  try {
    bytes = JSON.stringify({ version: 1, scopeId: "personal", envelope: keyring.encrypt({ accountId, scopeId: "personal", recordId: "transfer-retirement:v1",
      plaintext: JSON.stringify({ version: 1, retiredTransferIds }) }) });
  } catch { throw fail(); }
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail();
  const temp = path.join(marker.directory, `.${accountFile(accountId)}.${crypto.randomUUID()}.tmp`);
  let fd, tempIdentity;
  try {
    const directoryIdentity = privateDirectory(marker.directory);
    fd = fs.openSync(temp, "wx", 0o600); tempIdentity = fs.fstatSync(fd);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const stat = fs.lstatSync(temp);
    if (!sameFile(tempIdentity, stat) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !sameFile(directoryIdentity, privateDirectory(marker.directory))) throw fail();
    fs.renameSync(temp, marker.filename); syncDirectory(marker.directory);
  } catch {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* nothing */ }
    try { if (tempIdentity && sameFile(tempIdentity, fs.lstatSync(temp))) fs.unlinkSync(temp); } catch { /* nothing */ }
    throw fail();
  }
}

function retiredTransferIds({ rootPath, accountId, keyring } = {}) {
  const marker = markerPath(rootPath, accountId);
  return marker ? new Set(decode({ keyring, accountId, filename: marker.filename })) : new Set();
}

/** Record only manifests that are presently authenticated with the still-live
 * Team key.  The marker is durable before the caller destroys that key. */
function retireScopeTransfers({ rootPath, accountId, keyring, scopeId } = {}) {
  if (!rootPath || typeof scopeId !== "string" || !scopeId.startsWith("team:")) return { retired: 0 };
  // A missing retirement directory is normal on the first revoked Team.  Do
  // not create it until after authenticated manifest enumeration succeeds.
  const marker = markerPath(rootPath, accountId);
  const accountDirectory = path.join(rootPath, accountFile(accountId));
  if (!privateDirectory(accountDirectory)) return { retired: 0 };
  const manifests = createTransferManifestStore({ rootPath, accountId, keyring });
  const ids = manifests.scan().transfers.filter((item) => item.scopeId === scopeId).map((item) => item.id);
  if (ids.length === 0) return { retired: 0 };
  const existing = marker ? decode({ keyring, accountId, filename: marker.filename }) : [];
  const next = [...new Set([...existing, ...ids])];
  write({ keyring, accountId, marker: markerPath(rootPath, accountId, { create: true }), retiredTransferIds: next });
  return { retired: ids.length };
}

module.exports = { retiredTransferIds, retireScopeTransfers };
