"use strict";

/**
 * What a terminal event leaves behind in a turn's projection payload.
 *
 * The projection is the fast read path: the conversation list, a support
 * report, and any question of the form "what keeps failing here" all read this
 * table rather than replaying the event stream. Two rules govern it, and they
 * pull in opposite directions, which is why they live together here instead of
 * inline among the projection's other branches.
 */

/**
 * State that belongs to a turn's dispatch-recovery detour, not to its ending.
 *
 * A turn can pass through `turn.dispatch_blocked` or
 * `turn.dispatch_outcome_unknown` and then finish for real. Leaving those
 * fields in place would advertise a recovery that no longer applies, so a real
 * ending clears them.
 */
const DISPATCH_RECOVERY_FIELDS = Object.freeze([
  "recoveryId",
  "manualRecoveryRequired",
  "automaticReplay",
  "errorCode",
  "assistant",
  "retryable",
]);

const TERMINAL_EVENT_TYPES = Object.freeze([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.stalled",
]);

// Long enough for any code the platform raises, short enough that a malformed
// payload cannot bloat every projection row.
const MAX_FAILURE_CODE_CHARS = 120;

function isTerminalEventType(eventType) {
  return TERMINAL_EVENT_TYPES.includes(String(eventType || ""));
}

/**
 * Apply a terminal event to the accumulated projection payload.
 *
 * Clears the superseded dispatch-recovery state, then records WHY the turn
 * ended — the one thing this table never carried. The code survived in
 * runtime_events, but nothing that reads the projection could tell a network
 * failure from a missing entitlement from a corrupt download, so more than a
 * dozen distinct causes were indistinguishable in practice and every one of
 * them reached the user as the same sentence.
 *
 * Recorded under its own name: the dispatch-recovery `errorCode` above has an
 * established meaning and an established reader, and overloading it would make
 * a finished turn look like one still awaiting recovery.
 *
 * Total by construction — a malformed payload yields a payload with no failure
 * code, never an exception on the persistence path.
 *
 * @param {object} previous payload accumulated so far
 * @param {object} payload the terminal event's own payload
 * @param {string} eventType one of TERMINAL_EVENT_TYPES
 * @returns {object} the payload to persist
 */
function applyTerminalPayload(previous = {}, payload = {}, eventType = "") {
  const next = { ...(previous || {}) };
  for (const field of DISPATCH_RECOVERY_FIELDS) delete next[field];
  const raw = eventType === "turn.completed" ? "" : String(payload?.errorCode || "").trim();
  if (raw) next.failureCode = raw.slice(0, MAX_FAILURE_CODE_CHARS);
  else delete next.failureCode;
  return next;
}

module.exports = {
  DISPATCH_RECOVERY_FIELDS,
  MAX_FAILURE_CODE_CHARS,
  TERMINAL_EVENT_TYPES,
  applyTerminalPayload,
  isTerminalEventType,
};
