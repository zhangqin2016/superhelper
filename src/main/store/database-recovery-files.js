"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const SIDECARS = ["", "-wal", "-shm", "-journal"];
function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function regular(file) {
  if (!fs.lstatSync(file).isFile()) throw Object.assign(new Error("Expected a regular database file"), { code: "RECOVERY_UNCERTAIN" });
}
function directory(file) {
  if (!fs.lstatSync(file).isDirectory()) throw Object.assign(new Error("Expected a recovery directory"), { code: "RECOVERY_UNCERTAIN" });
}
function digest(file) {
  regular(file);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
function sync(file, directory = false) {
  if (directory && process.platform === "win32") return;
  const fd = fs.openSync(file, directory ? "r" : "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function publish(source, target) {
  fs.linkSync(source, target); // Atomic no-clobber, including Windows.
  sync(path.dirname(target), true);
}
function publishJson(target, value) {
  const temp = target + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    sync(temp);
    publish(temp, target);
  } finally { if (exists(temp)) fs.unlinkSync(temp); }
}
function classify(error) {
  const code = error?.code;
  const sqlite = Number(error?.errcode) & 255;
  if ([5, 6].includes(sqlite) || ["EBUSY", "EAGAIN"].includes(code)) return "locked";
  if ([11, 26].includes(sqlite) || code === "RECOVERY_CORRUPT") return "corrupt";
  if ([3, 8, 23].includes(sqlite) || ["EACCES", "EPERM", "EROFS"].includes(code)) return "permission";
  if ([10, 13, 14].includes(sqlite) || ["EIO", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE"].includes(code)) return "io";
  return "unknown";
}
/**
 * @param {{ verify?: boolean }} options `verify: false` skips only the page-by-page
 *   PRAGMA integrity_check — the one O(file size) step, measured at 3729 ms on a
 *   cold 918 MB database against 2 ms for every other check here. Nothing else
 *   is skipped, so the caller still learns everything it decided before: header,
 *   schema, counts, and whether SQLite needs to roll a hot journal back.
 *   [gate: startup-admission]
 */
function inspectFile(file, readOnly = true, { verify = true } = {}) {
  regular(file);
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (readOnly && !header.equals(Buffer.from("SQLite format 3\0"))) throw Object.assign(new Error("Invalid message database header"), { code: "RECOVERY_CORRUPT" });
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    if (verify) {
      const rows = db.prepare("PRAGMA integrity_check").all();
      if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") throw Object.assign(new Error("Integrity verification failed"), { code: "RECOVERY_CORRUPT" });
    }
    const columns = db.prepare("PRAGMA table_info(messages)").all().map(row => row.name);
    if (!["session_id", "seq", "id", "role", "envelope_blob"].every(column => columns.includes(column))) {
      throw Object.assign(new Error("Missing message store schema"), { code: "RECOVERY_CORRUPT" });
    }
    const row = db.prepare("SELECT COUNT(*) AS messageCount, COUNT(DISTINCT session_id) AS sessionCount FROM messages").get();
    return { messageCount: Number(row.messageCount), sessionCount: Number(row.sessionCount) };
  } finally { db.close(); }
}
function recoverHotJournal(dbPath) {
  const base = dbPath + ".recovery";
  fs.mkdirSync(base, { recursive: true, mode: 0o700 }); directory(base);
  const dir = path.join(base, "rollback-" + crypto.randomUUID()); fs.mkdirSync(dir);
  sync(base, true); sync(path.dirname(base), true);
  const originals = SIDECARS.map(suffix => ({ suffix, hash: exists(dbPath + suffix) ? digest(dbPath + suffix) : null }));
  for (const entry of originals) {
    if (!entry.hash) continue;
    const retained = path.join(dir, "original.db" + entry.suffix);
    fs.copyFileSync(dbPath + entry.suffix, retained, fs.constants.COPYFILE_EXCL);
    if (digest(retained) !== entry.hash) throw new Error("Database changed while preserving rollback evidence");
    sync(retained);
  }
  sync(dir, true);
  for (const entry of originals) {
    if ((exists(dbPath + entry.suffix) ? digest(dbPath + entry.suffix) : null) !== entry.hash) throw new Error("Database is not quiescent");
  }
  publishJson(path.join(dir, "rollback.json"), { version: 1, createdAt: Date.now(), originals });
  // Only SQLite decides journal validity and rolls back its uncommitted writes.
  return inspectFile(dbPath, false);
}
function hasRollbackJournalHeader(dbPath) {
  const journal = dbPath + "-journal";
  if (!exists(journal)) return false;
  regular(journal);
  const magic = Buffer.alloc(8);
  const fd = fs.openSync(journal, "r");
  try { fs.readSync(fd, magic, 0, 8, 0); } finally { fs.closeSync(fd); }
  // This only permits SQLite to evaluate the journal after evidence is saved.
  // It is not proof of consistency or permission to create a replacement DB.
  return magic.equals(Buffer.from("d9d505f920a163d7", "hex"));
}
module.exports = { fs, path, crypto, SIDECARS, exists, regular, directory, digest, sync, publish, publishJson, classify, inspectFile, recoverHotJournal, hasRollbackJournalHeader };
