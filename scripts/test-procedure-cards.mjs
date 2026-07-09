#!/usr/bin/env node
// Procedure cards (程序卡) closed loop: a completed multi-tool turn is
// distilled deterministically into a per-project card; a later similar request
// gets the card injected as advisory platform context; lite-graded models
// never author; kill switch disables everything; store is size-capped.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-procedure-cards-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
// Keep the harness's synthetic failures out of the rescue machinery.
process.env.LILY_TOOL_CALL_RESCUE = "0";
process.env.LILY_EMPTY_COMPLETION_RETRY = "0";
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

const {
  recordProcedureCardFromTurn,
  matchProcedureCard,
  buildProcedureCardContext,
  readCards,
  MAX_CARDS_PER_PROJECT,
} = require("../src/main/procedure-cards.js");

const doneTool = (name, input = {}) => ({ name, status: "done", input });

// --- module closed loop --------------------------------------------------------

{
  const card = recordProcedureCardFromTurn({
    projectId: "p1",
    userText: "把季度销售数据整理成图表报告",
    tools: [
      doneTool("read", { path: "/data/sales-q2.csv" }),
      doneTool("bash", { command: "python analyze.py" }),
      doneTool("write", { path: "/data/report.md" }),
    ],
  });
  assert(card, "a successful 3-tool turn produces a card");
  assert.equal(card.steps.length, 3, "each successful tool becomes a step");
  assert.match(card.steps[0], /read: \/data\/sales-q2\.csv/, "steps carry the tool and its key argument");

  const match = matchProcedureCard({ projectId: "p1", text: "帮我把这季度的销售数据做成图表报告" });
  assert(match, "a similar request matches the stored card");
  assert.equal(match.card.id, card.id);

  assert.equal(matchProcedureCard({ projectId: "p1", text: "deploy the web service to staging" }), null,
    "an unrelated request matches nothing");
  assert.equal(matchProcedureCard({ projectId: "p2", text: "把季度销售数据整理成图表报告" }), null,
    "cards are project-scoped");

  const context = buildProcedureCardContext({ projectId: "p1", text: "季度销售数据图表报告再来一份" });
  assert.match(context, /previously successful procedure/, "matched card renders as advisory context");
  assert.match(context, /1\. read/, "the context lists the proven steps in order");
  assert(context.length <= 800, "the advisory block stays bounded");
  assert.equal(readCards("p1")[0].uses, 1, "usage is recorded so useful cards survive the LRU cap");
}

// --- authoring gates ------------------------------------------------------------

assert.equal(
  recordProcedureCardFromTurn({
    projectId: "p1",
    userText: "用弱模型完成的任务",
    capabilityGrade: "lite",
    tools: [doneTool("read"), doneTool("bash"), doneTool("write")],
  }),
  null,
  "lite-graded models never author cards",
);
assert.equal(
  recordProcedureCardFromTurn({
    projectId: "p1",
    userText: "只用了两个工具的任务",
    tools: [doneTool("read"), doneTool("write")],
  }),
  null,
  "fewer than 3 successful tools is not a procedure worth teaching",
);
assert.equal(
  recordProcedureCardFromTurn({
    projectId: "p1",
    userText: "失败工具不算数的任务样例",
    tools: [doneTool("read"), { name: "bash", status: "failed", input: {} }, { name: "write", status: "running", input: {} }],
  }),
  null,
  "failed/running tools do not count toward a proven path",
);
{
  process.env.LILY_PROCEDURE_CARDS = "0";
  const killed = recordProcedureCardFromTurn({
    projectId: "p1",
    userText: "开关关闭时的任务样例",
    tools: [doneTool("read"), doneTool("bash"), doneTool("write")],
  });
  assert.equal(killed, null, "kill switch disables authoring");
  assert.equal(buildProcedureCardContext({ projectId: "p1", text: "季度销售数据图表报告" }), "",
    "kill switch disables injection too");
  delete process.env.LILY_PROCEDURE_CARDS;
}

// --- store cap -------------------------------------------------------------------

{
  for (let i = 0; i < MAX_CARDS_PER_PROJECT + 10; i += 1) {
    recordProcedureCardFromTurn({
      projectId: "p3",
      userText: `批量任务样例编号 ${i} 的独立描述文本内容`,
      tools: [doneTool("read"), doneTool("bash"), doneTool("write")],
    });
  }
  assert(readCards("p3").length <= MAX_CARDS_PER_PROJECT, "the per-project store is size-capped");
}

// --- orchestrator integration: record on completion, inject on next turn --------

const selfHealPath = require.resolve("../src/main/model-self-heal.js");
require.cache[selfHealPath] = {
  id: selfHealPath, filename: selfHealPath, loaded: true,
  exports: {
    attemptModelSelfHeal: async () => ({ attempted: false }),
    isHealableFailureCode: () => false,
    resetSelfHealStateForTests: () => {},
  },
};
const serviceClientPath = require.resolve("../src/main/service-client.js");
require.cache[serviceClientPath] = {
  id: serviceClientPath, filename: serviceClientPath, loaded: true,
  exports: {
    reportUsage: async () => ({ ok: true }),
    reportRuntimeDiagnostic: async () => ({ ok: true, json: { id: "diag" } }),
  },
};

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");

class FakeRunner extends EventEmitter {
  constructor() {
    super();
    this.sessionId = "s1";
    this.busy = false;
    this.spawnOptions = {};
    this.sentPayloads = [];
  }
  isBusy() { return this.busy; }
  isAlive() { return true; }
  sendUserMessage(payload) {
    this.busy = true;
    this.sentPayloads.push(payload);
    this.emit("status", "thinking");
    return true;
  }
  interrupt() { this.busy = false; }
  diagnostics() { return {}; }
}

const sent = [];
const fakeWindow = { isDestroyed: () => false, webContents: { send: (c, p) => sent.push(p) } };
const messages = [];
const session = { id: "s1", projectId: "proj_cards", messages };
const runner = new FakeRunner();
const ctx = {
  get mainWindow() { return fakeWindow; },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: {
    findById: (id) => (id === "s1" ? session : null),
    getActive: () => session,
    pushMessageTo: (_s, role, content) => messages.push({ role, content }),
    popLastAssistantMessage: () => false,
    getLastUserMessage: () => [...messages].reverse().find((m) => m.role === "user") || null,
    findAgentResumeOwner: () => null,
    setAgentResumeId: () => {},
    claimAgentResumeId: () => ({ ok: true, evictedSessionIds: [] }),
    clearAgentResumeId: () => true,
  },
  projectManager: { find: () => ({ id: "proj_cards", path: process.cwd() }) },
  runnerPool: { get: () => runner, ensure: () => runner, terminateSession: () => {}, getSessionIds: () => ["s1"] },
  scheduledTaskManager: { completeQueuedRun: () => true },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager, { eventBus: ctx.eventBus });
ctx.turnOrchestrator = new TurnOrchestrator(ctx);
ctx.turnOrchestrator.bindRunner(runner);
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// Turn 1: a successful 3-tool task → card recorded.
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "把用户反馈日志汇总成一份周报文档", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  ctx.turnOrchestrator.ingest("s1", [
    { type: "tool.started", payload: { id: "t1", name: "read", input: { path: "/logs/feedback.log" } } },
    { type: "tool.done", payload: { id: "t1", status: "done" } },
    { type: "tool.started", payload: { id: "t2", name: "bash", input: { command: "python summarize.py" } } },
    { type: "tool.done", payload: { id: "t2", status: "done" } },
    { type: "tool.started", payload: { id: "t3", name: "write", input: { path: "/reports/weekly.md" } } },
    { type: "tool.done", payload: { id: "t3", status: "done" } },
    { type: "assistant.delta", payload: { text: "周报已生成。" } },
  ]);
  runner.busy = false;
  runner.emit("done", { code: 0, output: "周报已生成。" });
  await settle();
  const stored = readCards("proj_cards");
  assert.equal(stored.length, 1, "a completed multi-tool turn records exactly one card");
  assert.match(stored[0].title, /用户反馈日志汇总/, "the card carries the user intent as its title");
}

// Turn 2: a similar request → the card rides platform context to the engine.
{
  const send = await ctx.turnOrchestrator.sendUserMessage("s1", "再帮我把这周的用户反馈日志汇总成周报文档", [], {
    spawnEngine: false,
    skipPreflight: true,
  });
  assert.equal(send.ok, true);
  const enginePayload = JSON.stringify(runner.sentPayloads.at(-1));
  assert.match(enginePayload, /previously successful procedure/,
    "the matched card is injected into the engine text as advisory context");
  assert.match(enginePayload, /summarize\.py/, "the injected card carries the proven steps");
}

console.log("procedure-cards: ok");
