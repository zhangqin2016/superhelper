#!/usr/bin/env node
// Conversation-created scheduled tasks, closed loop: the schedule_task_*
// broker tools reach the MAIN-process ScheduledTaskManager over the token-
// authed connector bridge, bind to the active conversation/workspace (same as
// the Auto-run composer entry), and fail safe when the bridge or scope is
// missing.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-sched-bridge-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = tmp;
process.env.LILY_DOCUMENTS_DIR = tmp;
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const { ensureConnectorBridgeStarted, stopConnectorBridge } = require("../src/main/connector-bridge.js");
const { ScheduledTaskManager } = require("../src/main/scheduled-tasks.js");
const { STATIC_TOOL_DEFINITIONS, findBrokerTool, buildBrokerTools } = require("../src/main/mcp/tool-broker-registry.js");

const manager = new ScheduledTaskManager();
manager.load();
let activeScope = { sessionId: "sess_1", projectId: "proj_1" };

const fakeMailStore = { listAccountsPublic: () => [] };
const state = await ensureConnectorBridgeStarted({
  mailStore: fakeMailStore,
  webCredentialStore: { findCredentialForUrl: () => null },
  scheduledTaskManager: manager,
  resolveActiveScope: () => activeScope,
});
process.env.LILY_CONNECTOR_BRIDGE_URL = state.url;
process.env.LILY_CONNECTOR_BRIDGE_TOKEN = state.token;

try {
  // --- registry surface ---------------------------------------------------
  const createDef = STATIC_TOOL_DEFINITIONS.find((tool) => tool.id === "schedule_task_create");
  assert(createDef, "schedule_task_create is registered as a broker tool");
  assert.equal(createDef.requiredSkillIds.length, 0, "scheduling is platform-level, not skill-gated");
  assert.equal(createDef.annotations.destructiveHint, true, "creating future autonomous runs is flagged");
  assert.match(createDef.description, /Example call/, "few-shot example rides the description");
  const listDef = STATIC_TOOL_DEFINITIONS.find((tool) => tool.id === "schedule_task_list");
  assert.equal(listDef.annotations.readOnlyHint, true);
  const brokerTools = buildBrokerTools({ platformOnly: true });
  assert(brokerTools.some((tool) => tool.id === "schedule_task_create"),
    "the tool is exposed even in platform-only context (lite models keep it)");

  const brokerContext = { platformOnly: true, activeSkillIds: [] };

  // --- end to end: broker handler → bridge → real manager ------------------
  const created = await findBrokerTool(brokerContext, "schedule_task_create").handler({
    prompt: "整理昨天的工作日志并总结要点",
    scheduleText: "每天早上9点",
  });
  assert.equal(created.ok, true, `create should succeed: ${JSON.stringify(created)}`);
  assert.equal(created.task.sessionId, "sess_1", "task binds to the active conversation");
  assert.equal(created.task.projectId, "proj_1", "task binds to the active workspace");
  assert.ok(created.task.nextRunAt, "the schedule parsed to a concrete next run");
  assert.ok(created.task.scheduleText, "the parsed schedule is echoed for user confirmation");

  const stored = JSON.parse(fs.readFileSync(path.join(tmp, "scheduled-tasks.json"), "utf8"));
  assert.equal(stored.tasks.length, 1, "the task persisted through the real manager");

  const listed = await findBrokerTool(brokerContext, "schedule_task_list").handler({});
  assert.equal(listed.ok, true);
  assert.equal(listed.tasks.length, 1, "list returns the workspace's tasks");
  assert.equal(listed.tasks[0].enabled, true);

  // --- guard rails ----------------------------------------------------------
  activeScope = null;
  const noScope = await findBrokerTool(brokerContext, "schedule_task_create").handler({
    prompt: "test", scheduleText: "每天早上9点",
  });
  assert.equal(noScope.ok, false);
  assert.equal(noScope.error, "NO_ACTIVE_SESSION", "no active conversation → explicit error, nothing created");
  activeScope = { sessionId: "sess_1", projectId: "proj_1" };

  const badSchedule = await findBrokerTool(brokerContext, "schedule_task_create").handler({
    prompt: "做点什么", scheduleText: "随便什么时候",
  });
  assert.equal(badSchedule.ok, false, "an unparseable schedule fails loudly instead of guessing");

  const unauthorized = await fetch(`${state.url}/v1/scheduled-tasks/create`, {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401, "the bridge stays token-authed");

  // Missing bridge env → fail safe.
  const savedUrl = process.env.LILY_CONNECTOR_BRIDGE_URL;
  delete process.env.LILY_CONNECTOR_BRIDGE_URL;
  const noBridge = await findBrokerTool(brokerContext, "schedule_task_create").handler({ prompt: "x", scheduleText: "每天9点" });
  assert.equal(noBridge.error, "SCHEDULER_BRIDGE_UNAVAILABLE");
  process.env.LILY_CONNECTOR_BRIDGE_URL = savedUrl;

  console.log("scheduled-task-bridge: ok");
} finally {
  stopConnectorBridge();
}
