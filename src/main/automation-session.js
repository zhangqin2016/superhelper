"use strict";

const crypto = require("node:crypto");

function createAutomationSession(manager, projectId, title, taskId) {
  const existing = manager.sessions[projectId]?.find(
    (session) => session.hidden === true && session.automationTaskId === taskId,
  );
  if (existing) return existing;
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    projectId,
    title: (title || "Automation").slice(0, 80),
    createdAt: now,
    updatedAt: now,
    status: "idle",
    hidden: true,
    automationTaskId: taskId,
    messages: [],
    messageCount: 0,
  };
  if (!manager.sessions[projectId]) manager.sessions[projectId] = [];
  manager.sessions[projectId].push(session);
  manager.saveImmediate();
  return session;
}

module.exports = { createAutomationSession };
