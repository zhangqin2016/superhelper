#!/usr/bin/env node

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-task-run-kernel-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));

const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { TranscriptStore } = require("../src/main/transcript-store.js");
const { TurnArchive } = require("../src/main/turn-archive.js");
const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");
const { applyTaskPlanFromTodos, createTaskRun } = require("../src/main/task-run-state.js");

class FakeRunner extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.busy = false;
    this.sentPayloads = [];
  }
  isBusy() {
    return this.busy;
  }
  isAlive() {
    return true;
  }
  sendUserMessage(payload) {
    if (this.busy) return false;
    this.busy = true;
    this.sentPayloads.push(payload);
    return true;
  }
  finish(text = "done") {
    this.busy = false;
    this.emit("done", { code: 0, output: text });
  }
  interrupt() {
    this.busy = false;
  }
}

function createContext({ eventBus } = {}) {
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
  const session = { id: "s_task", projectId: "p_task", messages };
  const runner = new FakeRunner(session.id);
  const ctx = {
    get mainWindow() {
      return fakeWindow;
    },
    eventBus: eventBus || new RuntimeEventBus(() => fakeWindow),
    sessionManager: {
      findById: (id) => (id === session.id ? session : null),
      getActive: () => session,
      pushMessageTo: (_sessionId, role, content, files, extra) => {
        messages.push({ role, content, files, ...extra });
      },
      popLastAssistantMessage: () => false,
      getLastUserMessage: () => messages.find((m) => m.role === "user") || null,
      admitTurnInput: () => ({ admittedSeq: 1 }),
      markTurnInputPromoted: () => {},
      markTurnInputTerminal: () => {},
    },
    projectManager: {
      find: () => ({ id: "p_task", path: process.cwd() }),
    },
    runnerPool: {
      get: () => runner,
      ensure: () => runner,
      terminateSession: () => {},
      getSessionIds: () => [session.id],
    },
    scheduledTaskManager: {
      markRunStarted: () => {},
      completeRun: () => {},
    },
  };
  ctx.transcriptStore = new TranscriptStore(ctx.sessionManager);
  ctx.turnArchive = new TurnArchive(ctx.sessionManager, { eventBus: ctx.eventBus });
  ctx.turnOrchestrator = new TurnOrchestrator(ctx);
  ctx.turnOrchestrator.bindRunner(runner);
  return { ctx, runner, sent, session };
}

{
  const taskRun = createTaskRun({ sessionId: "s_plan", turnId: "t_plan", objective: "change code" });
  applyTaskPlanFromTodos(taskRun, [
    { content: "Read files", status: "completed" },
    { content: "Patch code", status: "in_progress" },
    { content: "Run tests", status: "pending" },
  ]);
  if (taskRun.plan.length !== 3 || taskRun.plan[1]?.title !== "Patch code") {
    throw new Error(`todo plan should replace the default plan: ${JSON.stringify(taskRun.plan)}`);
  }
  if (taskRun.activeStep !== taskRun.plan[1]?.id) {
    throw new Error(`active step should follow in-progress todo: ${JSON.stringify(taskRun)}`);
  }
  const before = JSON.stringify(taskRun.plan);
  applyTaskPlanFromTodos(taskRun, [{ content: "", status: "weird" }]);
  if (JSON.stringify(taskRun.plan) !== before) {
    throw new Error("malformed todos must not erase the existing TaskRun plan");
  }
}

{
  const { ctx, runner, sent, session } = createContext();
  const started = await ctx.turnOrchestrator.sendUserMessage(session.id, "hello", [], {
    skipPreflight: true,
    skipVision: true,
    skipDocument: true,
    spawnEngine: false,
  });
  if (!started.ok || !started.turnId) {
    throw new Error(`plain chat turn should start: ${JSON.stringify(started)}`);
  }
  runner.finish("hello back");
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  if (events.some((event) => event.type === "task.created")) {
    throw new Error(`plain chat must not create a TaskRun card: ${JSON.stringify(events)}`);
  }
}

{
  const { ctx, runner, sent, session } = createContext();
  const started = await ctx.turnOrchestrator.sendUserMessage(session.id, "hello again", [], {
    skipPreflight: true,
    skipVision: true,
    skipDocument: true,
    spawnEngine: false,
  });
  if (!started.ok || !started.turnId) {
    throw new Error(`plain liveness-only prompt should start: ${JSON.stringify(started)}`);
  }
  ctx.turnOrchestrator.ingest(session.id, [
    { type: "engine.notice", payload: { notice: { code: "waitingForFirstResponse", level: "progress", panel: true } } },
    { type: "engine.notice", payload: { notice: { code: "longWait", level: "progress", panel: true } } },
  ]);
  runner.finish("plain answer");
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  if (events.some((event) => event.type === "task.created")) {
    throw new Error(`liveness-only notices must not create a TaskRun card: ${JSON.stringify(events)}`);
  }
}

{
  const { ctx, runner, sent, session } = createContext();
  const started = await ctx.turnOrchestrator.sendUserMessage(session.id, "Summarize this project", [], {
    skipPreflight: true,
    skipVision: true,
    skipDocument: true,
    spawnEngine: false,
  });
  if (!started.ok || !started.turnId) {
    throw new Error(`turn should start: ${JSON.stringify(started)}`);
  }
  ctx.turnOrchestrator.ingest(session.id, [
    { type: "tool.started", payload: { id: "read_1", name: "Read", input: { file_path: "README.md" } } },
    {
      type: "todo.updated",
      payload: {
        id: "todo_1",
        todos: [
          { content: "Read files", status: "completed" },
          { content: "Summarize findings", status: "in_progress" },
        ],
      },
    },
    { type: "engine.notice", payload: { notice: { code: "longWait", level: "progress", panel: true, replace: true } } },
    { type: "engine.notice", payload: { notice: { code: "toolProgress", level: "progress", detail: "Read README.md is still running" } } },
    { type: "tool.done", payload: { id: "read_1", status: "done", result: "read ok" } },
  ]);
  runner.finish("done");
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  const taskCreated = events.find((event) => event.type === "task.created");
  const taskProgress = events.find((event) => event.type === "task.step.progress" && event.payload?.phase === "tool_running");
  const taskPlan = events.find((event) => event.type === "task.plan.updated" && event.payload?.plan?.some((step) => step.title === "Summarize findings"));
  const taskEvidence = events.find((event) => event.type === "task.evidence.added");
  const taskLiveness = events.find((event) => event.type === "task.liveness.updated" && event.payload?.liveness?.status === "tool_running");
  const noVisibleProgressRisk = events.find((event) => event.type === "task.risk.detected" && event.payload?.risk?.code === "NO_VISIBLE_PROGRESS");
  const taskCompleted = events.find((event) => event.type === "task.completed");
  if (taskCreated?.payload?.taskRun?.turnId !== started.turnId) {
    throw new Error(`task.created should include the turn-backed TaskRun: ${JSON.stringify(taskCreated)}`);
  }
  if (!taskProgress || taskProgress.payload?.tool?.name !== "Read") {
    throw new Error(`tool start should surface task progress: ${JSON.stringify(events)}`);
  }
  if (!taskPlan || taskPlan.payload?.activeStep !== "todo_2") {
    throw new Error(`todo.updated should fuse into TaskRun plan: ${JSON.stringify(events)}`);
  }
  if (!taskEvidence || taskEvidence.payload?.evidence?.kind !== "tool_result") {
    throw new Error(`tool completion should add task evidence: ${JSON.stringify(events)}`);
  }
  if (!taskLiveness || !String(taskLiveness.payload?.liveness?.detail || "").includes("Read README.md")) {
    throw new Error(`tool progress notice should update task liveness: ${JSON.stringify(events)}`);
  }
  if (!noVisibleProgressRisk) {
    throw new Error(`longWait notice should record a no-visible-progress risk without settling the turn: ${JSON.stringify(events)}`);
  }
  if (taskCompleted?.payload?.status !== "completed") {
    throw new Error(`turn completion should complete the TaskRun: ${JSON.stringify(taskCompleted)}`);
  }
  if (taskCompleted?.payload?.taskRun?.resumeState?.replaySafe !== true) {
    throw new Error(`read-only tool run should be marked safe to replay: ${JSON.stringify(taskCompleted?.payload?.taskRun?.resumeState)}`);
  }
}

{
  const { ctx, runner, sent, session } = createContext();
  const started = await ctx.turnOrchestrator.sendUserMessage(session.id, "Run tests", [], {
    skipPreflight: true,
    skipVision: true,
    skipDocument: true,
    spawnEngine: false,
  });
  if (!started.ok) throw new Error(`turn should start: ${JSON.stringify(started)}`);
  ctx.turnOrchestrator.ingest(session.id, [
    { type: "tool.started", payload: { id: "bash_1", name: "Bash", input: { command: "npm test" } } },
    { type: "tool.done", payload: { id: "bash_1", status: "done", result: "ok" } },
  ]);
  runner.finish("done");
  // finalize is async (evidence entailment judge) — let it settle.
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  const taskCompleted = events.find((event) => event.type === "task.completed");
  const resumeState = taskCompleted?.payload?.taskRun?.resumeState || {};
  if (resumeState.replaySafe !== false || resumeState.hasSideEffects !== true) {
    throw new Error(`side-effect tool run must not be marked replay-safe: ${JSON.stringify(resumeState)}`);
  }
}

{
  const { ctx, sent, session } = createContext();
  const started = await ctx.turnOrchestrator.sendUserMessage(session.id, "Long command", [], {
    skipPreflight: true,
    skipVision: true,
    skipDocument: true,
    spawnEngine: false,
  });
  if (!started.ok) throw new Error(`turn should start: ${JSON.stringify(started)}`);
  const realNow = Date.now;
  try {
    Date.now = () => 10_000;
    ctx.turnOrchestrator.ingest(session.id, [
      { type: "tool.started", payload: { id: "bash_1", name: "Bash", input: { command: "npm test" } } },
      { type: "engine.notice", payload: { notice: { code: "toolProgress", level: "progress", detail: "npm test still running" } } },
    ]);
    Date.now = () => 10_200;
    ctx.turnOrchestrator.ingest(session.id, [
      { type: "engine.notice", payload: { notice: { code: "toolProgress", level: "progress", detail: "npm test still running" } } },
    ]);
    Date.now = () => 11_000;
    ctx.turnOrchestrator.ingest(session.id, [
      { type: "engine.notice", payload: { notice: { code: "toolProgress", level: "progress", detail: "npm test still running" } } },
    ]);
  } finally {
    Date.now = realNow;
  }
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  const livenessEvents = events.filter((event) => event.type === "task.liveness.updated");
  if (livenessEvents.length !== 2) {
    throw new Error(`duplicate liveness notices should be throttled: ${JSON.stringify(livenessEvents)}`);
  }
}

{
  const { ctx, sent, session } = createContext();
  const started = await ctx.turnOrchestrator.sendUserMessage(session.id, "Index large inputs", [], {
    skipPreflight: true,
    skipVision: true,
    skipDocument: true,
    spawnEngine: false,
  });
  if (!started.ok) throw new Error(`turn should start: ${JSON.stringify(started)}`);
  ctx.turnOrchestrator.ingest(session.id, [
    { type: "tool.started", payload: { id: "index_1", name: "Bash", input: { command: "node index-large-inputs.js" } } },
    {
      type: "engine.notice",
      payload: {
        notice: {
          code: "workProgress",
          level: "progress",
          detail: "index 2/5",
          progress: { domain: "file-index", current: 2, total: 5, percent: 40 },
        },
      },
    },
  ]);
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  const liveness = events.find((event) => event.type === "task.liveness.updated" && event.payload?.liveness?.status === "work_running");
  if (
    !liveness ||
    liveness.payload?.taskRun?.progress?.label !== "index 2/5" ||
    liveness.payload?.taskRun?.progress?.value !== 40
  ) {
    throw new Error(`workProgress should update generic task liveness/progress: ${JSON.stringify(events)}`);
  }
}

{
  const baseBus = new RuntimeEventBus(() => null);
  const throwingTaskBus = {
    emit(sessionId, eventLike) {
      if (String(eventLike?.type || "").startsWith("task.")) {
        throw new Error("task event persistence failed");
      }
      return baseBus.emit(sessionId, eventLike);
    },
    snapshot(sessionId) {
      return baseBus.snapshot(sessionId);
    },
  };
  const { ctx, runner, session } = createContext({ eventBus: throwingTaskBus });
  const started = await ctx.turnOrchestrator.sendUserMessage(session.id, "Keep base execution smart", [], {
    skipPreflight: true,
    skipVision: true,
    skipDocument: true,
    spawnEngine: false,
  });
  if (!started.ok || runner.sentPayloads.length !== 1) {
    throw new Error(`TaskRun failures must fail open to baseline execution: ${JSON.stringify(started)}`);
  }
}

console.log("task-run-kernel: ok");
