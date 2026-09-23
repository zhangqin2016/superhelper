"use strict";

/**
 * How turns have been ending lately, across every session.
 *
 * The question support actually asks is "what keeps failing on this install",
 * and nothing could answer it. The reason a turn ended survived only in the
 * event stream, readable one session at a time, so a report could say that
 * something failed but never what — and a dozen unrelated causes reached the
 * user as the same sentence. Now that the projection carries the code, this is
 * the one query that turns it into an answer.
 *
 * Grouped by code so a recurring cause stands out from a one-off, and bounded
 * by time so a problem fixed last month stops reporting itself.
 */

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
// Enough rows to characterise a week on a busy install without scanning a
// history that may hold years of turns.
const SCAN_LIMIT = 500;
const MAX_GROUPS = 100;

function parsePayload(text) {
  try {
    const parsed = JSON.parse(text || "");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {{ all: Function }} db
 * @returns {Array<{ code: string, count: number, lastAt: number, terminalType: string }>}
 *          most frequent first, then most recent
 */
function recentFailureCodes(db, { sinceMs = DEFAULT_WINDOW_MS, limit = 20, now = Date.now() } = {}) {
  const since = Number(now) - Math.max(0, Number(sinceMs) || 0);
  let rows = [];
  try {
    rows = db.all(
      `SELECT terminal_type, terminal_at, updated_at, payload_json
         FROM turn_projection
        WHERE terminal_type IS NOT NULL AND terminal_type != 'turn.completed'
          AND COALESCE(terminal_at, updated_at) >= ?
        ORDER BY COALESCE(terminal_at, updated_at) DESC
        LIMIT ${SCAN_LIMIT}`,
      since,
    );
  } catch {
    // A diagnostic must never be the thing that breaks; an install whose
    // projection table predates this column simply reports nothing.
    return [];
  }
  const byCode = new Map();
  for (const row of rows) {
    const code = String(parsePayload(row.payload_json).failureCode || "").trim();
    if (!code) continue;
    const at = Number(row.terminal_at || row.updated_at || 0);
    const seen = byCode.get(code);
    if (seen) {
      seen.count += 1;
      if (at > seen.lastAt) seen.lastAt = at;
    } else {
      byCode.set(code, { code, count: 1, lastAt: at, terminalType: String(row.terminal_type || "") });
    }
  }
  return [...byCode.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, MAX_GROUPS)));
}

module.exports = { DEFAULT_WINDOW_MS, recentFailureCodes };
