"use strict";

/**
 * Time a turn spends BLOCKED ON THE USER is not the assistant's latency.
 *
 * A permission card or a question card suspends the engine: the tool that raised
 * it stays `running`, its wall-clock keeps growing, and every duration derived
 * from `ts - startTs` then bills the user's own reading/deciding time to Lily.
 * Two field cases: a `question` card answered after 8m27s rendered as
 * "已完成 · 507.8s", and an unattended `rm -rf` permission card (2026-07-22)
 * rendered as 1200s of tool latency.
 *
 * The turn state machine already knows when this happens — it sets
 * `phase = "awaiting_user"` and holds the pending
 * permission/question/hook maps. This module only ATTRIBUTES that time:
 * one open interval per turn (concurrent cards share it), credited to the tools
 * that were actually suspended plus a turn-level total.
 *
 * Invariant: a tool entry's `waitMs` is the overlap between its own
 * [startTs, ts] lifetime and the turn's user-blocked intervals — never more.
 * Everything here is arithmetic on numbers already in the state; if a hook is
 * missed the result is `waitMs === 0`, i.e. exactly today's behaviour.
 */

function waitState(state) {
  if (!state.userWait || typeof state.userWait !== "object") {
    state.userWait = { since: 0, totalMs: 0 };
  }
  return state.userWait;
}

/** Overlap in ms between an open wait interval and a tool's own lifetime. */
function overlapMs(since, startTs, until) {
  const from = Math.max(Number(since) || 0, Number(startTs) || 0);
  const to = Number(until) || 0;
  return to > from ? to - from : 0;
}

/**
 * The turn just became blocked on the user. Idempotent: a second card raised
 * while one is already open extends the SAME interval instead of nesting, so
 * overlapping cards can never double-count.
 */
function beginUserWait(state, ts = Date.now()) {
  if (!state || typeof state !== "object") return;
  const wait = waitState(state);
  if (wait.since) return;
  wait.since = Number(ts) || 0;
}

/**
 * The last pending card was resolved. Credits the elapsed interval to the turn
 * and to every tool that was still suspended by it. Tools that finished DURING
 * the interval are no longer `running` and were already credited by
 * `creditFinishedToolWait`, so they are skipped here — no double counting.
 */
function endUserWait(state, ts = Date.now()) {
  if (!state || typeof state !== "object") return 0;
  const wait = waitState(state);
  const since = Number(wait.since) || 0;
  if (!since) return 0;
  wait.since = 0;
  const until = Number(ts) || 0;
  const elapsed = until > since ? until - since : 0;
  if (!elapsed) return 0;
  wait.totalMs = (Number(wait.totalMs) || 0) + elapsed;
  for (const entry of Array.isArray(state.timeline) ? state.timeline : []) {
    if (entry?.kind !== "tool" || entry.status !== "running") continue;
    const credit = overlapMs(since, entry.startTs, until);
    if (credit > 0) entry.waitMs = (Number(entry.waitMs) || 0) + credit;
  }
  return elapsed;
}

/**
 * A tool reached a terminal status while a card was still open (the engine
 * resolves the card and completes the tool in the same tick, and the event
 * order between them is not guaranteed). Credit its share now so the pending
 * `endUserWait` does not have to find it still `running`.
 */
function creditFinishedToolWait(state, entry, ts = Date.now()) {
  if (!state || !entry || entry.kind !== "tool") return;
  const since = Number(state.userWait?.since) || 0;
  if (!since) return;
  const credit = overlapMs(since, entry.startTs, ts);
  if (credit > 0) entry.waitMs = (Number(entry.waitMs) || 0) + credit;
}

/**
 * Oldest `requestedAt` across the given pending-request maps (permission /
 * question / hook), or 0 when nothing is open. This is when the ball moved to
 * the user, which is what the liveness heartbeat reports as waiting.
 */
function earliestPendingRequestAt(...maps) {
  let earliest = 0;
  for (const map of maps) {
    for (const entry of map?.values?.() || []) {
      const at = Number(entry?.requestedAt) || 0;
      if (at && (!earliest || at < earliest)) earliest = at;
    }
  }
  return earliest;
}

module.exports = {
  beginUserWait,
  creditFinishedToolWait,
  earliestPendingRequestAt,
  endUserWait,
};
