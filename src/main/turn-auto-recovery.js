"use strict";

const { isUpstreamApiFailure, sanitizeError } = require("./agent-runner");

const MAX_AUTO_RETRIES = 2;
const RECOVERY_DELAYS_MS = [1500, 3000];

/** @type {Map<string, { text: string, files: unknown[], attempt: number, maxRetries: number }>} */
const turnRecoveryState = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const recoveryTimers = new Map();

const NON_RECOVERABLE = /resume|session.*not found|unknown session|Session ID .* already in use|消息内容为空|permission|BUSY/i;

function isRecoverableFailure(raw) {
  const text = String(raw || "").trim();
  if (!text || text === "BUSY") return false;
  if (NON_RECOVERABLE.test(text)) return false;
  if (isUpstreamApiFailure(text)) return true;
  if (/助手连接已断开|RUNNER_NOT_READY|助手引擎未接受|助手引擎进程未能启动/i.test(text)) {
    return true;
  }
  return false;
}

function recordTurnPayload(sessionId, payload) {
  if (!sessionId) return;
  turnRecoveryState.set(sessionId, {
    text: String(payload.text || "").trim(),
    files: Array.isArray(payload.files) ? payload.files : [],
    attempt: 0,
    maxRetries: MAX_AUTO_RETRIES,
  });
}

function cancelAutoRecovery(sessionId) {
  const timer = recoveryTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    recoveryTimers.delete(sessionId);
  }
  turnRecoveryState.delete(sessionId);
}

function clearTurnPayloadOnSuccess(sessionId) {
  cancelAutoRecovery(sessionId);
}

/**
 * Schedule an automatic re-dispatch of the last user turn payload.
 * @param {object} ctx
 * @param {string} sessionId
 * @param {string} reason
 * @param {{ turnId?: string | null, sendToRenderer: Function, mainWindow: import('electron').BrowserWindow | null }} meta
 * @returns {boolean}
 */
function scheduleAutoRecovery(ctx, sessionId, reason, meta = {}) {
  const pending = turnRecoveryState.get(sessionId);
  if (!pending || pending.attempt >= pending.maxRetries) return false;
  if (!isRecoverableFailure(reason)) return false;

  pending.attempt += 1;
  const attempt = pending.attempt;
  const maxRetries = pending.maxRetries;
  const delayMs = RECOVERY_DELAYS_MS[attempt - 1] ?? RECOVERY_DELAYS_MS.at(-1);

  cancelAutoRecoveryTimerOnly(sessionId);

  meta.sendToRenderer?.(meta.mainWindow, "assistant:auto-recover", {
    sessionId,
    attempt,
    maxRetries,
    delayMs,
    turnId: meta.turnId ?? null,
  });

  meta.sendToRenderer?.(meta.mainWindow, "assistant:engine-notice", {
    sessionId,
    code: "autoRecover",
    level: "progress",
    panel: true,
    replace: true,
    attempt,
    maxRetries,
    done: false,
  });

  const timer = setTimeout(() => {
    recoveryTimers.delete(sessionId);
    void executeAutoRecovery(ctx, sessionId, reason, meta);
  }, delayMs);

  recoveryTimers.set(sessionId, timer);
  return true;
}

function isRecoveryPending(sessionId) {
  return recoveryTimers.has(sessionId);
}

function cancelAutoRecoveryTimerOnly(sessionId) {
  const timer = recoveryTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    recoveryTimers.delete(sessionId);
  }
}

async function executeAutoRecovery(ctx, sessionId, priorReason, meta) {
  const pending = turnRecoveryState.get(sessionId);
  if (!pending) return;

  const { sessionManager, runnerPool } = ctx;
  const session = sessionManager.findById(sessionId);
  if (!session) {
    finalizeRecoveryFailure(ctx, sessionId, priorReason, meta);
    return;
  }

  runnerPool.terminateSession(sessionId);

  const { dispatchUserLine } = require("./ipc-utils");
  const result = await dispatchUserLine(ctx, session, pending.text, pending.files, {
    recordUser: false,
    spawnEngine: true,
    fromAutoRecovery: true,
  });

  if (result.ok) {
    meta.sendToRenderer?.(meta.mainWindow, "assistant:engine-notice", {
      sessionId,
      code: "autoRecover",
      level: "info",
      panel: true,
      replace: true,
      done: true,
    });
    return;
  }

  const detail = result.detail || result.error || priorReason;
  if (isRecoverableFailure(detail) && pending.attempt < pending.maxRetries) {
    scheduleAutoRecovery(ctx, sessionId, detail, meta);
    return;
  }

  finalizeRecoveryFailure(ctx, sessionId, detail, meta);
}

function finalizeRecoveryFailure(ctx, sessionId, message, meta = {}) {
  cancelAutoRecovery(sessionId);
  const { sessionManager } = ctx;
  const { emitTurnState } = require("./turn-controller");
  const friendly = sanitizeError(String(message || ""));

  sessionManager.pushMessageTo(sessionId, "assistant", friendly, null, {
    failed: true,
  });
  emitTurnState(ctx, sessionId);
  meta.sendToRenderer?.(meta.mainWindow, "assistant:engine-notice", {
    sessionId,
    code: "autoRecover",
    level: "warning",
    panel: true,
    replace: true,
    done: true,
  });
  meta.sendToRenderer?.(meta.mainWindow, "assistant:error", {
    sessionId,
    message: friendly,
  });
  const { scheduleFlushMessageQueue } = require("./turn-message-queue");
  scheduleFlushMessageQueue(ctx, sessionId);
}

module.exports = {
  MAX_AUTO_RETRIES,
  isRecoverableFailure,
  isRecoveryPending,
  recordTurnPayload,
  cancelAutoRecovery,
  clearTurnPayloadOnSuccess,
  scheduleAutoRecovery,
};
