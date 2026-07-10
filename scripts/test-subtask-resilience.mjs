#!/usr/bin/env node
// Subtask resilience (子任务不再哑死) — closed loop for the three rules that
// previously existed ONLY at the parent-turn level:
//   1. subtask-guard plugin: an empty-but-"completed" task_result gets a
//      corrective note so the parent model recovers itself.
//   2. subagent engine errors flow into subagent.event (+lastError), emit a
//      timeline warning, reach model-failure diagnostics, and trigger
//      BACKGROUND self-heal for healable signatures — without touching the
//      running turn.
//   3. subagent persona carries a compact tool-protocol appendix (kill switch
//      LILY_SUBAGENT_PROTOCOL_HINTS=0).

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-subtask-resilience-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

const waitFor = async (predicate, message, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
};
const settleAsync = () => new Promise((resolve) => setImmediate(resolve));

// --- 1. subtask-guard plugin -------------------------------------------------

const { SubtaskGuardPlugin } = await import("../resources/opencode-plugins/subtask-guard.js");
const guard = await SubtaskGuardPlugin();
const hook = guard["tool.execute.after"];
assert.equal(typeof hook, "function", "plugin exposes tool.execute.after");

const emptyCompleted = [
  '<task id="ses_child" state="completed">',
  "<task_result>",
  "",
  "</task_result>",
  "</task>",
].join("\n");

{
  const output = { output: emptyCompleted };
  await hook({ tool: "task", sessionID: "s1" }, output);
  assert.match(output.output, /\[subtask\]/, "empty completed task_result must get the corrective note");
}
{
  const output = { content: [{ type: "text", text: emptyCompleted }] };
  await hook({ tool: "task", sessionID: "s1" }, output);
  assert.equal(output.content.length, 2, "content-array outputs get the note as an extra text block");
  assert.match(output.content[1].text, /\[subtask\]/);
}
{
  const output = { output: emptyCompleted.replace("<task_result>\n\n</task_result>", "<task_result>real handoff text</task_result>") };
  await hook({ tool: "task", sessionID: "s1" }, output);
  assert.doesNotMatch(output.output, /\[subtask\]/, "non-empty handoffs must stay untouched");
}
{
  const output = { output: emptyCompleted.replace('state="completed"', 'state="error"') };
  await hook({ tool: "task", sessionID: "s1" }, output);
  assert.doesNotMatch(output.output, /\[subtask\]/, "error-state results already carry the failure — no note");
}
{
  const output = { output: emptyCompleted };
  await hook({ tool: "bash", sessionID: "s1" }, output);
  assert.doesNotMatch(output.output, /\[subtask\]/, "non-task tools are never touched");
}
{
  process.env.LILY_SUBTASK_GUARD = "0";
  const output = { output: emptyCompleted };
  await hook({ tool: "task", sessionID: "s1" }, output);
  assert.doesNotMatch(output.output, /\[subtask\]/, "kill switch disables the guard");
  delete process.env.LILY_SUBTASK_GUARD;
}

// --- 2. subagent engine error → observe + learn ------------------------------

// Stub self-heal + service-client BEFORE the orchestrator first requires them.
const selfHealCalls = [];
const selfHealPath = require.resolve("../src/main/model-self-heal.js");
require.cache[selfHealPath] = {
  id: selfHealPath,
  filename: selfHealPath,
  loaded: true,
  exports: {
    attemptModelSelfHeal: async (args) => {
      selfHealCalls.push(args);
      return { attempted: true, healed: false };
    },
    isHealableFailureCode: (code) =>
      ["EMPTY_ASSISTANT_COMPLETION", "MALFORMED_TOOL_CALL_TEXT", "RESPONSE_ERROR"].includes(String(code || "")),
    resetSelfHealStateForTests: () => {},
  },
};
const runtimeDiagnosticReports = [];
const serviceClientPath = require.resolve("../src/main/service-client.js");
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    reportUsage: async () => ({ ok: true }),
    reportRuntimeDiagnostic: async (payload) => {
      runtimeDiagnosticReports.push(payload);
      return { ok: true, json: { id: "diag_test" } };
    },
  },
};

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");

class FakeRunner extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.busy = false;
    this.spawnOptions = {};
  }
  isBusy() { return this.busy; }
  isAlive() { return true; }
  sendUserMessage() {
    this.busy = true;
    this.emit("status", "thinking");
    return true;
  }
  interrupt() { this.busy = false; }
  diagnostics() { return { sessionId: this.sessionId, busy: this.busy }; }
}

const sent = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
};
const messages = [];
const session = { id: "s1", projectId: "p1", messages };
const runner = new FakeRunner("s1");
const ctx = {
  get mainWindow() { return fakeWindow; },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: {
    findById: (id) => (id === "s1" ? session : null),
    getActive: () => session,
    pushMessageTo: (_sessionId, role, content, files, extra) => messages.push({ role, content, files, ...extra }),
    popLastAssistantMessage: () => false,
    getLastUserMessage: () => messages.find((m) => m.role === "user") || null,
    findAgentResumeOwner: () => null,
    setAgentResumeId: () => {},
    claimAgentResumeId: () => ({ ok: true, evictedSessionIds: [] }),
    clearAgentResumeId: () => true,
  },
  projectManager: { find: () => ({ id: "p1", path: process.cwd() }) },
  runnerPool: {
    get: () => runner,
    ensure: () => runner,
    terminateSession: () => {},
    getSessionIds: () => ["s1"],
  },
  scheduledTaskManager: { completeQueuedRun: () => true },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager, { eventBus: ctx.eventBus });
ctx.turnOrchestrator = new TurnOrchestrator(ctx);
ctx.turnOrchestrator.bindRunner(runner);

const flushEvents = () => {
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  sent.length = 0;
  return events;
};

const sendResult = await ctx.turnOrchestrator.sendUserMessage("s1", "run a subtask", [], {
  spawnEngine: false,
  skipPreflight: true,
});
assert.equal(sendResult.ok, true, `turn must start: ${JSON.stringify(sendResult)}`);
flushEvents();

// Healable child engine error (the runtime face of a gateway that streams
// nothing / answers with an error page).
ctx.turnOrchestrator.ingest("s1", [{
  type: "subagent.event",
  payload: {
    sessionId: "ses_child_1",
    events: [{ kind: "error", message: "Error: empty response from upstream gateway", ts: Date.now() }],
  },
}]);
await new Promise((resolve) => setTimeout(resolve, 20));
{
  const events = flushEvents();
  const sub = events.find((event) => event.type === "subagent.event");
  assert(sub, "subagent error must still produce a subagent.event for the UI");
  assert.equal(sub.payload.subagent.status, "failed", "child engine death marks the subagent failed");
  assert.match(sub.payload.subagent.lastError.message, /empty response/, "lastError carries the real reason");
  const warning = events.find((event) =>
    event.type === "engine.warning" && event.payload?.notice?.code === "subagentEngineError");
  assert(warning, "child engine errors must surface as a timeline warning");
  assert.match(String(warning.payload.notice.detail || ""), /empty response/);
}
assert.equal(selfHealCalls.length, 1, "healable child error must trigger background self-heal");
assert.equal(selfHealCalls[0].code, "RESPONSE_ERROR", "self-heal receives the classified healable code");
assert.equal(runtimeDiagnosticReports.length, 1, "model-category child errors must reach diagnostics");
assert(runner.busy, "background learning must never interrupt the running turn");

// Non-healable, non-model child error: observed but no heal, no model diagnostic.
ctx.turnOrchestrator.ingest("s1", [{
  type: "subagent.event",
  payload: {
    sessionId: "ses_child_2",
    events: [{ kind: "error", message: "EACCES: permission denied, open /etc/hosts", ts: Date.now() }],
  },
}]);
await new Promise((resolve) => setTimeout(resolve, 20));
{
  const events = flushEvents();
  const sub = events.find((event) => event.type === "subagent.event");
  assert(sub, "non-model child errors still reach the UI");
  assert.equal(sub.payload.subagent.status, "failed");
}
assert.equal(selfHealCalls.length, 1, "non-healable child errors must not trigger self-heal");
assert.equal(runtimeDiagnosticReports.length, 1, "non-model child errors must not spam model diagnostics");

runner.busy = false;
runner.emit("done", { code: 0, output: "done" });
await settleAsync();
flushEvents();

// Parent runner errors must use the same model self-heal wiring as terminal
// failure payloads. Reset the child-error observations so exact-once is clear.
selfHealCalls.length = 0;
const parentHealTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "trigger a healable parent error", [], {
  spawnEngine: false,
  skipPreflight: true,
});
assert.equal(parentHealTurn.ok, true, `healable parent turn must start: ${JSON.stringify(parentHealTurn)}`);
flushEvents();
runner.emit("error", "Error: empty response from upstream gateway");
runner.emit("done", { code: 0, output: "late duplicate completion" });
const parentErrorEvents = flushEvents();
const parentTerminalEvents = parentErrorEvents.filter((event) =>
  ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type));
assert.equal(parentTerminalEvents.length, 1, "error followed by done emits exactly one parent terminal event");
assert.equal(parentTerminalEvents[0].type, "turn.failed", "runner error owns the parent terminal result");
await waitFor(() => selfHealCalls.length === 1, "healable parent runner error must reach self-heal exactly once");
assert.equal(selfHealCalls.length, 1, "healable parent runner error triggers self-heal exactly once");
assert.equal(selfHealCalls[0].code, "RESPONSE_ERROR", "parent runner self-heal receives the classified RESPONSE_ERROR code");
flushEvents();

runner.busy = false;
const parentNonHealTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "trigger a non-healable parent error", [], {
  spawnEngine: false,
  skipPreflight: true,
});
assert.equal(parentNonHealTurn.ok, true, `non-healable parent turn must start: ${JSON.stringify(parentNonHealTurn)}`);
flushEvents();
runner.emit("error", "EACCES: permission denied, open /etc/hosts");
const nonHealEvents = flushEvents();
assert.equal(nonHealEvents.filter((event) => event.type === "turn.failed").length, 1,
  "non-healable parent error still emits exactly one failed terminal");
await settleAsync();
await settleAsync();
assert.equal(selfHealCalls.length, 1, "non-healable parent runner error does not trigger another self-heal");
flushEvents();

// --- 3. subagent persona protocol appendix -----------------------------------

const { SessionRunnerPool } = require("../src/main/session-runner-pool.js");
const pool = new SessionRunnerPool();
{
  const appended = pool._appendSubagentProtocolHints("You are a subtask agent.");
  assert.match(appended, /Tool Protocol \(compact\)/, "persona gains the compact protocol appendix");
  assert.match(appended, /lily_file_intelligence/, "appendix covers the large-input rule");
  assert.match(appended, /lily_process_jobs/, "appendix covers the process-job rule");
  assert(appended.length - "You are a subtask agent.".length < 1200, "appendix must stay compact for small system budgets");
}
{
  process.env.LILY_SUBAGENT_PROTOCOL_HINTS = "0";
  const appended = pool._appendSubagentProtocolHints("You are a subtask agent.");
  assert.equal(appended, "You are a subtask agent.", "kill switch restores the bare persona");
  delete process.env.LILY_SUBAGENT_PROTOCOL_HINTS;
}
assert.equal(pool._appendSubagentProtocolHints(""), "", "no persona → no appendix (OpenCode baseline stays untouched)");

// --- 4. plugin registration ---------------------------------------------------

const plugins = pool._opencodePlugins();
assert(plugins.some((p) => p.endsWith("subtask-guard.js")), "subtask-guard must be registered alongside loop-detector");

console.log("subtask-resilience: ok");
