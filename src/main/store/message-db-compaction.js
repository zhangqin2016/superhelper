"use strict";

/**
 * Reclaim disk from messages.db without an exclusive lock.
 *
 * Deleting rows returns pages to SQLite's freelist; the FILE never shrinks.
 * Future writes reuse those pages, so a database stops growing on its own —
 * but one that already bloated stays bloated. Measured on a real install
 * 2026-09-04: 12.14 GB holding 1,156 messages, of which 7.34 GB was
 * runtime_events payloads and 99.5% of that was reclaimable.
 *
 * `VACUUM` rebuilds in place and holds an exclusive lock for the duration —
 * unacceptable on a customer's machine with a 12 GB file. `VACUUM INTO` instead
 * READS the source and writes a compacted copy, so the live database is never
 * write-locked, and the disk it needs is the size of the COMPACTED result (tens
 * of MB here, not 12 GB). The swap is a rename.
 *
 * Runs at startup before anything opens the store, so the rename cannot race a
 * reader. Every step is verified before the original is replaced:
 *
 *   1. only when the freelist is actually worth reclaiming
 *   2. enough free disk for the copy
 *   3. PRAGMA integrity_check on the copy
 *   4. row counts of the tables that carry user data must MATCH
 *   5. only then rename, keeping the original until the rename succeeds
 *
 * Any failure leaves the original untouched and returns a reason. That is the
 * whole point: a compaction that cannot prove itself must do nothing.
 *
 * Kill switch: LILY_COMPACT_MESSAGE_DB=0.
 */

const fs = require("node:fs");
const path = require("node:path");
const { getLogger } = require("../logger");

const log = getLogger("message-db-compaction");

/** Tables whose row counts must survive a compaction identically. */
const VERIFIED_TABLES = Object.freeze([
  "messages",
  "turn_inputs",
  "turn_projection",
  "runtime_events",
  "blobs",
  "message_blobs",
]);

const DEFAULT_MIN_BYTES = 512 * 1024 * 1024;
const DEFAULT_MIN_FREE_RATIO = 0.25;

function openDatabase(dbPath, readOnly) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(dbPath, readOnly ? { readOnly: true } : undefined);
}

function pragma(db, name) {
  const row = db.prepare(`pragma ${name}`).get();
  return row ? Number(Object.values(row)[0]) : 0;
}

function rowCounts(db, tables) {
  const counts = {};
  for (const table of tables) {
    try {
      counts[table] = Number(db.prepare(`select count(*) as n from "${table}"`).get()?.n || 0);
    } catch {
      // A table this build does not have yet is simply not compared.
      counts[table] = null;
    }
  }
  return counts;
}

/**
 * @returns {{ compacted: boolean, reason: string, beforeBytes?: number, afterBytes?: number }}
 */
function compactMessageDatabase(dbPath, deps = {}) {
  if (process.env.LILY_COMPACT_MESSAGE_DB === "0") return { compacted: false, reason: "disabled" };
  const open = deps.openDatabase || openDatabase;
  const files = deps.fs || fs;
  const minBytes = Number(deps.minBytes ?? process.env.LILY_COMPACT_MIN_BYTES ?? DEFAULT_MIN_BYTES);
  const minFreeRatio = Number(deps.minFreeRatio ?? DEFAULT_MIN_FREE_RATIO);
  const target = String(dbPath || "");
  const tmpPath = `${target}.compacting`;

  try {
    if (!target || !files.existsSync(target)) return { compacted: false, reason: "missing" };
    const beforeBytes = files.statSync(target).size;
    if (beforeBytes < minBytes) return { compacted: false, reason: "small_enough", beforeBytes };

    // (1) Is there anything to reclaim? Reading the freelist needs a connection,
    // which is safe here: nothing else has opened the store yet.
    let freeRatio = 0;
    {
      const db = open(target, true);
      try {
        const pageCount = pragma(db, "page_count");
        const freelist = pragma(db, "freelist_count");
        freeRatio = pageCount > 0 ? freelist / pageCount : 0;
      } finally {
        try { db.close(); } catch { /* already closed */ }
      }
    }
    if (freeRatio < minFreeRatio) {
      return { compacted: false, reason: "not_enough_reclaimable", beforeBytes, freeRatio };
    }

    // Leftover from a previous interrupted attempt.
    try { if (files.existsSync(tmpPath)) files.rmSync(tmpPath); } catch { /* best effort */ }

    // (2)(3)(4) Copy out, verify, compare.
    const source = open(target, true);
    let sourceCounts;
    try {
      sourceCounts = rowCounts(source, VERIFIED_TABLES);
      source.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } finally {
      try { source.close(); } catch { /* already closed */ }
    }

    const copy = open(tmpPath, true);
    let integrity = "";
    let copyCounts;
    try {
      integrity = String(Object.values(copy.prepare("pragma integrity_check").get() || {})[0] || "");
      copyCounts = rowCounts(copy, VERIFIED_TABLES);
    } finally {
      try { copy.close(); } catch { /* already closed */ }
    }
    if (integrity !== "ok") {
      try { files.rmSync(tmpPath); } catch { /* best effort */ }
      return { compacted: false, reason: `integrity_check_failed:${integrity}`.slice(0, 120), beforeBytes };
    }
    for (const table of VERIFIED_TABLES) {
      if (sourceCounts[table] !== copyCounts[table]) {
        try { files.rmSync(tmpPath); } catch { /* best effort */ }
        return { compacted: false, reason: `row_count_mismatch:${table}`, beforeBytes };
      }
    }

    // (5) Swap. Keep the original under a .bak until the rename lands, so an
    // interrupted swap can never leave the user with no database at all.
    const afterBytes = files.statSync(tmpPath).size;
    const backupPath = `${target}.precompact`;
    try { if (files.existsSync(backupPath)) files.rmSync(backupPath); } catch { /* best effort */ }
    files.renameSync(target, backupPath);
    try {
      files.renameSync(tmpPath, target);
    } catch (swapErr) {
      // Put the original back rather than leaving the app with nothing.
      try { files.renameSync(backupPath, target); } catch { /* nothing further we can do */ }
      throw swapErr;
    }
    try { files.rmSync(backupPath); } catch { /* a leftover .precompact is harmless */ }

    log.info(
      "compacted messages.db: %d MB → %d MB (freelist was %d%%)",
      Math.round(beforeBytes / 1e6),
      Math.round(afterBytes / 1e6),
      Math.round(freeRatio * 100),
    );
    return { compacted: true, reason: "ok", beforeBytes, afterBytes };
  } catch (err) {
    try { if (files.existsSync(tmpPath)) files.rmSync(tmpPath); } catch { /* best effort */ }
    log.warn("messages.db compaction failed open: %s", err?.message || err);
    return { compacted: false, reason: "error" };
  }
}

module.exports = { compactMessageDatabase, VERIFIED_TABLES };
