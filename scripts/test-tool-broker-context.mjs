#!/usr/bin/env node
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { resolveToolBrokerContext } = require("../src/main/mcp/tool-broker-context.js");

try {
  const sessions = new Map([
    ["s1", { id: "s1", projectId: "p1", enabledSkillIds: ["lily-mail-assistant"], permissionModeId: "full" }],
  ]);
  const projects = new Map([
    ["p1", { id: "p1", path: "/tmp/workspace-one" }],
  ]);
  const ctx = resolveToolBrokerContext({
    sessionId: "s1",
    sessionManager: { findById: (id) => sessions.get(id) || null },
    projectManager: { find: (id) => projects.get(id) || null },
    skillManager: { resolveSessionSkillIds: (session) => [...session.enabledSkillIds, "lily-runtime-packs"] },
    permissionSettings: { resolveSessionPermissionMode: (session) => session.permissionModeId || "ask" },
    connectorStatus: { mailConnected: true },
    runtime: { browserAvailable: false },
  });

  assert(ctx.ok === true, "known session resolves");
  assert(ctx.sessionId === "s1", "context carries session id");
  assert(ctx.workspacePath === "/tmp/workspace-one", "context carries workspace path");
  assert(ctx.permissionMode === "full", "context carries permission mode");
  assert(JSON.stringify(ctx.activeSkillIds.sort()) === JSON.stringify(["lily-mail-assistant", "lily-runtime-packs"]), "context uses skill manager's session skill ids");
  assert(ctx.connectorStatus.mailConnected === true, "context carries connector status");
  assert(ctx.runtime.browserAvailable === false, "context carries runtime status");

  const missing = resolveToolBrokerContext({});
  assert(missing.ok === false && missing.error === "SESSION_ID_REQUIRED", "missing session id fails closed");

  const unknown = resolveToolBrokerContext({
    sessionId: "missing",
    sessionManager: { findById: () => null },
  });
  assert(unknown.ok === false && unknown.error === "SESSION_NOT_FOUND", "unknown session fails closed");

  console.log("PASS: test-tool-broker-context (9 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
