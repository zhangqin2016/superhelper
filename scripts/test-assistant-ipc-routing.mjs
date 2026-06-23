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
  if (request.endsWith("./license-manager") || request === "./license-manager") {
    return { requireValidLicense: () => ({ ok: true }) };
  }
  if (request.endsWith("./scheduled-task-intent") || request === "./scheduled-task-intent") {
    return { looksLikeScheduledTaskIntent: () => false };
  }
  if (request.endsWith("./web-system-learning-intent") || request === "./web-system-learning-intent") {
    return {
      buildWebSystemLearningPrompt: (text) => text,
      ensureWebSystemLearningSkillForSession: async () => ({ ok: true }),
      looksLikeWebSystemLearningIntent: () => false,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { registerAssistantHandlers } = require("../src/main/ipc-assistant.js");
  const calls = {
    sessionSwitch: 0,
    projectSwitch: 0,
    sent: [],
    interrupted: [],
  };
  const sessions = new Map([
    ["active-session", { id: "active-session", projectId: "active-project" }],
    ["target-session", { id: "target-session", projectId: "target-project" }],
  ]);
  const ctx = {
    sessionManager: {
      activeSessionId: "active-session",
      findById: (id) => sessions.get(id) || null,
      getActive: () => sessions.get("active-session"),
      switchTo: () => {
        calls.sessionSwitch += 1;
      },
      pushMessageTo: () => {},
    },
    projectManager: {
      getActive: () => ({ id: "active-project" }),
      switchTo: () => {
        calls.projectSwitch += 1;
      },
    },
    turnOrchestrator: {
      sendUserMessage: async (sessionId, text, files, options) => {
        calls.sent.push({ sessionId, text, files, options });
        return { ok: true, turnId: "turn-send" };
      },
      interruptAndSend: async (sessionId, text, files, options) => {
        calls.interrupted.push({ sessionId, text, files, options });
        return { ok: true, turnId: "turn-interrupt" };
      },
    },
  };

  registerAssistantHandlers(ctx);
  assert.equal(typeof handlers.get("assistant:input"), "function", "assistant:input handler registered");
  assert.equal(
    typeof handlers.get("assistant:interrupt-and-send"),
    "function",
    "assistant:interrupt-and-send handler registered",
  );

  const sendResult = await handlers.get("assistant:input")(null, {
    sessionId: "target-session",
    text: "send in background",
    files: [{ path: "/tmp/a.txt" }],
    displayFiles: [{ name: "a.txt" }],
  });
  assert.deepEqual(sendResult, {
    ok: true,
    turnId: "turn-send",
    sessionId: "target-session",
    projectId: "target-project",
  });
  assert.equal(calls.sent.length, 1, "sendUserMessage called once");
  assert.equal(calls.sent[0].sessionId, "target-session");
  assert.equal(calls.sent[0].text, "send in background");
  assert.equal(calls.sent[0].options.displayFiles[0].name, "a.txt");

  const interruptResult = await handlers.get("assistant:interrupt-and-send")(null, {
    sessionId: "target-session",
    text: "priority background",
  });
  assert.deepEqual(interruptResult, {
    ok: true,
    turnId: "turn-interrupt",
    sessionId: "target-session",
    projectId: "target-project",
  });
  assert.equal(calls.interrupted.length, 1, "interruptAndSend called once");
  assert.equal(calls.interrupted[0].sessionId, "target-session");
  assert.equal(calls.sessionSwitch, 0, "targeted send must not switch active session");
  assert.equal(calls.projectSwitch, 0, "targeted send must not switch active project");

  console.log("assistant-ipc-routing: ok");
} finally {
  Module._load = originalLoad;
}
