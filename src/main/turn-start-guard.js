"use strict";

/**
 * Turn-start safety net + stuck-phase watchdog.
 *
 * The send path (_startTurn) touches disk (transcript store, sessions.json,
 * messages.db) and dozens of fail-open helpers BEFORE the engine runner ever
 * starts. Any exception in that window used to leave state.phase pinned at
 * "starting"/"finalizing" forever: the first send shows a raw sqlite/ENOSPC
 * error, and every later send returns "queued" but never dispatches, because
 * _dispatchNext requires phase === "idle" and no watchdog covers the
 * pre-runner phases. Users read this as "activated but the app is dead".
 *
 * Two guarantees, both fail-open:
 *   1. guardTurnStart — an exception anywhere in _startTurn finalizes the turn
 *      as turn.failed (user-language detail), hard-resets phase to idle even
 *      if finalize itself throws, and progresses the queue.
 *   2. startStuckPhaseGuard — a periodic sweeper for phases that have no
 *      engine-side watchdog ("starting", "finalizing"): anything stuck beyond
 *      the threshold is finalized/reset so the session can never wedge
 *      permanently, no matter which future code path forgets to clean up.
 */

const { getLogger } = require("./logger");

const log = getLogger("turn-start-guard");

const STUCK_SWEEP_MS = 30_000;
// "starting" runs preflight (model-config refresh can await up to 90s) before
// the runner exists, so the threshold must clear the slowest legitimate path.
const STUCK_STARTING_MS = 4 * 60_000;
const STUCK_FINALIZING_MS = 2 * 60_000;

/** Raw storage/OS errors must never reach the user verbatim. */
function friendlyStartFailureDetail(err) {
  const raw = String(err?.message || err || "");
  if (/ENOSPC|SQLITE_FULL|no space|disk/i.test(raw)) {
    return "磁盘空间不足，消息保存失败。请清理磁盘后重试。";
  }
  if (/EACCES|EPERM|permission|权限/i.test(raw)) {
    return "数据目录没有写入权限，消息保存失败。请检查应用数据目录权限或重启应用。";
  }
  if (/SQLITE_BUSY|database is locked|锁/i.test(raw)) {
    return "会话数据正被其他进程占用（可能有另一个应用实例在运行）。请关闭其他实例后重试。";
  }
  return "发送过程遇到内部错误，已自动恢复。请重试；若反复出现请重启应用。";
}

/**
 * An async preflight may resume after the watchdog has already finalized the
 * turn. Only the phase, turn id, and generation that started the preflight may
 * continue to engine dispatch; a cleared or newer turn must stop immediately.
 */
function isCurrentTurnStart(state, turnId, turnGeneration) {
  return Boolean(
    state &&
    state.startInFlight?.cancelled !== true &&
    state.phase === "starting" &&
    state.terminalEmitted !== true &&
    state.turnId === turnId &&
    state.turnGeneration === turnGeneration,
  );
}

function isTurnStartCancelled(state) {
  return state?.startInFlight?.cancelled === true;
}

function startCancellationResult(orchestrator, sessionId) {
  if (!isTurnStartCancelled(orchestrator._state(sessionId))) return null;
  return { ok: false, error: "TURN_START_ABORTED", cancelled: true };
}

/** Cancel a preflight that has not yet assigned a visible turn id. */
function cancelTurnStart(orchestrator, sessionId) {
  const reservation = orchestrator._state(sessionId).startInFlight;
  if (!reservation || typeof reservation !== "object") return false;
  reservation.cancelled = true;
  return true;
}

function resetPhaseHard(orchestrator, sessionId, state, payload) {
  // clearTurnState deliberately removes the active turn id. Capture it first
  // so the last-resort terminal event is still attributable to the failed
  // turn; production _emit drops required orphan events without this.
  const turnId = state.turnId || null;
  try {
    require("./turn-terminal-finalizer").clearTurnState(state);
  } catch (err) {
    // Last resort: never leave a non-idle phase behind.
    state.phase = "idle";
    state.turnId = null;
    state.terminalEmitted = true;
    log.warn("stuck-phase hard reset fell back to minimal clear: %s", err?.message || err);
  }
  try {
    orchestrator._emit(sessionId, "turn.failed", {
      failed: true,
      assistant: payload.assistant,
      errorCode: payload.errorCode,
      errorCategory: "environment",
      retryable: true,
    }, { turnId });
  } catch (err) {
    log.warn("stuck-phase terminal emit failed: %s", err?.message || err);
  }
}

function ownsRecoveryTarget(state, expectedTurnId, expectedTurnGeneration) {
  if (expectedTurnId !== undefined && state.turnId !== expectedTurnId) return false;
  if (expectedTurnGeneration !== undefined && state.turnGeneration !== expectedTurnGeneration) return false;
  return true;
}

/**
 * Bring a session back to idle after a start-path exception or a detected
 * stuck phase, emitting exactly one terminal event so the renderer exits its
 * loading state, then progress the queue.
 */
async function recoverStuckTurnOwned(orchestrator, sessionId, {
  errorCode,
  err,
  expectedTurnId,
  expectedTurnGeneration,
} = {}) {
  const state = orchestrator._state(sessionId);
  if (!ownsRecoveryTarget(state, expectedTurnId, expectedTurnGeneration)) return;
  if (state.phase === "idle" && !state.turnId) return;
  const assistant = friendlyStartFailureDetail(err);
  const hadTurn = Boolean(state.turnId) && !state.terminalEmitted;
  if (hadTurn) {
    try {
      await orchestrator._finalize(sessionId, "turn.failed", {
        failed: true,
        assistant,
        errorCode,
        errorCategory: "environment",
        retryable: true,
        error: String(err?.message || err || ""),
      });
    } catch (finalizeErr) {
      log.warn("stuck-turn finalize threw (recovering hard): %s", finalizeErr?.message || finalizeErr);
    }
  }
  // Hard guarantee: finalize swallows its own errors, so verify the phase
  // actually returned to idle — if it didn't (exception mid-finalize), reset.
  if (state.phase !== "idle" && !ownsRecoveryTarget(state, expectedTurnId, expectedTurnGeneration)) {
    log.warn(
      "stuck-turn recovery abandoned stale target: session=%s turn=%s",
      sessionId,
      expectedTurnId || "",
    );
    return;
  }
  if (state.phase !== "idle") {
    resetPhaseHard(orchestrator, sessionId, state, { assistant, errorCode });
  } else if (!hadTurn) {
    // Turn never got as far as having an id — nothing to emit, just reset.
    try {
      require("./turn-terminal-finalizer").clearTurnState(state);
    } catch {
      state.phase = "idle";
    }
  }
  try {
    orchestrator._afterTurnFinalized(sessionId);
  } catch (err) {
    log.warn("stuck-turn queue progression failed: %s", err?.message || err);
  }
}

/**
 * Serialize recovery per session. The watchdog and a failing send can both
 * observe the same stuck state; allowing both to finalize would race the
 * durable terminal CAS and, worse, let the second path reset state while the
 * first is still awaiting storage I/O.
 */
function recoverStuckTurn(orchestrator, sessionId, options = {}) {
  const state = orchestrator._state(sessionId);
  if (state.recoveryInFlight) return state.recoveryInFlight;
  let recoveryPromise;
  recoveryPromise = Promise.resolve()
    .then(() => recoverStuckTurnOwned(orchestrator, sessionId, options))
    .finally(() => {
      if (state.recoveryInFlight === recoveryPromise) state.recoveryInFlight = null;
    });
  state.recoveryInFlight = recoveryPromise;
  return recoveryPromise;
}

/** Wrap any pre-engine start path so NO exception can strand the session phase. */
async function guardStartMethod(orchestrator, startMethod, session, text, files, opts = {}) {
  const initialState = orchestrator._state(session.id);
  if (initialState.startInFlight) {
    return { ok: false, error: "TURN_START_BUSY", retry: true };
  }
  const startReservation = { cancelled: false };
  initialState.startInFlight = startReservation;
  const initialGeneration = Number(initialState.turnGeneration || 0);
  try {
    return await startMethod(session, text, files, opts);
  } catch (err) {
    if (err?.code === "TURN_DISPATCH_CRASH_INJECTION") throw err;
    log.error(
      "turn start threw; recovering session: session=%s error=%s",
      session?.id,
      err?.stack || err?.message || err,
    );
    const currentState = orchestrator._state(session.id);
    const expectedTurnGeneration = Number.isFinite(currentState.turnGeneration)
      ? initialGeneration + 1
      : undefined;
    const expectedTurnId = expectedTurnGeneration !== undefined
      && currentState.turnGeneration === expectedTurnGeneration
      ? currentState.turnId
      : undefined;
    await recoverStuckTurn(orchestrator, session.id, {
      errorCode: "TURN_START_FAILED",
      err,
      expectedTurnId,
      expectedTurnGeneration,
    });
    const error = err?.code === "OWNER_SCOPE_UNAVAILABLE"
      ? "OWNER_SCOPE_UNAVAILABLE"
      : err?.code === "TURN_ADMISSION_FAILED"
        ? "TURN_ADMISSION_FAILED"
        : "TURN_START_FAILED";
    return { ok: false, error, detail: friendlyStartFailureDetail(err) };
  } finally {
    if (initialState.startInFlight === startReservation) {
      initialState.startInFlight = null;
      if (initialState.phase === "idle" && initialState.queue?.length) {
        queueMicrotask(() => void orchestrator._dispatchNext(session.id));
      }
    }
  }
}

/** Wrap _startTurn so NO exception can strand the session phase. */
function guardTurnStart(orchestrator, session, text, files, opts = {}) {
  return guardStartMethod(
    orchestrator,
    (startSession, startText, startFiles, startOpts) => (
      orchestrator._startTurn(startSession, startText, startFiles, startOpts)
    ),
    session,
    text,
    files,
    opts,
  );
}

/** Local assistant turns have the same durable start boundary as engine turns. */
function guardLocalAssistantTurn(orchestrator, session, text, files, opts = {}) {
  return guardStartMethod(
    orchestrator,
    (startSession, startText, startFiles, startOpts) => (
      orchestrator._startLocalAssistantTurn(startSession, startText, startFiles, startOpts)
    ),
    session,
    text,
    files,
    opts,
  );
}

/**
 * Periodic sweeper for the phases no engine watchdog covers. "running" turns
 * have their own liveness probes; "starting"/"finalizing" previously had none.
 */
function startStuckPhaseGuard(orchestrator, options = {}) {
  const sweepMs = Number(options.sweepMs || STUCK_SWEEP_MS);
  const stuckStartingMs = Number(options.stuckStartingMs || STUCK_STARTING_MS);
  const stuckFinalizingMs = Number(options.stuckFinalizingMs || STUCK_FINALIZING_MS);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, state] of orchestrator.states || []) {
      if (!state || state.phase === "idle") continue;
      const since = Number(state.updatedAt || state.startedAt || 0);
      if (!since) continue;
      const age = now - since;
      if (state.phase === "starting" && age > stuckStartingMs) {
        log.error("stuck phase detected (starting, %ds) — auto-recovering: session=%s", Math.round(age / 1000), sessionId);
        void recoverStuckTurn(orchestrator, sessionId, {
          errorCode: "TURN_STUCK_RESET",
          err: new Error(`phase stuck at "starting" for ${Math.round(age / 1000)}s`),
          expectedTurnId: state.turnId,
          expectedTurnGeneration: state.turnGeneration,
        });
      } else if (state.phase === "finalizing" && age > stuckFinalizingMs) {
        log.error("stuck phase detected (finalizing, %ds) — auto-recovering: session=%s", Math.round(age / 1000), sessionId);
        void recoverStuckTurn(orchestrator, sessionId, {
          errorCode: "TURN_STUCK_RESET",
          err: new Error(`phase stuck at "finalizing" for ${Math.round(age / 1000)}s`),
          expectedTurnId: state.turnId,
          expectedTurnGeneration: state.turnGeneration,
        });
      }
    }
  }, sweepMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  friendlyStartFailureDetail,
  cancelTurnStart,
  guardLocalAssistantTurn,
  guardTurnStart,
  isCurrentTurnStart,
  isTurnStartCancelled,
  startCancellationResult,
  recoverStuckTurn,
  startStuckPhaseGuard,
};
