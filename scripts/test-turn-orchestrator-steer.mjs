#!/usr/bin/env node
// Closed-loop guard for the steer ("插话") send-while-busy path (CAPABILITY-GATE).
// Verifies: (1) a successful steer injects into the CURRENT turn (no new turnId) and
// emits user.committed{steer:true} + turn.steered; (2) FAILURE MODE — when the engine
// won't accept the steer it degrades to the queue (queued + steerFellBack), identical
// to today's behavior; (3) with the flag off, steer is never attempted and queues.

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-steer-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");

class FakeRunner extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.busy = false;
    this.steerCalls = [];
    this.steerResult = true;
  }
  isBusy() { return this.busy; }
  isAlive() { return true; }
  async steer(payload) {
    this.steerCalls.push(payload);
    return this.steerResult;
  }
  sendUserMessage() { return true; }
  interrupt() { this.busy = false; }
}

const sent = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send(channel, payload) { sent.push({ channel, payload }); } },
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
    pushMessageTo: (_sessionId, role, content, files, extra) => {
      messages.push({ role, content, files, ...extra });
    },
    getLastUserMessage: () => messages.find((m) => m.role === "user") || null,
  },
  projectManager: { find: () => ({ id: "p1", path: process.cwd() }) },
  runnerPool: { get: () => runner, ensure: () => runner, terminateSession: () => {} },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager, { eventBus: ctx.eventBus });
ctx.turnOrchestrator = new TurnOrchestrator(ctx);

const orch = ctx.turnOrchestrator;

function eventsFor(type) {
  ctx.eventBus.flush();
  return sent.flatMap((e) => e.payload?.events || []).filter((e) => e.type === type);
}
function putBusy() {
  const st = orch._state("s1");
  st.phase = "running";
  st.turnId = "turn_live";
  st.queue = [];
  runner.busy = true;
  messages.length = 0;
  sent.length = 0;
}

// --- 1. enabled (default) + engine accepts -> steered into the current turn ----
delete process.env.LILY_ENABLE_STEER; // on by default
putBusy();
runner.steerResult = true;
let res = await orch.sendUserMessage("s1", "也顺便查一下昨天的数据", [], { mode: "steer" });
if (!res?.ok || !res.steered) throw new Error(`steer should succeed: ${JSON.stringify(res)}`);
if (res.turnId !== "turn_live") throw new Error(`steer must reuse the live turnId, got ${res.turnId}`);
if (runner.steerCalls.length !== 1) throw new Error("engine steer must be invoked exactly once");
if (orch._state("s1").queue.length !== 0) throw new Error("a successful steer must NOT queue");
const committed = eventsFor("user.committed");
if (!committed.some((e) => e.payload?.steer === true && e.turnId === "turn_live")) {
  throw new Error(`steer must commit a user message into the live turn: ${JSON.stringify(committed)}`);
}
if (!eventsFor("turn.steered").some((e) => e.turnId === "turn_live")) {
  throw new Error("steer must emit turn.steered for the live turn");
}
if (!messages.some((m) => m.role === "user" && m.content === "也顺便查一下昨天的数据" && m.turnId === "turn_live")) {
  throw new Error("steer must persist the user message on the live turn");
}
console.log("steer: success path ok");

// --- 2. FAILURE MODE: engine rejects -> degrade to queue (baseline) -----------
putBusy();
runner.steerResult = false;
res = await orch.sendUserMessage("s1", "再补一句", [], { mode: "steer" });
if (!res?.queued || !res.steerFellBack) {
  throw new Error(`engine-rejected steer must fall back to queue: ${JSON.stringify(res)}`);
}
if (orch._state("s1").queue.length !== 1) throw new Error("fallback must enqueue exactly one item");
if (eventsFor("turn.steered").length !== 0) throw new Error("a failed steer must NOT emit turn.steered");
console.log("steer: engine-reject fallback ok");

// --- 3. kill-switch (LILY_ENABLE_STEER=0) -> never attempt steer, queue instead
process.env.LILY_ENABLE_STEER = "0";
putBusy();
runner.steerResult = true;
runner.steerCalls.length = 0;
res = await orch.sendUserMessage("s1", "开关关闭时", [], { mode: "steer" });
if (!res?.queued) throw new Error(`kill-switch steer must queue: ${JSON.stringify(res)}`);
if (runner.steerCalls.length !== 0) throw new Error("kill-switch must NOT call the engine steer");
delete process.env.LILY_ENABLE_STEER;
console.log("steer: kill-switch fallback ok");

console.log("test-turn-orchestrator-steer: ALL_OK");
