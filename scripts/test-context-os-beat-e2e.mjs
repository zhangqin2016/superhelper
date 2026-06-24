#!/usr/bin/env node

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-context-os-beat-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");
const { appendLearnedConvention } = require("../src/main/learned-context.js");

class FakeRunner extends EventEmitter {
  constructor(sessionId, orchestrator) {
    super();
    this.sessionId = sessionId;
    this.orchestrator = orchestrator;
    this.busy = false;
    this.sentPayloads = [];
  }
  isBusy() { return this.busy; }
  isAlive() { return true; }
  sendUserMessage(payload) {
    if (this.busy) return false;
    this.busy = true;
    this.sentPayloads.push(payload);
    return true;
  }
  finish(text = "done") {
    this.orchestrator.ingest(this.sessionId, [{ type: "assistant.delta", payload: { text } }]);
    this.busy = false;
    this.emit("done", { code: 0, output: text });
  }
  compactContext() {
    return Promise.resolve({ ok: true });
  }
}

const sent = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
};
const messages = [];
const session = { id: "beat_s1", projectId: "beat_p1", messages };
let runner;
const ctx = {
  get mainWindow() { return fakeWindow; },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: {
    findById: (id) => (id === session.id ? session : null),
    getActive: () => session,
    pushMessageTo: (_sessionId, role, content, files, extra) => messages.push({ role, content, files, ...extra }),
    popLastAssistantMessage: () => false,
    getLastUserMessage: () => messages.find((item) => item.role === "user") || null,
    setAgentResumeId: () => true,
    clearAgentResumeId: () => {},
  },
  projectManager: {
    find: () => ({ id: "beat_p1", path: process.cwd() }),
  },
  runnerPool: {
    get: () => runner,
    ensure: () => runner,
    getSessionIds: () => [session.id],
  },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager, { eventBus: ctx.eventBus });
ctx.turnOrchestrator = new TurnOrchestrator(ctx);
runner = new FakeRunner(session.id, ctx.turnOrchestrator);
ctx.turnOrchestrator.bindRunner(runner);

const fast = await ctx.turnOrchestrator.sendUserMessage(session.id, "你好", [], {
  spawnEngine: false,
  skipPreflight: true,
});
assert.equal(fast.ok, true);
ctx.turnOrchestrator.ingest(session.id, [
  { type: "usage.updated", payload: { usage: { input_tokens: 12, output_tokens: 3 } } },
]);
runner.finish("你好");
const fastRecord = messages.filter((item) => item.role === "assistant").at(-1).record;
assert.equal(fastRecord.meta.contextOsScorecard.maturity.parity, "pass");
assert.equal(fastRecord.meta.contextOsScorecard.maturity.beat, "incomplete", "fast turns must not claim beat maturity");
assert.equal(fastRecord.meta.contextOsScorecard.checks.find((item) => item.id === "fast_path_bounded").ok, true);
assert.equal(fastRecord.meta.contextOsScorecard.checks.find((item) => item.id === "beat_exact_tokenizer").ok, true);
assert.equal(
  fastRecord.meta.contextOsScorecard.checks.find((item) => item.id === "beat_subagent_runtime_telemetry").ok,
  false,
  "fast turns do not satisfy coverage subagent telemetry",
);

appendLearnedConvention("beat_p1", "覆盖型运行时排查先分配 Task 子代理并回传证据");
const coverage = await ctx.turnOrchestrator.sendUserMessage(session.id, "彻底检查所有 session.idle 串会话问题，不要漏", [], {
  spawnEngine: false,
  skipPreflight: true,
});
assert.equal(coverage.ok, true);
const coveragePayload = runner.sentPayloads.at(-1);
assert.equal(coveragePayload.trace.contextMemory.diagnostics.semanticIndex, "durable");
ctx.turnOrchestrator.ingest(session.id, [
  { type: "usage.updated", payload: { usage: { input_tokens: 456, output_tokens: 30 } } },
  { type: "tool.started", payload: { id: "task_runtime", name: "Task", input: { prompt: "audit session.idle routing" } } },
  { type: "tool.started", payload: { id: "read_runtime", name: "Read", input: { file_path: "src/main/runtime-event-bus.js" }, parentToolUseId: "task_runtime" } },
  { type: "tool.done", payload: { id: "read_runtime", status: "done", result: { content: "runtime-event-bus checked" } } },
  { type: "tool.done", payload: { id: "task_runtime", status: "done", result: { content: "handoff complete" } } },
]);
runner.finish("找到的结论需要证据门槛约束。");
const coverageRecord = messages.filter((item) => item.role === "assistant").at(-1).record;
assert.equal(coverageRecord.meta.contextOsScorecard.maturity.parity, "pass");
assert.equal(coverageRecord.meta.contextOsScorecard.maturity.beat, "pass", JSON.stringify(coverageRecord.meta.contextOsScorecard));
for (const id of ["beat_exact_tokenizer", "beat_durable_semantic_index", "beat_subagent_runtime_telemetry", "beat_evidence_replay_bundle"]) {
  assert.equal(coverageRecord.meta.contextOsScorecard.checks.find((item) => item.id === id).ok, true, `${id} should pass`);
}

console.log("context-os-beat-e2e: ok");
