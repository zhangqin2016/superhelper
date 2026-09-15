"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

/** Publish a verified, standalone SQLite snapshot without replacing any file.
 * Never copy a live main file or transplant its WAL onto a different layout.
 * The private temporary directory also isolates SQLite's temporary sidecars.
 */
function createSqliteSnapshot(sourcePath, destinationPath, { requireMessageStore = false } = {}) {
  if (fs.existsSync(destinationPath) || ["-wal", "-shm", "-journal"].some(
    suffix => fs.existsSync(destinationPath + suffix),
  )) throw new Error("SQLite snapshot destination or recovery journal already exists");
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const temporaryDir = fs.mkdtempSync(path.join(path.dirname(destinationPath), ".sqlite-snapshot-"));
  const temporaryPath = path.join(temporaryDir, "snapshot.db");
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      source.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;");
      source.prepare("VACUUM INTO ?").run(temporaryPath);
    } finally { source.close(); }

    const copy = new DatabaseSync(temporaryPath);
    try {
      copy.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      const results = copy.prepare("PRAGMA quick_check").all();
      if (results.length !== 1 || Object.values(results[0])[0] !== "ok") {
        throw new Error("SQLite snapshot integrity verification failed");
      }
      if (requireMessageStore) {
        // SQLite accepts zero-byte files as empty databases. Integrity alone
        // therefore cannot establish that a backup contains a message store.
        copy.prepare("SELECT session_id, seq, id, role, envelope_blob FROM messages LIMIT 0").all();
      }
    } finally { copy.close(); }

    const fd = fs.openSync(temporaryPath, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (["-wal", "-shm", "-journal"].some(suffix => fs.existsSync(destinationPath + suffix))) {
      throw new Error("SQLite snapshot destination recovery journal appeared");
    }
    // link is an atomic no-clobber publication on the same filesystem. All
    // SQLite handles are closed; remove the private name before any reopening.
    // If unsupported or occupied, leave the source in place for a later retry.
    fs.linkSync(temporaryPath, destinationPath);
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(path.dirname(destinationPath), "r");
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

/** A crash between the old compactor's two renames must not create an empty DB. */
function restoreInterruptedMessageCompaction(dbPath) {
  if (!dbPath || dbPath === ":memory:" || fs.existsSync(dbPath)) return false;
  if (["-wal", "-shm", "-journal"].some(suffix => fs.existsSync(dbPath + suffix))) {
    throw new Error("Message database is missing but recovery journals remain; original files retained");
  }
  const backup = `${dbPath}.precompact`;
  if (!fs.existsSync(backup)) return false;
  if (["-wal", "-shm", "-journal"].some(suffix => fs.existsSync(backup + suffix))) {
    throw new Error("Interrupted database compaction has ambiguous recovery journals; original files retained");
  }
  createSqliteSnapshot(backup, dbPath, { requireMessageStore: true });
  return true;
}

module.exports = { createSqliteSnapshot, restoreInterruptedMessageCompaction };
