"use strict";

/**
 * A compaction's outcome is what the engine did — not how long Lily waited.
 *
 * Lily bounds its wait for a summary so a slow model can never freeze a turn:
 * past the bound the turn runs uncompacted, which is the baseline. But the
 * engine does not stop when Lily stops waiting. Measured 2026-09-23: every one
 * of a long session's compactions was recorded as a failure at the moment the
 * wait expired, while the engine went on to finish each of them. Recording the
 * wait as the outcome had three costs — a failure notice for work that
 * succeeded, a back-off that skipped compaction the session needed, and a
 * "last compacted" that never advanced, so the same compaction was requested
 * again and again.
 *
 * So a timed-out wait is recorded as nothing yet. The call that is still running
 * rides the timeout error; when it settles, its real result is recorded. While
 * it runs, the session is `compacting`, and no second summary is started over
 * the first. The call is the engine work lease itself, so a serve that dies
 * rejects it and the outcome is a failure — a summary that finishes after its
 * engine is gone is never credited as success.
 */

const { getLogger } = require("./logger");

const log = getLogger("compaction");

/** @type {WeakMap<object, { since: number, reason: string }>} */
const inFlight = new WeakMap();

function isCompacting(owner) {
  return Boolean(owner && inFlight.has(owner));
}

function describe(body = {}) {
  return `provider=${body.providerID || "-"} model=${body.modelID || "-"} reason=${body.reason || "-"}`;
}

function recordCompacted(sessionId, body, extra = {}) {
  try {
    require("./session-memory").markSessionCompacted(sessionId, {
      runtime: "opencode",
      mode: "native",
      reason: body.reason || "",
      ...extra,
    });
  } catch (err) {
    log.warn("session compaction memory update failed: %s", err?.message || String(err));
  }
}

function recordFailed(sessionId, body, err) {
  try {
    require("./session-memory").markSessionCompactionFailed(sessionId, {
      runtime: "opencode",
      mode: "native",
      reason: body.reason || "",
      providerID: body.providerID || "",
      modelID: body.modelID || "",
      code: err?.code || err?.name || "",
      error: err?.message || String(err),
    });
  } catch (memoryErr) {
    log.warn(`session compaction failure memory update failed: ${memoryErr?.message || String(memoryErr)}`);
  }
}

function settleLate(owner, sessionId, body, settlement, waitedMs) {
  const entry = { since: Date.now() - waitedMs, reason: body.reason || "" };
  inFlight.set(owner, entry);
  log.info(
    `compaction still running after ${waitedMs}ms; its outcome will be recorded when the engine settles: session=${sessionId} ${describe(body)}`,
  );
  Promise.resolve(settlement).then(
    () => {
      recordCompacted(sessionId, body, { late: true });
      log.info(`compaction finished after the wait: session=${sessionId} took=${Date.now() - entry.since}ms ${describe(body)}`);
    },
    (err) => {
      recordFailed(sessionId, body, err);
      log.warn(`opencode context compaction failed: session=${sessionId} ${describe(body)} error=${err?.message || err}`);
    },
  ).finally(() => {
    if (inFlight.get(owner) === entry) inFlight.delete(owner);
  });
}

/**
 * Summarize through `server`, recording what actually happened.
 * @returns {Promise<boolean>} true only when the summary landed within the
 *   wait; false otherwise — including while it is still running, because this
 *   turn proceeds without it either way.
 */
async function compactWithOutcome(owner, { sessionId, server, body = {}, cwd = "" }) {
  const started = Date.now();
  try {
    await server.summarize(body);
    recordCompacted(sessionId, body);
    return true;
  } catch (err) {
    if (err?.settlement) {
      settleLate(owner, sessionId, body, err.settlement, Date.now() - started);
      return false;
    }
    log.warn(
      `opencode context compaction failed: session=${sessionId} cwd=${cwd} ${describe(body)} error=${err?.message || String(err)}`,
    );
    recordFailed(sessionId, body, err);
    return false;
  }
}

module.exports = { compactWithOutcome, isCompacting };
