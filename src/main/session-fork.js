"use strict";

const crypto = require("node:crypto");

function forkSessionAtTurn(manager, sourceSessionId, title, turnId) {
  const source = manager._find(sourceSessionId);
  if (!source) throw new Error("SESSION_NOT_FOUND");
  const boundaryTurnId = String(turnId || "").trim();
  if (!boundaryTurnId) throw new Error("TURN_REQUIRED");
  const sourceMessages = manager._messages(source);
  let boundary = -1;
  for (let index = 0; index < sourceMessages.length; index += 1) {
    if (String(sourceMessages[index]?.turnId || "") === boundaryTurnId) boundary = index;
  }
  if (boundary < 0) throw new Error("CHECKPOINT_TURN_NOT_FOUND");

  const forked = manager.create(source.projectId, title || `${source.title || "Session"} (fork)`);
  for (const key of ["enabledSkillIds", "permissionModeId"]) {
    if (source[key] !== undefined) forked[key] = Array.isArray(source[key]) ? [...source[key]] : source[key];
  }
  const messages = sourceMessages.slice(0, boundary + 1).map((message) => ({
    ...structuredClone(message),
    id: `msg_${crypto.randomUUID()}`,
  }));
  if (messages.length) manager._store().bulkInsert(forked.id, messages);
  delete forked.agentResumeId;
  delete forked.agentResumeBinding;
  forked.messageCount = messages.length;
  forked.updatedAt = new Date().toISOString();
  manager.saveImmediate();
  return forked;
}

module.exports = { forkSessionAtTurn };
