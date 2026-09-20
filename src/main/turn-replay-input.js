"use strict";

const { effectiveUserRequest, effectiveInputFiles } = require("./turn-user-context");

// Reuse accepted, durable user messages; never scan another turn or full history.
async function turnReplayInput(manager, sessionId, source) {
  if (!source || source.sessionId !== sessionId || !source.turnId) throw new Error("TASK_CONTINUATION_SOURCE_UNAVAILABLE");
  const userRevisions = await manager.getTurnUserRevisionsAsync?.(sessionId, source.turnId) || [];
  const state = { turnId: source.turnId, userRevisions, enginePayload: { rawText: source.userText, files: source.files || [] } };
  return { content: effectiveUserRequest(state), files: effectiveInputFiles(state), turnId: source.turnId };
}

module.exports = { turnReplayInput };
