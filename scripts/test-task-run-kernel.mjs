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
    { type: "engine.notice", payload: { notice: { code: "longWait", level: "progress", panel: true, replace: true } } },
    { type: "engine.notice", payload: { notice: { code: "toolProgress", level: "progress", detail: "Read README.md is still running" } } },
    { type: "tool.done", payload: { id: "read_1", status: "done", result: "read ok" } },
  ]);
  runner.finish("done");
  ctx.eventBus.flush();
  const events = sent.flatMap((entry) => entry.payload?.events || []);
  const taskCreated = events.find((event) => event.type === "task.created");
  const taskProgress = events.find((event) => event.type === "task.step.progress" && event.payload?.phase === "tool_running");
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
