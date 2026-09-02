"use strict";

const { buildToolPreviewLabel } = require("./tool-preview-label.cjs");
const { getLogger } = require("./logger");
const { buildRetryNoticeDetail } = require("./runtime/opencode-serve-diagnostics");

const log = getLogger("opencode-turn-liveness");
const TOOL_PROGRESS_STALE_MS = 10_000;

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function compactProgressText(value = "", limit = 96) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function createOpencodeTurnLiveness(options = {}) {
  const sessionId = options.sessionId || "";
  const activeTools = options.activeTools || new Map();
  const getState = options.getState || (() => ({}));
  const getConfig = options.getConfig || (() => ({}));
  const getServer = options.getServer || (() => null);
  const hasKnownSubagents = options.hasKnownSubagents || (() => false);
  const ingest = options.ingest || (() => {});
  const recoverStalledFinal = options.recoverStalledFinal || (() => Promise.resolve(null));
  const completeTurn = options.completeTurn || (() => {});
  const onServerError = options.onServerError || (() => {});
  const now = options.now || (() => Date.now());
  const scheduleTimer = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;
  let responseTimer = null;
  let turnWatchdogTimer = null;
  let progressNoticeTimer = null;
  let healthTimer = null;
  let healthFails = 0;
  let lastGenericToolProgressNotice = "";
  let engineRetryCount = 0;

  function isRunning() {
    const state = getState() || {};
    return Boolean(state.busy && !state.turnSettled);
  }

  function hasPendingUserInput() {
    const state = getState() || {};
    return Boolean(
      state.pendingUserInput
      || state.pendingPermissions
      || state.pendingQuestions
      || state.pendingHooks,
    );
  }

  function clearResponseTimer() {
    if (responseTimer) cancelTimer(responseTimer);
    responseTimer = null;
  }

  function hasActiveToolLease() {
    if (!isRunning()) return false;
    const currentTime = now();
    const leaseMs = Number(getConfig().activeToolLeaseMs || 0);
    let hasLease = false;
    for (const [id, tool] of activeTools.entries()) {
      if (!tool?.id) {
        activeTools.delete(id);
        continue;
      }
      const lastActivityAt = Number(tool.lastActivityAt || tool.startedAt || 0);
      if (leaseMs > 0 && lastActivityAt > 0 && currentTime - lastActivityAt > leaseMs) {
        log.warn("opencode active tool lease expired", {
          sessionId,
          tool: tool.name || "",
          id,
          idleMs: currentTime - lastActivityAt,
        });
        activeTools.delete(id);
        continue;
      }
      hasLease = true;
    }
    return hasLease;
  }

  // The ball is with the USER, so the heartbeat must say so. Reporting the
  // suspended tool's stopwatch instead told a user reading an 8-minute question
  // card "question 正在运行 · 已运行 8m 29s · 最近活动 8m 23s 前" — the app
  // blaming itself for the user's own thinking time, and reading like a hang.
  function awaitingUserDetail() {
    const state = getState() || {};
    if (!state.pendingUserInput) return "";
    const since = Number(state.pendingUserInputSince) || 0;
    const waited = since ? formatDuration(Math.max(0, now() - since)) : "";
    return waited ? `等待你确认或回答 · 已等待 ${waited}` : "等待你确认或回答";
  }

  function genericToolProgressDetail() {
    const config = getConfig();
    const leaseMs = Number(config.activeToolLeaseMs || 0);
    const currentTime = now();
    const running = [...activeTools.values()].filter((tool) => {
      if (!tool?.id) return false;
      const lastActivityAt = Number(tool.lastActivityAt || tool.startedAt || 0);
      return !(leaseMs > 0 && lastActivityAt > 0 && currentTime - lastActivityAt > leaseMs);
    });
    if (!running.length) return "";
    running.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    const tool = running[0];
    const label = compactProgressText(tool.title || buildToolPreviewLabel(tool) || tool.name || "Tool");
    const elapsed = formatDuration(currentTime - (tool.startedAt || currentTime));
    const idle = Math.max(0, currentTime - (tool.lastActivityAt || tool.startedAt || currentTime));
    const activity = idle >= TOOL_PROGRESS_STALE_MS
      ? `最近活动 ${formatDuration(idle)} 前`
      : "仍有活动";
    if (running.length > 1) {
      return `${running.length} 个工具运行中 · 当前：${label} · 已运行 ${elapsed} · ${activity}`;
    }
    return `${label} 正在运行 · 已运行 ${elapsed} · ${activity}`;
  }

  function emitGenericToolProgressNotice() {
    const awaiting = awaitingUserDetail();
    const detail = awaiting || genericToolProgressDetail();
    if (!detail) return false;
    if (detail === lastGenericToolProgressNotice) return true;
    lastGenericToolProgressNotice = detail;
    ingest([{
      type: "engine.notice",
      payload: {
        notice: {
          // A distinct code so the panel can style "waiting on you" differently
          // from "working", and so telemetry can tell the two apart. Both share
          // one replace slot, so they swap in place instead of stacking.
          code: awaiting ? "awaitingUser" : "toolProgress",
          level: "progress",
          panel: true,
          replace: true,
          replacesCode: "genericToolProgress",
          detail,
        },
      },
    }]);
    return true;
  }

  /**
   * The engine hit transient provider trouble and is retrying. Narrate it in the
   * same progress slot the heartbeat uses, so it self-clears on the next real
   * progress instead of leaving a stale "retrying" line behind. Silence here was
   * the reason a 4s/7s backoff felt like an unexplained hang.
   */
  function noteEngineRetry(info = {}) {
    if (!isRunning()) return false;
    engineRetryCount += 1;
    const detail = buildRetryNoticeDetail(info, engineRetryCount);
    lastGenericToolProgressNotice = detail;
    ingest([{
      type: "engine.notice",
      payload: {
        notice: {
          code: "engineRetry",
          level: "progress",
          panel: true,
          replace: true,
          replacesCode: "genericToolProgress",
          detail,
        },
      },
    }]);
    return true;
  }

  function clearProgressNoticeTimer() {
    if (progressNoticeTimer) cancelTimer(progressNoticeTimer);
    progressNoticeTimer = null;
  }

  function armProgressNoticeTimer(options = {}) {
    const reset = options === true || options?.reset === true;
    // This is a heartbeat, not a debounce timer. Resetting it on every hidden
    // reasoning delta made a model that kept thinking indefinitely look frozen:
    // the 45s notice was always pushed into the future. Keep one timer alive
    // for the turn and only reset it after the heartbeat itself fires.
    if (progressNoticeTimer && !reset) return;
    if (reset) clearProgressNoticeTimer();
    if (!isRunning()) return;
    progressNoticeTimer = scheduleTimer(emitLongWaitNotice, getConfig().progressNoticeMs);
    progressNoticeTimer?.unref?.();
  }

  function emitLongWaitNotice() {
    progressNoticeTimer = null;
    if (!isRunning()) return;
    // "Waiting on you" outranks the subagent skip: when a card is open it is the
    // single most useful thing to say, and staying silent reads as a hang.
    if (hasKnownSubagents() && !hasPendingUserInput()) {
      armProgressNoticeTimer({ reset: true });
      return;
    }
    if (emitGenericToolProgressNotice()) {
      armProgressNoticeTimer({ reset: true });
      return;
    }
    ingest([{
      type: "engine.notice",
      payload: {
        notice: {
          code: "longWait",
          level: "progress",
          panel: true,
          replace: true,
          replacesCode: "longWait",
        },
      },
    }]);
    armProgressNoticeTimer({ reset: true });
  }

  function forceEndTurn(reason) {
    if (!isRunning()) return;
    // A permission/question is intentional backpressure. The user may leave the
    // card open for hours; treating that silence as a dead engine loses the
    // parent turn and produces the misleading "question" incomplete summary.
    if (hasPendingUserInput()) {
      log.info("opencode turn is waiting for user input; watchdog paused", { sessionId, reason });
      clearResponseTimer();
      clearProgressNoticeTimer();
      clearTurnWatchdog();
      return;
    }
    log.warn("opencode turn force-ended: %s", reason, { sessionId });
    void (async () => {
      const recovered = await recoverStalledFinal().catch((err) => {
        log.warn("opencode stalled history sync failed: %s", err?.message || err);
        return null;
      });
      if (!isRunning()) return;
      if (recovered?.output) {
        completeTurn({
          code: 0,
          output: recovered.output,
          interrupted: false,
          engineMessageId: recovered.engineMessageId || null,
          resultFromOfficialHistory: true,
          recoveredFromStall: true,
        });
        return;
      }
      try { void getServer()?.abort?.().catch(() => {}); } catch { /* best effort */ }
      completeTurn({ code: 0, output: String(getState().collectedOutput || "").trim(), stalled: true });
    })();
  }

  function armResponseTimer() {
    clearResponseTimer();
    if (!isRunning()) return;
    responseTimer = scheduleTimer(() => {
      if (hasActiveToolLease()) {
        log.info("opencode no-progress window extended for active tool", {
          sessionId,
          activeTools: activeTools.size,
        });
        emitGenericToolProgressNotice();
        armProgressNoticeTimer();
        armResponseTimer();
        return;
      }
      forceEndTurn("no progress for the no-progress window");
    }, getConfig().responseTimeoutMs);
  }

  function clearTurnWatchdog() {
    if (turnWatchdogTimer) cancelTimer(turnWatchdogTimer);
    turnWatchdogTimer = null;
  }

  function armTurnWatchdog() {
    clearTurnWatchdog();
    if (!isRunning()) return;
    const cap = Number(getConfig().turnWatchdogMs || 0);
    if (!(cap > 0)) return;
    turnWatchdogTimer = scheduleTimer(() => forceEndTurn("turn exceeded the maximum time budget"), cap);
  }

  function clearHealthProbe() {
    if (healthTimer) cancelTimer(healthTimer);
    healthTimer = null;
    healthFails = 0;
  }

  function armHealthProbe() {
    clearHealthProbe();
    const tick = async () => {
      healthTimer = null;
      if (!isRunning() || !getServer()) return;
      const ok = await getServer().checkHealth().catch(() => false);
      if (!isRunning() || !getServer()) return;
      if (ok) {
        healthFails = 0;
      } else if (++healthFails >= getConfig().healthMaxFails) {
        log.warn("opencode health probe failed %d× — engine wedged/unreachable", healthFails, { sessionId });
        onServerError(new Error("engine health check failed (wedged or unreachable)"));
        return;
      }
      healthTimer = scheduleTimer(tick, getConfig().healthProbeMs);
      healthTimer?.unref?.();
    };
    healthTimer = scheduleTimer(tick, getConfig().healthProbeMs);
    healthTimer?.unref?.();
  }

  return {
    armHealthProbe,
    armProgressNoticeTimer,
    armResponseTimer,
    armTurnWatchdog,
    clearHealthProbe,
    clearProgressNoticeTimer,
    clearResponseTimer,
    clearTurnWatchdog,
    diagnostics: () => ({
      response: Boolean(responseTimer),
      progressNotice: Boolean(progressNoticeTimer),
      health: Boolean(healthTimer),
    }),
    awaitingUserDetail,
    emitGenericToolProgressNotice,
    emitLongWaitNotice,
    forceEndTurn,
    noteEngineRetry,
    genericToolProgressDetail,
    hasActiveToolLease,
    resetProgressNotice: () => { lastGenericToolProgressNotice = ""; engineRetryCount = 0; },
  };
}

module.exports = {
  compactProgressText,
  createOpencodeTurnLiveness,
  formatDuration,
};
