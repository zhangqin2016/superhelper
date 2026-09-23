"use strict";

/**
 * What may happen to an engine runner while no turn is running on it.
 *
 * Three things, one question — "is this runner idle?":
 *
 *  - A TURN'S CLAIM. Between the orchestrator's ensure and its send — vision
 *    bridge, document extraction, routing, pre-turn compaction — the runner is
 *    not busy, so every "terminate idle runners" path (settings saved, login,
 *    skill sync, permission mode) used to see it as fair game, terminate it,
 *    and the turn then failed on a corpse it was still holding
 *    (RUNNER_TERMINATED, 2026-09-19 field case: 12 s grace, a failed card, and
 *    only then a rescue). The claim is a LIVE predicate, not a flag: it holds
 *    exactly while the turn that made it is still the session's current,
 *    non-terminal turn. It cannot leak, because nothing has to remember to
 *    release it.
 *
 *  - RECYCLING an idle engine: drop the serve process so the NEXT send spawns a
 *    fresh one — fresh gateway sockets — and resumes the same engine session.
 *    Field case: a load-balanced gateway with connection affinity pinned the
 *    engine's keep-alive pool to a dead backend pod during a rolling swap, so
 *    every request (and every same-runner rescue retry) rode the same dead
 *    socket and came back empty, while NEW connections reached healthy pods.
 *    Preserves agentResumeId — the recycled engine continues the conversation.
 *
 *  - RESTARTING on a model-config change, which unlike recycling resets the
 *    resume id and announces the invalidation so the host can rebuild.
 *
 * The runner keeps thin delegates; the state lives on the runner.
 */

const { getLogger } = require("./logger");

const log = getLogger("opencode-agent-session");

// Resolved at call time, not load time: the runtime-identity module is the one
// piece of state a host may swap under a running process (test hosts do), and
// a copy captured here would keep revoking against the wrong host.
const identity = () => require("./opencode-runtime-identity");

function reserveForTurn(runner, turnId, held) {
  runner._turnReservation = { turnId: turnId || null, held: typeof held === "function" ? held : () => true };
}

function isReserved(runner) {
  const reservation = runner._turnReservation;
  if (!reservation) return false;
  try {
    if (reservation.held()) return true;
  } catch {
    // A predicate that throws cannot hold a claim.
  }
  runner._turnReservation = null;
  return false;
}

/** The ONE idleness predicate: alive, not busy, and not claimed by a turn. */
function isIdle(runner) {
  return runner.isAlive() && !runner.isBusy() && !isReserved(runner);
}

/**
 * Claim the runner for a turn from ensure until send. `stateFor` returns the
 * session's orchestrator state; the claim holds exactly while this is still its
 * current, non-terminal turn — so a turn aborted, superseded or finalized before
 * it ever sends releases the runner by construction.
 */
function claimForTurn(runner, turnId, stateFor) {
  if (!runner || typeof runner.reserveForTurn !== "function" || !turnId) return;
  runner.reserveForTurn(turnId, () => {
    const state = stateFor();
    return Boolean(state && state.turnId === turnId && !state.terminalEmitted);
  });
}

function recycleIdleEngine(runner, reason = "") {
  if (runner.isBusy()) return false;
  const server = runner._server;
  const resumeId = runner.agentResumeId || server?.sessionID || null;
  identity().revokeOpencodeRuntimeIdentity(runner, resumeId, "runner_recycled");
  if (server) {
    try {
      server.terminate();
    } catch {
      // Best effort; a dead process object is dropped either way.
    }
    if (runner._server === server) runner._server = null;
  }
  runner._starting = null;
  runner._activeModelConfigFingerprint = runner._activeToolConfigFingerprint = "";
  runner._activeRouteConfigFingerprint = "";
  if (resumeId) runner.agentResumeId = resumeId;
  log.info("idle engine recycled (%s): next send gets fresh gateway connections", reason || "-");
  return true;
}

function restartIdleEngineForModelConfigChange(runner, previousFingerprint = "", nextFingerprint = "") {
  const server = runner._server;
  const previousResumeId = runner.agentResumeId || server?.sessionID || "";
  log.warn(
    "opencode model config changed — restarting idle engine session: %s -> %s",
    runner._logFingerprint(previousFingerprint || "-"),
    runner._logFingerprint(nextFingerprint || "-"),
  );
  try {
    server?.terminate?.();
  } catch {
    // best effort; the next prompt will create a fresh server view.
  }
  if (runner._server === server) runner._server = null;
  runner._starting = null;
  runner.agentResumeId = null;
  runner._engineSessionWasResumed = false;
  runner._activeModelConfigFingerprint = "";
  runner._activeRouteConfigFingerprint = "";
  runner.emit("engine-session-invalidated", {
    reason: "model_config_changed",
    errorCode: "",
    previousResumeId,
    resetResume: true,
  });
}

module.exports = {
  claimForTurn,
  isIdle,
  isReserved,
  recycleIdleEngine,
  reserveForTurn,
  restartIdleEngineForModelConfigChange,
};
