"use strict";

const fs = require("node:fs");

function mergeMessageDatabase(srcPath, destPath) {
  const { createSqliteSnapshot, restoreInterruptedMessageCompaction } = require("./sqlite-snapshot");
  restoreInterruptedMessageCompaction(destPath);
  restoreInterruptedMessageCompaction(srcPath);
  if (!fs.existsSync(srcPath)) return false;
  if (!fs.existsSync(destPath)) {
    createSqliteSnapshot(srcPath, destPath);
    return true;
  }

  let srcDb = null;
  let destDb = null;
  try {
    const { openDatabase } = require("./sqlite-db");
    const { MIGRATIONS } = require("./schema");
    // Source is evidence, not a store to migrate/checkpoint in place.
    const { DatabaseSync } = require("node:sqlite");
    const source = new DatabaseSync(srcPath, { readOnly: true });
    srcDb = {
      get: (sql, ...args) => source.prepare(sql).get(...args),
      all: (sql, ...args) => source.prepare(sql).all(...args),
      close: () => source.close(),
    };
    destDb = openDatabase(destPath);
    destDb.migrate(MIGRATIONS);
    if (!srcDb.get("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'messages'")) {
      throw new Error("Legacy message merge cannot verify the messages table");
    }

    const rows = srcDb.all(
      `SELECT session_id, id, role, turn_id, created_at, preview, failed,
              terminal, cost_usd, duration_ms, envelope_blob
         FROM messages
        ORDER BY session_id ASC, seq ASC`,
    );
    const copiedSessions = new Set();
    let copied = 0;
    const insert = destDb.transaction(() => {
      for (const row of rows) {
        if (!row?.id || destDb.get("SELECT 1 FROM messages WHERE id = ? LIMIT 1", row.id)) continue;
        const next = destDb.get(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?",
          row.session_id,
        )?.seq || 1;
        destDb.run(
          `INSERT INTO messages
             (session_id, seq, id, role, turn_id, created_at, preview, failed,
              terminal, cost_usd, duration_ms, envelope_blob)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.session_id,
          next,
          row.id,
          row.role,
          row.turn_id,
          row.created_at,
          row.preview,
          row.failed,
          row.terminal,
          row.cost_usd,
          row.duration_ms,
          row.envelope_blob,
        );
        copiedSessions.add(row.session_id);
        copied += 1;
      }
      for (const sessionId of copiedSessions) {
        destDb.run(
          `INSERT INTO schema_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          `imported:${sessionId}`,
          "done:db-merge",
        );
      }
    });
    insert();
    if (copied > 0) {
      console.info(`[data-migration] merged ${copied} legacy message row(s) from ${srcPath}`);
      return true;
    }
  } catch (err) {
    console.warn("[data-migration] failed to merge legacy messages.db:", err?.message || err);
    throw err; // caller must retain the source and allow retry, never archive failure
  } finally {
    try { srcDb?.close?.(); } catch {}
    try { destDb?.close?.(); } catch {}
  }
  return false;
}

module.exports = { mergeMessageDatabase };
