"use strict";

/**
 * One shared budget for every gate that pushes a CLEANLY ENDED turn back into
 * the model.
 *
 * Three gates can do this: the required-tool persistence gate (≤2), the
 * unfinished-todo gate (≤2 consecutive no-progress, ≤6 per turn) and the
 * deliverable completion gate (≤1). Each is individually bounded, but nothing
 * bounded their SUM — a long turn could be re-entered up to nine times, every
 * one a full model round, and the gates can hand off to each other in sequence.
 * A 2026-09-02 field turn spent 13 of its 36 minutes inside that loop.
 *
 * This caps the total and records who spent it. It is a BACKSTOP, not the
 * primary bound: each gate keeps its own no-progress logic, and running out of
 * budget must make a gate settle gracefully (or take its existing terminal
 * path) — never silently abort or drop a correctness check.
 *
 * Kill switch: LILY_TURN_CONTINUATION_BUDGET=0 removes the shared cap and
 * restores the previous per-gate-only behaviour.
 */

const DEFAULT_MAX_TURN_CONTINUATIONS = 4;

function maxTurnContinuations() {
  const raw = process.env.LILY_TURN_CONTINUATION_BUDGET;
  if (raw === undefined || raw === "") return DEFAULT_MAX_TURN_CONTINUATIONS;
  const value = Number(raw);
  // Malformed overrides fail open to the default rather than to "unbounded".
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_TURN_CONTINUATIONS;
  return Math.floor(value);
}

/** Per-turn state for every completion gate. Reset whenever a turn starts/ends. */
function createTurnGateState() {
  return {
    continuations: 0,
    byGate: {},
    /** Deliverable completion gate (Pillar 3-B) fires at most once per turn. */
    deliverableGated: false,
    /** `attempts` counts CONSECUTIVE no-progress nudges; `best` is the low-water mark. */
    todo: { attempts: 0, total: 0, best: Infinity },
  };
}

/**
 * Reserve one turn re-entry for `gate`. Returns false when the shared budget is
 * spent — the caller must then finish the turn instead of prompting again.
 */
function claimContinuation(state, gate) {
  if (!state || typeof state !== "object") return true;
  const max = maxTurnContinuations();
  if (max > 0 && Number(state.continuations || 0) >= max) return false;
  state.continuations = Number(state.continuations || 0) + 1;
  state.byGate[gate] = Number(state.byGate[gate] || 0) + 1;
  return true;
}

module.exports = {
  DEFAULT_MAX_TURN_CONTINUATIONS,
  claimContinuation,
  createTurnGateState,
  maxTurnContinuations,
};
