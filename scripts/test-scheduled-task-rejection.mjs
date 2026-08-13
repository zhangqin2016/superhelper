#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const handlers = new Map();
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { registerScheduledTaskHandlers } = require("../src/main/ipc-scheduled-tasks.js");
  const messages = new Map([[
    "draft-message",
    {
      id: "draft-message",
      meta: {
        scheduledDraft: {
          status: "pending",
          originalText: "这个页面要每小时刷新价格，并分析方案",
          draft: {
            title: "刷新价格",
            prompt: "刷新价格",
            scheduleText: "Hourly",
          },
        },
      },
    },
  ]]);
  const sent = [];
  const taskActions = [];
  const ctx = {
    sessionManager: {
      activeSessionId: "session-1",
      findById: (id) => id === "session-1" ? { id, projectId: "project-1" } : null,
      findMessage: (_sessionId, messageId) => messages.get(messageId) || null,
      updateMessageMeta: (_sessionId, messageId, mutate) => {
        const message = messages.get(messageId);
        message.meta = mutate(message.meta);
        return message;
      },
      getConversationPage: () => ({ conversation: [...messages.values()] }),
    },
    scheduledTaskManager: {
      create: () => {
        throw new Error("rejecting a draft must never create a scheduled task");
      },
      runNow: (taskId, scope) => {
        taskActions.push({ taskId, scope });
        return { ok: true };
      },
    },
    turnOrchestrator: {
      sendUserMessage: async (sessionId, text, files, options) => {
        sent.push({ sessionId, text, files, options });
        return { ok: true, turnId: "normal-turn" };
      },
    },
  };

  registerScheduledTaskHandlers(ctx);
  const reject = handlers.get("scheduled-tasks:reject-draft-message");
  const create = handlers.get("scheduled-tasks:create-from-draft-message");
  const runNow = handlers.get("scheduled-tasks:run-now");
  assert.equal(typeof reject, "function", "reject-draft IPC handler must be registered");
  assert.equal(typeof create, "function", "create-draft IPC handler must be registered");
  assert.equal(typeof runNow, "function", "run-now IPC handler must be registered");

  const missingScope = await reject(null, { messageId: "draft-message" });
  assert.deepEqual(
    missingScope,
    { ok: false, error: "SESSION_ID_REQUIRED" },
    "a delayed scheduled-task action must never fall back to whichever conversation is active",
  );
  assert.equal(sent.length, 0, "missing scope must not dispatch the draft into the active conversation");

  const unscopedRun = await runNow(null, { taskId: "task-1" });
  assert.deepEqual(unscopedRun, { ok: false, error: "SESSION_ID_REQUIRED" });
  assert.equal(taskActions.length, 0, "an unscoped task action must not operate on the active conversation");
  const scopedRun = await runNow(null, {
    taskId: "task-1",
    sessionId: "session-1",
    projectId: "project-1",
  });
  assert.deepEqual(scopedRun, { ok: true });
  assert.deepEqual(taskActions, [{
    taskId: "task-1",
    scope: { sessionId: "session-1", projectId: "project-1", error: "" },
  }], "task mutations must carry their immutable conversation scope into the manager");

  messages.get("draft-message").meta.scheduledDraft.status = "rejecting";
  const createDuringReject = await create(null, { sessionId: "session-1", messageId: "draft-message" });
  assert.deepEqual(
    createDuringReject,
    { ok: false, error: "DRAFT_NOT_PENDING" },
    "a draft being rejected into a normal turn must never be created as a task",
  );
  messages.get("draft-message").meta.scheduledDraft.status = "pending";

  const first = await reject(null, { sessionId: "session-1", messageId: "draft-message" });
  assert.equal(first.ok, true, "rejecting a pending draft should succeed");
  assert.equal(sent.length, 1, "the original request should dispatch exactly once");
  assert.deepEqual(sent[0], {
    sessionId: "session-1",
    text: "这个页面要每小时刷新价格，并分析方案",
    files: [],
    options: {
      recordUser: false,
      scheduleDraftRejected: true,
      sourceTurnId: null,
    },
  }, "the exact original text must continue through the ordinary agent path");
  assert.equal(messages.get("draft-message").meta.scheduledDraft.status, "rejected");

  const second = await reject(null, { sessionId: "session-1", messageId: "draft-message" });
  assert.deepEqual(second, { ok: false, error: "DRAFT_NOT_PENDING" });
  assert.equal(sent.length, 1, "a repeated reject click must not dispatch a duplicate normal turn");

  console.log("scheduled-task-rejection: ok");
} finally {
  Module._load = originalLoad;
}
