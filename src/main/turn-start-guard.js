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

function resetPhaseHard(orchestrator, sessionId, state, payload) {
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
    });
  } catch (err) {
    log.warn("stuck-phase terminal emit failed: %s", err?.message || err);
  }
}

/**
 * Bring a session back to idle after a start-path exception or a detected
 * stuck phase, emitting exactly one terminal event so the renderer exits its
 * loading state, then progress the queue.
 */
async function recoverStuckTurn(orchestrator, sessionId, { errorCode, err }) {
  const state = orchestrator._state(sessionId);
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

/** Wrap _startTurn so NO exception can strand the session phase. */
async function guardTurnStart(orchestrator, session, text, files, opts = {}) {
  try {
    return await orchestrator._startTurn(session, text, files, opts);
  } catch (err) {
    log.error(
      "turn start threw; recovering session: session=%s error=%s",
      session?.id,
      err?.stack || err?.message || err,
    );
    await recoverStuckTurn(orchestrator, session.id, { errorCode: "TURN_START_FAILED", err });
    return { ok: false, error: "TURN_START_FAILED", detail: friendlyStartFailureDetail(err) };
  }
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
        });
      } else if (state.phase === "finalizing" && age > stuckFinalizingMs) {
        log.error("stuck phase detected (finalizing, %ds) — auto-recovering: session=%s", Math.round(age / 1000), sessionId);
        void recoverStuckTurn(orchestrator, sessionId, {
          errorCode: "TURN_STUCK_RESET",
          err: new Error(`phase stuck at "finalizing" for ${Math.round(age / 1000)}s`),
        });
      }
    }
  }, sweepMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  friendlyStartFailureDetail,
  guardTurnStart,
  recoverStuckTurn,
  startStuckPhaseGuard,
};
