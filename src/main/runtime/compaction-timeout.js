"use strict";

/**
 * How long Lily waits for the engine to summarize a conversation — the ONE
 * bound, for every layer that waits on it.
 *
 * Summarizing is a model call over the whole context, not a transport round
 * trip: on a long session it legitimately takes a minute. The transport table
 * in opencode-sdk-session once carried its own 30s for it while the session
 * declared 90s here, and the inner bound always fired first. Measured
 * 2026-09-23 on one long session: 11 of 11 compactions "failed" at 30s, while
 * the engine finished every one of them in 37–75s — work done, credited as a
 * failure, then repeated.
 *
 * LILY_COMPACTION_TIMEOUT_MS overrides; it is floored so a legitimately large
 * summary is never cut short, and past it the caller fails open and the turn
 * runs without compaction.
 */

const DEFAULT_COMPACTION_TIMEOUT_MS = 90_000;
const MIN_COMPACTION_TIMEOUT_MS = 15_000;

function compactionTimeoutMs(env = process.env) {
  const raw = Number(env?.LILY_COMPACTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.max(MIN_COMPACTION_TIMEOUT_MS, raw)
    : DEFAULT_COMPACTION_TIMEOUT_MS;
}

module.exports = { DEFAULT_COMPACTION_TIMEOUT_MS, MIN_COMPACTION_TIMEOUT_MS, compactionTimeoutMs };
