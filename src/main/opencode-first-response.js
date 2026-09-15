"use strict";

/**
 * First-response watchdog — session-side handling.
 *
 * The liveness module (opencode-turn-liveness.js) arms a short fuse while a
 * turn has produced nothing at all; when it fires this module ends the turn
 * NOW as a retryable MODEL_NO_RESPONSE failure (the rescue table gives it two
 * silent attempts on a fresh engine), marks the model silent for the picker
 * (model-availability.js), and lets the orchestrator's recovery lane arm the
 * model-recovery watch. Extracted from opencode-agent-session.js
 * (architecture ratchet). 2026-09-14 field case: DeepSeek flash returned zero
 * bytes for 10 minutes, twice, before the old no-progress window noticed.
 */

const { getLogger } = require("./logger");

const log = getLogger("opencode-first-response");

// Zero bytes from the model for this long ends the turn. 0 disables.
const FIRST_RESPONSE_TIMEOUT_MS = process.env.LILY_OPENCODE_FIRST_RESPONSE_TIMEOUT_MS !== undefined
  ? Number(process.env.LILY_OPENCODE_FIRST_RESPONSE_TIMEOUT_MS) || 0
  : 90_000;

function clearModelSilenceMark(session) {
  try { require("./model-availability").clearModelAvailability(session?._activeModel); } catch { /* informational */ }
}

/** Fail-open: if the turn already settled or produced output, no-op. */
function handleNoFirstResponse(session, info = {}) {
  if (!session || !session.busy || session._turnSettled) return false;
  if (session._sawActivity || String(session.collectedOutput || "").trim()) return false;
  if (session._pendingPermissions?.size || session._pendingQuestions?.size) return false;
  const timeoutMs = Number(info?.timeoutMs) || FIRST_RESPONSE_TIMEOUT_MS;
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  log.warn("model returned nothing within %ds; ending turn as MODEL_NO_RESPONSE", seconds, { sessionId: session.sessionId });
  try { require("./model-availability").noteModelUnresponsive(session._activeModel, { silentMs: timeoutMs }); } catch { /* informational */ }
  const liveness = session._turnLiveness;
  liveness?.clearResponseTimer?.();
  liveness?.clearFirstResponseTimer?.();
  liveness?.clearProgressNoticeTimer?.();
  try { void session._server?.abort?.().catch?.(() => {}); } catch { /* best effort */ }
  session._completeTurn({
    code: 1,
    output: "",
    interrupted: false,
    noFirstResponse: true,
    firstResponseTimeoutMs: timeoutMs,
    failureCode: "MODEL_NO_RESPONSE",
    error: `MODEL_NO_RESPONSE: no model response within ${seconds}s`,
  });
  return true;
}

module.exports = { FIRST_RESPONSE_TIMEOUT_MS, handleNoFirstResponse, clearModelSilenceMark };
