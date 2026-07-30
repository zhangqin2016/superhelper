"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  ownerScopeFromPrincipal,
} = require("../character-worlds/owner-scope");

const SCHEDULED_EVIDENCE_BATCH_SIZE = 1000;
const MAX_SCHEDULED_EVIDENCE_ROWS = 250_000;
const SCHEDULED_EVIDENCE_BATCH_SQL = `
  SELECT rowid AS evidence_rowid, id, owner_principal, execution_session_id,
         turn_id
  FROM scheduled_task_runs
  WHERE rowid > ?
  ORDER BY rowid
  LIMIT ?`;

function evidenceKey(sessionId, identity) {
  return `${sessionId}\u0000${identity}`;
}

function normalizedRow(row) {
  if (!row) return null;
  const id = typeof row.id === "string" && row.id ? row.id : null;
  const sessionId = typeof row.execution_session_id === "string"
    && row.execution_session_id
    ? row.execution_session_id
    : null;
  if (!id || !sessionId) return null;
  return Object.freeze({
    id,
    ownerPrincipal: typeof row.owner_principal === "string"
      ? row.owner_principal
      : null,
    ownerScope: ownerScopeFromPrincipal(row.owner_principal),
    sessionId,
    turnId: typeof row.turn_id === "string" && row.turn_id
      ? row.turn_id
      : null,
  });
}

function failedEvidence() {
  return {
    evidence() {
      return {
        rows: [],
        turnMatchCount: 0,
        lookupFailed: true,
      };
    },
    close() {},
  };
}

function preloadScheduledEvidence(raw, hasTurnId) {
  const sql = hasTurnId
    ? SCHEDULED_EVIDENCE_BATCH_SQL
    : SCHEDULED_EVIDENCE_BATCH_SQL.replace("turn_id", "NULL AS turn_id");
  const batch = raw.prepare(sql);
  const byRun = new Map();
  const byTurn = new Map();
  let cursor = 0;
  let rowCount = 0;
  while (true) {
    const rows = batch.all(cursor, SCHEDULED_EVIDENCE_BATCH_SIZE);
    if (!rows.length) break;
    for (const source of rows) {
      cursor = Number(source.evidence_rowid);
      rowCount += 1;
      if (rowCount > MAX_SCHEDULED_EVIDENCE_ROWS) {
        return { ok: false, reason: "EVIDENCE_ROW_LIMIT" };
      }
      const row = normalizedRow(source);
      if (!row) continue;
      byRun.set(evidenceKey(row.sessionId, row.id), row);
      if (row.turnId) {
        const key = evidenceKey(row.sessionId, row.turnId);
        const matches = byTurn.get(key) || [];
        if (matches.length < 3) matches.push(row);
        byTurn.set(key, matches);
      }
    }
    if (rows.length < SCHEDULED_EVIDENCE_BATCH_SIZE) break;
  }
  return { ok: true, byRun, byTurn, rowCount };
}

function openScheduledEvidence(messageDbPath) {
  if (
    typeof messageDbPath !== "string"
    || !messageDbPath
    || messageDbPath === ":memory:"
  ) return null;
  const scheduledPath = path.join(
    path.dirname(messageDbPath),
    "scheduled-tasks.db",
  );
  if (!fs.existsSync(scheduledPath)) return null;
  let raw = null;
  try {
    raw = new DatabaseSync(scheduledPath, { readOnly: true });
    raw.exec("PRAGMA busy_timeout = 5000;");
    const table = raw.prepare(
      `SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'scheduled_task_runs'`,
    ).get();
    if (!table) {
      raw.close();
      return null;
    }
    const columns = new Set(
      raw.prepare("PRAGMA table_info(scheduled_task_runs)").all()
        .map((row) => row.name),
    );
    if (
      !columns.has("id")
      || !columns.has("owner_principal")
      || !columns.has("execution_session_id")
    ) {
      raw.close();
      return failedEvidence();
    }
    const loaded = preloadScheduledEvidence(raw, columns.has("turn_id"));
    raw.close();
    raw = null;
    if (!loaded.ok) return failedEvidence();
    return {
      evidence(turnId, sessionId, runIds = []) {
        const rows = new Map();
        const turnMatches = turnId
          ? loaded.byTurn.get(evidenceKey(sessionId, turnId)) || []
          : [];
        for (const row of turnMatches) rows.set(row.id, row);
        for (const runId of runIds) {
          const row = loaded.byRun.get(evidenceKey(sessionId, runId));
          if (row) rows.set(row.id, row);
        }
        return {
          rows: [...rows.values()],
          turnMatchCount: turnMatches.length,
          lookupFailed: false,
        };
      },
      close() {},
    };
  } catch {
    try {
      raw?.close();
    } catch {
      // Missing or unreadable scheduler evidence fails closed to quarantine.
    }
    return failedEvidence();
  }
}

module.exports = {
  MAX_SCHEDULED_EVIDENCE_ROWS,
  SCHEDULED_EVIDENCE_BATCH_SIZE,
  SCHEDULED_EVIDENCE_BATCH_SQL,
  openScheduledEvidence,
};
