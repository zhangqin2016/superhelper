"use strict";

const { DISPATCH_OUTCOME_UNKNOWN_ASSISTANT } = require("./turn-recovery-projection");
const FINALIZE_RECOVERY_ASSISTANT = "本次任务在收尾时遇到内部错误，已停止继续执行。请核对结果后手动重试。";

function recoverFinalizationFailure({ sessionId, type, payload, state, clearState, emit, terminalTypes, log }) {
  const turnId = state.turnId || null;
  const alreadyTerminal = state.terminalEmitted === true;
  const assistant = String(payload.assistant || state.assistantText || FINALIZE_RECOVERY_ASSISTANT).trim();
  try {
    clearState(state);
  } catch (clearErr) {
    state.phase = "idle";
    state.turnId = null;
    state.finalizing = false;
    log.warn("turn finalize fallback clear failed: %s", clearErr?.message || clearErr);
  }
  state.terminalEmitted = true;
  if (!turnId || alreadyTerminal) return;
  const fallbackType = terminalTypes.has(type) ? type : "turn.failed";
  emit(sessionId, fallbackType, {
    ...payload,
    assistant,
    errorCode: payload.errorCode || payload.code || "TURN_FINALIZE_FAILED",
    finalizationRecovered: true,
  }, { turnId });
}

module.exports = {
  recoverFinalizationFailure,
  DISPATCH_OUTCOME_UNKNOWN_ASSISTANT,
  FINALIZE_RECOVERY_ASSISTANT,
};
