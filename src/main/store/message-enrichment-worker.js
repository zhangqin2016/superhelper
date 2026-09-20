"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { pack, unpack } = require("./message-envelope");
const { backfillMessageArtifacts } = require("../session-artifact-backfill");
const { flagKey, cursorKey, sessionTime, versionsUsable } = require("../session-enrichment");
const { applyEnrichmentCommit } = require("./message-enrichment-commit");

// Derivation/compression happen outside a write transaction. The conditional
// update cannot overwrite a live edit, deletion, rewind, or replacement record.
function prepareRow(row, workspacePath) {
  const message = unpack(row.envelope_blob);
  return backfillMessageArtifacts(message, workspacePath) ? pack(message) : null;
}

function enrichRow(db, row, workspacePath, beforeCommit) {
  const next = prepareRow(row, workspacePath);
  if (!next) return false;
  beforeCommit?.();
  return applyEnrichmentCommit(db, { type: "row", row, next });
}

async function run({ filePath, sessions, versions }, report, commit) {
  if (!versionsUsable(versions)) throw new Error("NO_SCHEMA_VERSIONS");
  const db = new DatabaseSync(filePath, { readOnly: Boolean(commit) });
  db.exec("PRAGMA busy_timeout=1000");
  const meta = key => db.prepare("SELECT value FROM schema_meta WHERE key=?").get(key)?.value;
  const apply = commit || (change => applyEnrichmentCommit(db, change));
  const setMeta = (key, value) => apply({ type: "meta", key, value });
  const summary = { scanned: 0, enriched: 0, failed: 0, skipped: 0, total: 0 };
  try {
    const pending = sessions.filter(s => s.id && s.workspacePath && !meta(flagKey(s.id, versions))).sort((a, b) => sessionTime(b) - sessionTime(a));
    for (const s of pending) summary.total += db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id=? AND seq>?").get(s.id, Number(meta(cursorKey(s.id, versions))) || 0).n;
    for (const session of pending) {
      const cursor = cursorKey(session.id, versions);
      let seq = Number(meta(cursor)) || 0;
      try {
        for (;;) {
          // Do not retain an iterator/read transaction while deriving or writing.
          const row = db.prepare("SELECT session_id,seq,id,envelope_blob FROM messages WHERE session_id=? AND seq>? ORDER BY seq LIMIT 1").get(session.id, seq);
          if (!row) {
            await setMeta(flagKey(session.id, versions), `1:${seq}`);
            await apply({ type: "deleteMeta", key: cursor });
            break;
          }
          try {
            const next = prepareRow(row, session.workspacePath);
            if (next) { await apply({ type: "row", row, next }); summary.enriched++; }
          } catch (error) {
            if (error.message === "ENRICHMENT_CONCURRENT_CHANGE" || error.code === "ERR_SQLITE_ERROR") throw error;
            summary.skipped++;
            report({ type: "warning", sessionId: session.id, error: error.message });
          }
          seq = row.seq;
          await setMeta(cursor, seq);
          summary.scanned++;
          report({ type: "progress", phase: "working", kind: "enrichment", done: summary.scanned, total: summary.total });
          await new Promise(resolve => setTimeout(resolve, 8));
        }
      } catch (error) {
        // Leave the cursor before an uncommitted/conflicted record; next launch
        // can resume. Display reads derive fresh artifacts independently.
        summary.failed++;
        report({ type: "warning", sessionId: session.id, error: error.message });
      }
    }
    report({ type: "done", ...summary });
    return summary;
  } finally { db.close(); }
}

if (parentPort) {
  let sequence = 0;
  const pending = new Map();
  parentPort.on("message", ({ commitId, error, result }) => {
    const request = pending.get(commitId);
    if (!request) return;
    pending.delete(commitId);
    if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }));
    else request.resolve(result);
  });
  const commit = change => new Promise((resolve, reject) => {
    const commitId = ++sequence;
    pending.set(commitId, { resolve, reject });
    parentPort.postMessage({ type: "commit", commitId, change });
  });
  run(workerData, value => parentPort.postMessage(value), commit).catch(error => {
    parentPort.postMessage({ type: "error", error: error.message });
  }).finally(() => parentPort.close());
}

module.exports = { enrichRow, run };
