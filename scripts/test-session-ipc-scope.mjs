#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const handlers = new Map();
const originalLoad = Module._load;
const calls = { conversations: [], skills: [] };

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } }, dialog: {} };
  }
  if (request.endsWith("./ipc-utils") || request === "./ipc-utils") {
    return { ensureSessionRunner: () => ({ runner: null }), isSessionBusy: () => false, withRunnerChange: (_ctx, fn) => fn(), anyRunnerBusy: () => false };
  }
  if (request.endsWith("./skill-manager") || request === "./skill-manager") {
    return { normalizeSessionSkillSelection: (value) => value || [], listSkillsForSessionPublic: () => ({ skills: [] }), writeSessionAgentGuide: () => {}, getDisallowedTools: () => [], resolveSessionSkillIds: () => [] };
  }
  if (request.endsWith("./commands") || request === "./commands") {
    return { loadCommands: () => [], expandCommand: () => null };
  }
  if (request.endsWith("./license-manager") || request === "./license-manager") {
    return { requireValidLicense: () => ({ ok: true }) };
  }
  if (request.endsWith("./permission-settings") || request === "./permission-settings") {
    return { listSessionPermissionsPublic: () => ({}), resolveSessionPermissionMode: () => "confirm" };
  }
  if (request.endsWith("./opencode-conversation-source") || request === "./opencode-conversation-source") {
    return {
      getConversationPageFromSource: async (_ctx, sessionId) => {
        calls.conversations.push(sessionId);
        return { ok: true, sessionId, conversation: [] };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { registerSessionHandlers } = require("../src/main/ipc-sessions.js");
  const sessions = new Map([
    ["session-a", { id: "session-a", projectId: "project-a" }],
    ["session-b", { id: "session-b", projectId: "project-b" }],
  ]);
  const ctx = {
    sessionManager: {
      activeSessionId: "session-a",
      findById: (id) => sessions.get(id) || null,
      setEnabledSkillIds: (id) => { calls.skills.push(id); return true; },
    },
    projectManager: {
      getActive: () => ({ id: "project-a" }),
      find: (id) => ({ id, path: `/workspace/${id}` }),
      switchTo: () => {},
    },
    runnerPool: { has: () => false, get: () => null, terminateSession: () => {} },
  };

  registerSessionHandlers(ctx);
  const read = handlers.get("session:get-conversation");
  const setSkills = handlers.get("session:set-skills");
  assert.equal(typeof read, "function");
  assert.equal(typeof setSkills, "function");

  assert.deepEqual(
    await read(null, {}),
    { ok: false, error: "SESSION_ID_REQUIRED", conversation: [] },
    "a history read without a session id must not reveal the active conversation",
  );
  assert.deepEqual(
    await setSkills(null, { enabledSkillIds: ["lily-test"] }),
    { ok: false, error: "SESSION_ID_REQUIRED" },
    "a delayed settings action must not mutate the active conversation",
  );
  assert.deepEqual(calls, { conversations: [], skills: [] });

  assert.deepEqual(
    await read(null, { sessionId: "session-b" }),
    { ok: true, sessionId: "session-b", conversation: [] },
    "an explicit session id remains routed to the requested conversation",
  );
  assert.deepEqual(calls.conversations, ["session-b"]);
  console.log("session-ipc-scope: ok");
} finally {
  Module._load = originalLoad;
}
