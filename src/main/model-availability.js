"use strict";

/**
 * Model availability marks — "this model answered nothing for N seconds".
 *
 * In-memory, bounded, self-expiring. Written by the first-response watchdog
 * when a turn gets zero bytes from the model, cleared the moment the same
 * model produces any output. Read by the model picker so the user sees which
 * model is currently silent instead of guessing, and by the recovery watch so
 * it knows what to probe. Never gates a send: the user may still pick a
 * marked model; the mark is information, not policy.
 *
 * AUTO mode (only) also reads these marks as routing policy: among the models
 * the user selected, it prefers unmarked ones, and a failed auto turn fails over
 * to another selected model (turn-recovery-runtime). Model-attributable turn
 * failures write marks too (noteModelFailure), with a TTL that escalates on
 * repeated failures so a dead model is not re-picked every 90 seconds. A manual
 * pick is never overridden. Kill switch for the routing use:
 * LILY_MODEL_HEALTH_ROUTING=0.
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 64;
const marks = new Map();

function modelKey(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  const providerID = String(model.providerID || model.providerId || "").trim();
  const modelID = String(model.modelID || model.modelId || model.id || "").trim();
  return providerID && modelID ? `${providerID}/${modelID}` : modelID || providerID;
}

function prune(now = Date.now()) {
  for (const [key, mark] of marks) if (mark.until <= now) marks.delete(key);
  while (marks.size > MAX_ENTRIES) marks.delete(marks.keys().next().value);
}

function noteModelUnresponsive(model, { silentMs = 0, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const key = modelKey(model);
  if (!key) return null;
  prune(now);
  const previous = marks.get(key);
  const mark = {
    key,
    reason: "no_response",
    count: (previous?.count || 0) + 1,
    silentMs: Math.max(Number(silentMs) || 0, previous?.silentMs || 0),
    since: previous?.since || now,
    lastAt: now,
    until: Math.max(previous?.until || 0, now + Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS)),
  };
  marks.set(key, mark);
  return mark;
}

// Escalating backoff for repeated failures of the same model.
const FAILURE_TTLS_MS = [90_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
// A mark written within this window (e.g. by the first-response watchdog for
// the same turn) is extended, not counted twice.
const SAME_EVENT_MS = 5_000;

// Failure codes that mean the MODEL/endpoint failed (not the user, not a tool).
const MODEL_ATTRIBUTABLE = Object.freeze(new Set([
  "ENGINE_RESULT_FAILED", "ENGINE_PROCESS_EXITED", "ENGINE_UNAVAILABLE",
  "MODEL_OVERLOADED", "RATE_LIMITED", "MODEL_CONNECTION_FAILED", "MODEL_NO_RESPONSE",
  "UPSTREAM_UNAVAILABLE", "EMPTY_ASSISTANT_COMPLETION", "RESPONSE_ERROR",
  "TRUNCATED_TURN_END", "MALFORMED_TOOL_CALL_TEXT", "USER_LOGIN_REQUIRED",
]));

function isModelAttributableFailure(code) {
  return MODEL_ATTRIBUTABLE.has(String(code || ""));
}

// Failure history outlives each mark: the backoff must escalate even when the
// previous mark already expired (a fresh turn after the 90s mark re-picking the
// same dead model is exactly what escalation is for). Forgotten after a quiet
// window or on the model's next success.
const HISTORY_WINDOW_MS = 30 * 60_000;
const history = new Map(); // key -> { count, lastAt }

function noteModelFailure(model, { code = "", now = Date.now() } = {}) {
  const key = modelKey(model);
  if (!key) return null;
  prune(now);
  const previous = marks.get(key);
  let past = history.get(key);
  if (past && now - past.lastAt > HISTORY_WINDOW_MS) past = null;
  const sameEvent = (past && now - past.lastAt < SAME_EVENT_MS)
    || (!past && previous && now - (previous.lastAt || previous.since || 0) < SAME_EVENT_MS);
  const count = sameEvent ? Math.max(past?.count || 0, previous?.count || 0, 1) : (past?.count || 0) + 1;
  history.set(key, { count, lastAt: now });
  while (history.size > MAX_ENTRIES) history.delete(history.keys().next().value);
  const ttl = FAILURE_TTLS_MS[Math.min(count - 1, FAILURE_TTLS_MS.length - 1)];
  const mark = {
    key,
    reason: code === "MODEL_NO_RESPONSE" ? "no_response" : "failed",
    code: String(code || previous?.code || ""),
    count,
    silentMs: previous?.silentMs || 0,
    since: previous?.since || now,
    lastAt: now,
    until: Math.max(previous?.until || 0, now + ttl),
  };
  marks.set(key, mark);
  return mark;
}

/** Record a turn outcome for the model it ran on: mark on a model-attributable
 *  failure, clear on a clean success. Advisory + fail-open. */
function noteTurnModelHealth(route, { failed = false, stalled = false, code = "" } = {}) {
  try {
    const model = route && (route.modelId || route.modelID)
      ? { providerID: route.providerId || route.providerID || "", modelID: route.modelId || route.modelID }
      : null;
    if (!model) return;
    if (failed && isModelAttributableFailure(code)) noteModelFailure(model, { code });
    else if (!failed && !stalled) clearModelAvailability(model);
  } catch { /* advisory */ }
}

function healthRoutingEnabled() {
  return process.env.LILY_MODEL_HEALTH_ROUTING !== "0";
}

function clearModelAvailability(model) {
  const key = modelKey(model);
  if (!key) return false;
  history.delete(key);
  return marks.delete(key);
}

function getModelAvailability(model, now = Date.now()) {
  const key = modelKey(model);
  if (!key) return null;
  prune(now);
  const mark = marks.get(key);
  return mark ? { ...mark } : null;
}

/** Renderer-safe projection for a list of model options ({id, providerID, modelID}). */
function annotateModelOptions(models = [], now = Date.now()) {
  prune(now);
  return (Array.isArray(models) ? models : []).map((model) => {
    const mark = marks.get(modelKey(model));
    return mark
      ? { ...model, unavailable: { reason: mark.reason, code: mark.code || "", until: mark.until, count: mark.count, silentMs: mark.silentMs } }
      : model;
  });
}

function resetModelAvailabilityForTests() {
  marks.clear();
  history.clear();
}

module.exports = {
  DEFAULT_TTL_MS,
  modelKey,
  noteModelUnresponsive,
  noteModelFailure,
  noteTurnModelHealth,
  isModelAttributableFailure,
  healthRoutingEnabled,
  clearModelAvailability,
  getModelAvailability,
  annotateModelOptions,
  resetModelAvailabilityForTests,
};
