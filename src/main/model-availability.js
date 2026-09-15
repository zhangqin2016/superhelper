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
    until: now + Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
  };
  marks.set(key, mark);
  return mark;
}

function clearModelAvailability(model) {
  const key = modelKey(model);
  if (!key) return false;
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
      ? { ...model, unavailable: { reason: mark.reason, until: mark.until, count: mark.count, silentMs: mark.silentMs } }
      : model;
  });
}

function resetModelAvailabilityForTests() {
  marks.clear();
}

module.exports = {
  DEFAULT_TTL_MS,
  modelKey,
  noteModelUnresponsive,
  clearModelAvailability,
  getModelAvailability,
  annotateModelOptions,
  resetModelAvailabilityForTests,
};
