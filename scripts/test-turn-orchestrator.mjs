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
  { type: "tool.started", payload: { id: "tool_2", name: "TaskOutput", input: {} } },
  { type: "tool.done", payload: { status: "done", result: { output: "uploaded 42%" } } },
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
const committedUser = allEvents.find((event) => event.type === "user.committed");
if (!committedUser || committedUser.turnId !== result.turnId) {
  throw new Error(`user.committed should be attached to the active turn: ${JSON.stringify(committedUser)}`);
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
const idlessToolDone = allEvents.find((event) => event.type === "tool.done" && event.payload?.id === "tool_2");
if (!idlessToolDone || idlessToolDone.payload?.status !== "done") {
  throw new Error("single running tool should be released by idless tool.done");
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
if (assistantMsg.record.tools.some((tool) => tool.status === "running")) {
  throw new Error(`assistant record must not archive running tools: ${JSON.stringify(assistantMsg.record.tools)}`);
}

sent.length = 0;
const interruptSource = await ctx.turnOrchestrator.sendUserMessage("s1", "long running", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!interruptSource.ok || !runner.isBusy()) {
  throw new Error(`interrupt source turn should start and own the runner: ${JSON.stringify(interruptSource)}`);
}
const staleQueue = await ctx.turnOrchestrator.sendUserMessage("s1", "stale queued", [], {
  skipPreflight: true,
});
if (!staleQueue.queued) {
  throw new Error(`busy send should enter the current-session queue: ${JSON.stringify(staleQueue)}`);
}
ctx.turnOrchestrator.interrupt("s1");
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!allEvents.some((event) => event.type === "turn.interrupted" && event.turnId === interruptSource.turnId)) {
  throw new Error("stop must finalize the active turn as interrupted");
}
const clearQueueEvent = allEvents.findLast?.((event) => event.type === "queue.updated")
  || [...allEvents].reverse().find((event) => event.type === "queue.updated");
if (!clearQueueEvent || clearQueueEvent.payload?.items?.length !== 0) {
  throw new Error(`stop must clear the current-session queue: ${JSON.stringify(clearQueueEvent)}`);
}
if (messages.some((message) => message.content === "stale queued")) {
  throw new Error("stopped queued message must not be committed to transcript");
}

sent.length = 0;
const originalTurn = await ctx.turnOrchestrator.sendUserMessage("s1", "old work", [], {
  spawnEngine: false,
  skipPreflight: true,
});
if (!originalTurn.ok || !runner.isBusy()) {
  throw new Error(`priority source turn should start and own the runner: ${JSON.stringify(originalTurn)}`);
}
const priority = await ctx.turnOrchestrator.interruptAndSend("s1", "urgent follow-up", [], {
  displayFiles: [],
  spawnEngine: false,
  skipPreflight: true,
});
if (!priority.ok || !priority.priority || !priority.queued) {
  throw new Error(`interruptAndSend should report a priority queued item: ${JSON.stringify(priority)}`);
}
await new Promise((resolve) => setTimeout(resolve, 0));
ctx.eventBus.flush();
allEvents = sent.flatMap((entry) => entry.payload?.events || []);
if (!allEvents.some((event) => event.type === "turn.interrupted" && event.turnId === originalTurn.turnId)) {
  throw new Error("priority send must interrupt the active turn before dispatching");
}
const urgentStarted = allEvents.find((event) => event.type === "turn.started" && event.turnId !== originalTurn.turnId);
if (!urgentStarted) {
  throw new Error(`priority send must start a replacement turn: ${allEvents.map((event) => event.type).join(",")}`);
}
const urgentQueueEvent = allEvents.findLast?.((event) => event.type === "queue.updated")
  || [...allEvents].reverse().find((event) => event.type === "queue.updated");
if (!urgentQueueEvent || urgentQueueEvent.payload?.items?.length !== 0) {
  throw new Error(`priority queue should flush only after replacement turn starts: ${JSON.stringify(urgentQueueEvent)}`);
}
runner.finish("urgent answer");
ctx.eventBus.flush();
if (!messages.some((message) => message.role === "user" && message.content === "urgent follow-up")) {
  throw new Error("priority message must be committed as the next user turn");
}
if (!messages.some((message) => message.role === "assistant" && message.content === "urgent answer")) {
  throw new Error("priority replacement turn must commit its assistant response");
}

sent.length = 0;
const queueState = ctx.turnOrchestrator._state("s1");
queueState.queue = [
  { id: "queue_failed", text: "will fail", files: [], displayFiles: [] },
  { id: "queue_next", text: "will start", files: [], displayFiles: [] },
];
let dispatchAttempts = 0;
const originalTryStartQueuedItem = ctx.turnOrchestrator._tryStartQueuedItem.bind(ctx.turnOrchestrator);
ctx.turnOrchestrator._tryStartQueuedItem = async () => {
  dispatchAttempts += 1;
  return dispatchAttempts === 1
    ? { ok: false, error: "SYNTHETIC_START_FAILURE" }
    : { ok: true, turnId: "synthetic_next" };
};
try {
  await ctx.turnOrchestrator._dispatchNext("s1");
  await new Promise((resolve) => setTimeout(resolve, 0));
} finally {
  ctx.turnOrchestrator._tryStartQueuedItem = originalTryStartQueuedItem;
}
if (dispatchAttempts !== 2) {
  throw new Error(`queue dispatcher should continue after a failed queued item, attempts=${dispatchAttempts}`);
}
if (queueState.queue.length !== 0) {
  throw new Error(`failed queued item should not stick at the queue head: ${JSON.stringify(queueState.queue)}`);
}

queueState.queue = [
  { id: "queue_retry", text: "retry later", files: [], displayFiles: [] },
];
ctx.turnOrchestrator._tryStartQueuedItem = async () => ({ ok: false, retry: true, error: "RUNNER_BUSY" });
try {
  await ctx.turnOrchestrator._dispatchNext("s1");
} finally {
  ctx.turnOrchestrator._tryStartQueuedItem = originalTryStartQueuedItem;
}
if (queueState.queue.length !== 1 || queueState.queue[0]?.id !== "queue_retry") {
  throw new Error("transient busy runner must not drop the queued message");
}
queueState.queue = [];

console.log("turn-orchestrator: ok");
