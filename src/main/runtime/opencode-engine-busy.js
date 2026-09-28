"use strict";

/**
 * The engine is busy, but not with this turn's output: a pre-turn compaction
 * is generating a summary, or a provider call failed (429/5xx) and the engine
 * has scheduled its retry. Neither is a silent model, so the first-response
 * watchdog reads both from here. Extracted from opencode-runtime-reducer.js
 * (architecture ratchet).
 */

// A compaction that never reported completion must not disable the watchdog
// forever; past this it is treated as gone (the no-progress and turn watchdogs
// remain the backstop either way).
const COMPACTION_WINDOW_MAX_MS = 5 * 60_000;

function hasActiveCompaction(state, now = Date.now()) {
  const started = state?.activeCompactions;
  if (!started?.size) return false;
  for (const at of started.values()) if (now - at < COMPACTION_WINDOW_MAX_MS) return true;
  return false;
}

/** When the engine will next retry the provider (epoch ms), or 0. */
function engineRetryNextAt(state) {
  return Math.max(0, Number(state?.engineRetryNextAt) || 0);
}

/**
 * Record the engine's session status. "retry" carries `next`, the epoch ms of
 * the scheduled attempt: the provider answered, and the engine said when it
 * will ask again. Any other status clears it.
 */
function noteSessionStatus(state, properties = {}) {
  if (!state) return;
  const status = properties.status || {};
  state.engineRetryNextAt = status.type === "retry" ? Math.max(0, Number(status.next) || 0) : 0;
}

module.exports = { COMPACTION_WINDOW_MAX_MS, hasActiveCompaction, engineRetryNextAt, noteSessionStatus };
