"use strict";

function migrateContentHash(db) {
  db.exec(`
    ALTER TABLE source_stamps
    ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
  `);
}

function upsertSourceStamp(db, indexId, sourcePath, stamp = {}) {
  db.run(
    `INSERT INTO source_stamps (index_id, source_path, mtime_ms, size, content_hash, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(index_id, source_path) DO UPDATE SET
       mtime_ms=excluded.mtime_ms,
       size=excluded.size,
       content_hash=excluded.content_hash,
       indexed_at=excluded.indexed_at`,
    indexId,
    sourcePath,
    Math.floor(Number(stamp.mtimeMs || 0)),
    Math.floor(Number(stamp.size || 0)),
    String(stamp.contentHash || ""),
    new Date().toISOString(),
  );
}

function readSourceStamps(db, indexId) {
  const out = new Map();
  for (const row of db.all(
    "SELECT source_path, mtime_ms, size, content_hash FROM source_stamps WHERE index_id = ?",
    String(indexId || ""),
  )) {
    out.set(String(row.source_path), {
      mtimeMs: Number(row.mtime_ms || 0),
      size: Number(row.size || 0),
      contentHash: String(row.content_hash || ""),
    });
  }
  return out;
}

module.exports = {
  migrateContentHash,
  readSourceStamps,
  upsertSourceStamp,
};
