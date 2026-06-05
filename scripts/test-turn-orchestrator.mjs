#!/usr/bin/env node

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");

class FakeRunner extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.busy = false;
  }
  isBusy() {
    return this.busy;
  }
  isAlive() {
    return true;
  }
  sendUserMessage() {
    if (this.busy) return false;
    this.busy = true;
    this.emit("status", "thinking");
    return true;
  }
  finish(text = "done") {
    ctx.turnOrchestrator.ingest(this.sessionId, [{ type: "assistant.delta", payload: { text } }]);
    this.busy = false;
    this.emit("done", { code: 0, output: text });
  }
  respondPermission() {
    return true;
  }
  respondUserQuestion() {
    return true;
  }
  respondHook() {
    return true;
  }
  interrupt() {
    this.busy = false;
  }
}

const sent = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  },
};

const messages = [];
const session = { id: "s1", projectId: "p1", messages };
const runner = new FakeRunner("s1");
const ctx = {
  get mainWindow() {
    return fakeWindow;
  },
  eventBus: new RuntimeEventBus(() => fakeWindow),
  sessionManager: {
    findById: (id) => (id === "s1" ? session : null),
    getActive: () => session,
    pushMessageTo: (_sessionId, role, content, files, extra) => {
      messages.push({ role, content, files, ...extra });
    },
    popLastAssistantMessage: () => false,
    getLastUserMessage: () => messages.find((m) => m.role === "user") || null,
    setAgentResumeId: () => {},
    clearAgentResumeId: () => {},
  },
  projectManager: {
    find: () => ({ id: "p1", path: process.cwd() }),
  },
  runnerPool: {
    get: () => runner,
    ensure: () => runner,
    terminateSession: () => {},
    getSessionIds: () => ["s1"],
  },
};
ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
ctx.turnArchive = new TurnArchive(ctx.sessionManager);
ctx.turnOrchestrator = new TurnOrchestrator(ctx);
ctx.turnOrchestrator.bindRunner(runner);

ctx.turnOrchestrator.ingest("s1", [{
  type: "tool.started",
  payload: { id: "orphan_tool", name: "Bash", input: {} },
}]);
ctx.eventBus.flush();
let allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (allEvents.some((event) => event.type === "engine.warning")) {
  throw new Error("orphan tool event should be dropped silently without user-visible warning");
}
sent.length = 0;

const result = await ctx.turnOrchestrator.sendUserMessage("s1", "hello", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!result.ok) throw new Error(`send failed: ${JSON.stringify(result)}`);
ctx.turnOrchestrator.ingest("s1", [
  { type: "tool.started", payload: { id: "tool_1", name: "Bash", input: {} } },
  { type: "process.event", payload: {
    rawType: "stream_event",
    rawSubtype: "content_block_start",
    summary: "tool Bash",
    actions: [{ kind: "stream_tool_start", id: "tool_1", name: "Bash" }],
  } },
  { type: "tool.input.done", payload: { id: "tool_1", input: { command: "echo ok" } } },
  { type: "tool.done", payload: { id: "tool_1", status: "done", result: { output: "ok" } } },
]);
const queued = await ctx.turnOrchestrator.sendUserMessage("s1", "queued", [], {
  skipPreflight: true,
});
if (!queued.queued || !queued.itemId) throw new Error("busy send should queue with id");
const cancel = ctx.turnOrchestrator.cancelQueuedMessage("s1", queued.itemId);
if (!cancel.ok || cancel.queueLength !== 0) throw new Error("queue cancel by id failed");
runner.finish("answer");
ctx.eventBus.flush();

allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!allEvents.some((event) => event.type === "turn.started")) {
  throw new Error("missing turn.started");
}
if (!allEvents.some((event) => event.type === "assistant.delta")) {
  throw new Error("missing assistant.delta");
}
if (!allEvents.some((event) => event.type === "assistant.final")) {
  throw new Error("missing assistant.final");
}
const processEvent = allEvents.find((event) => event.type === "process.event");
if (!processEvent?.turnId || processEvent.payload?.rawSubtype !== "content_block_start") {
  throw new Error("process.event should be attached to the active turn");
}
const toolStarted = allEvents.find((event) => event.type === "tool.started");
if (!toolStarted?.turnId || toolStarted.turnId !== result.turnId) {
  throw new Error("tool.started should be attached to the active turn");
}
const terminals = allEvents.filter((event) => event.type.startsWith("turn.") && ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled"].includes(event.type));
if (terminals.length !== 1 || terminals[0].type !== "turn.completed") {
  throw new Error(`expected one completed terminal event, got ${terminals.map((e) => e.type).join(",")}`);
}
if (messages.filter((m) => m.role === "assistant").length !== 1) {
  throw new Error("assistant transcript should be committed once");
}
const assistantMsg = messages.find((m) => m.role === "assistant");
if (!assistantMsg?.record?.tools?.length) {
  throw new Error("assistant record should persist tool timeline");
}

console.log("turn-orchestrator: ok");
