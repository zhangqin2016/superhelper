"use strict";

const { getLogger } = require("./logger");
const {
  createRequiredToolCompletionState,
  missingRequiredTools,
  noteRequiredToolDraft,
  successfulRequiredToolResults,
} = require("./required-tool-completion");

const log = getLogger("required-tool-completion-gate");
const states = new WeakMap();

function reset(session, requiredTools = []) {
  states.set(session, {
    completion: createRequiredToolCompletionState(requiredTools),
    attempts: 0,
  });
}

function note(session, draft) {
  const state = states.get(session);
  if (state) noteRequiredToolDraft(state.completion, draft);
}

function continueBeforeCompletion(session, payload) {
  const state = states.get(session);
  const missing = missingRequiredTools(state?.completion);
  if (
    !missing.length || payload?.interrupted || payload?.stalled || payload?.code !== 0
    || !session._server || session._pendingPermissions.size || session._pendingQuestions.size
  ) return false;

  if (state.attempts >= 2) {
    const message = "\n\n角色没有保存到角色库：持久化工具未成功执行，因此 Lily 没有把 Markdown 或普通文件当作角色。请重试创建；若问题持续，请检查 Character Worlds 与工具服务。";
    // Replace unverified assistant prose instead of appending a contradictory
    // failure notice after a claim that the entity was already saved.
    session.collectedOutput = message.trim();
    session._ingest([{ type: "assistant.delta", payload: { text: message } }]);
    session._settleTurn({
      ...payload,
      code: 1,
      error: message.trim(),
      failureCode: "CHARACTER_DRAFT_PERSISTENCE_FAILED",
      stalled: false,
      output: session.collectedOutput,
    });
    return true;
  }

  state.attempts += 1;
  session._armResponseTimer();
  session._armProgressNoticeTimer();
  const message = [
    "Required persistence check failed.",
    `Before finishing, you must call ${missing.join(", ")} natively and receive ok:true.`,
    "A Markdown, text, JSON, or workspace file is not a Character Worlds library entity.",
    "Repair validation errors and retry the tool. Do not claim success until the tool confirms persistence.",
    `Correction attempt: ${state.attempts}/2.`,
  ].join(" ");
  session._server.sendPrompt({ text: message, files: [] }).catch((error) => {
    log.warn("required tool completion follow-up failed: %s", error?.message || String(error));
    if (session.busy && !session._turnSettled) {
      state.attempts = 2;
      continueBeforeCompletion(session, payload);
    }
  });
  return true;
}

function results(session) {
  return successfulRequiredToolResults(states.get(session)?.completion);
}

function finish(session, payload) {
  if (payload && typeof payload === "object") payload.requiredToolResults = results(session);
  reset(session);
}

module.exports = { continueBeforeCompletion, finish, note, reset, results };
