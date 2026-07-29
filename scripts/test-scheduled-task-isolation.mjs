#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduler-isolation-"));
const dbPath = path.join(root, "scheduled-tasks.db");
const legacyPath = path.join(root, "scheduled-tasks.json");
let principal = "user:alice";
const sessions = new Map([
  ["origin-a", { id: "origin-a", projectId: "project-a" }],
  ["origin-b", { id: "origin-b", projectId: "project-a" }],
  ["origin-c", { id: "origin-c", projectId: "project-b" }],
  ["wrong-project", { id: "wrong-project", projectId: "project-b" }],
]);
const sent = [];
const published = [];
const busySessions = new Set();
const {
  ScheduledTaskManager,
} = require("../src/main/scheduled-tasks.js");
const { ScheduledTaskStore } = require("../src/main/store/scheduled-task-store.js");

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

function context() {
  return {
    sessionManager: {
      findById: (id) => sessions.get(id) || null,
      pushMessageTo: (sessionId, role, content, _files, extra) => {
        published.push({ sessionId, role, content, extra });
      },
    },
    projectManager: {
      find: (id) => (id === "project-a" || id === "project-b" ? { id } : null),
    },
    turnOrchestrator: {
      sendUserMessage: async (sessionId, _text, _files, opts) => {
        sent.push({ sessionId, opts });
        if (busySessions.has(sessionId)) {
          return { ok: true, queued: true, itemId: `queue-${sent.length}` };
        }
        return { ok: true, turnId: `turn-${sent.length}` };
      },
    },
  };
}

function createManager(options = {}) {
  const manager = new ScheduledTaskManager({
    dbPath,
    legacyPath,
    resolvePrincipal: () => principal,
    maxConcurrentRuns: 2,
    ...options,
  });
  manager.load();
  manager.start(context());
  manager.stop();
  return manager;
}

try {
  assert.equal(
    new ScheduledTaskManager({ resolvePrincipal: () => principal }).maxConcurrentRuns,
    3,
    "production scheduler must permit bounded concurrent unattended runs",
  );
  const manager = createManager();
  const mismatch = manager.create({
    title: "bad scope",
    prompt: "每天检查一次",
    scheduleText: "每天早上9点",
    sessionId: "wrong-project",
    projectId: "project-a",
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error, "SCOPE_MISMATCH");

  const first = manager.create({
    title: "task a",
    prompt: "检查任务 A",
    scheduleText: "每天早上9点",
    sessionId: "origin-a",
    projectId: "project-a",
  });
  const second = manager.create({
    title: "task b",
    prompt: "检查任务 B",
    scheduleText: "每天早上9点",
    sessionId: "origin-b",
    projectId: "project-a",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.task.ownerPrincipal, "user:alice");
  assert.equal(first.task.executionSessionId, "origin-a");
  assert.equal(second.task.executionSessionId, "origin-b");

  principal = "user:bob";
  assert.equal(manager.list({ projectId: "project-a" }).tasks.length, 0);
  assert.equal(manager.runNow(first.task.id).error, "NOT_FOUND");
  principal = "user:alice";

  first.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  second.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  busySessions.add("origin-a");
  manager.save();
  await manager.tick();
  await flushAsync();
  assert.equal(sent.length, 2, "different conversations admit scheduled messages independently");
  assert.equal(sent[0].sessionId, "origin-a");
  assert.equal(sent[1].sessionId, "origin-b");
  assert.equal(sent.every((item) => item.opts.permissionMode === undefined), true,
    "scheduled messages inherit the bound conversation permission mode");
  assert.equal(sent.every((item) => item.opts.nonInteractive === true), true,
    "unattended messages must never wait for a permission dialog");
  assert(
    Date.parse(first.task.nextRunAt) > Date.now(),
    "run-once startup recovery must advance the next occurrence past now instead of replaying every missed interval",
  );

  const crossProject = manager.create({
    title: "task c",
    prompt: "检查任务 C",
    scheduleText: "每天早上9点",
    sessionId: "origin-c",
    projectId: "project-b",
  });
  crossProject.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  manager.save();
  await manager.tick();
  await flushAsync();
  assert.equal(sent.length, 3,
    "a queued message in a busy conversation must not consume execution capacity for an idle conversation");

  const activeRun = manager.runs.find((run) => run.taskId === first.task.id);
  const secondRun = manager.runs.find((run) => run.taskId === second.task.id);
  assert.equal(activeRun.status, "queued",
    "a scheduled message waits in its bound conversation while that conversation is busy");
  assert.equal(secondRun.status, "running",
    "another conversation starts immediately while the first conversation is busy");
  const crossProjectRun = manager.runs.find((run) => run.taskId === crossProject.task.id);
  assert.equal(crossProjectRun.status, "running");
  manager.setEnabled(first.task.id, false, { projectId: "project-a" });
  manager.setEnabled(first.task.id, true, { projectId: "project-a" });
  assert.equal(manager.runNow(first.task.id).error, "ALREADY_RUNNING");
  assert.equal(manager.runs.filter((run) => run.taskId === first.task.id).length, 1);

  manager.completeRunById(secondRun.id, "turn.completed", { assistant: "B 完成" });
  await flushAsync();
  assert.equal(sent[2].sessionId, crossProject.task.executionSessionId);

  busySessions.delete("origin-a");
  manager.markRunStarted(activeRun.id, "turn-origin-a");
  manager.completeRunById(activeRun.id, "turn.completed", { assistant: "A 完成" });
  await flushAsync();
  assert.equal(activeRun.status, "succeeded",
    "the queued scheduled message completes after the conversation becomes idle");
  assert.equal(published.length, 0,
    "completion already lives in the bound conversation and must not be duplicated");
  manager.completeRunById(crossProjectRun.id, "turn.completed", { assistant: "C 完成" });

  // A busy scheduler stays globally bounded even when many tasks become due.
  for (let i = 0; i < 5; i += 1) {
    const created = manager.create({
      title: `bulk ${i}`,
      prompt: `检查 ${i}`,
      scheduleText: "每天早上9点",
      sessionId: "origin-a",
      projectId: "project-a",
    });
    created.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  }
  manager.save();
  const before = sent.length;
  await manager.tick();
  await flushAsync();
  assert.equal(sent.length - before, 2, "same-project backlog may fill all available conversation slots");
  assert.equal(
    manager.runs.filter((run) => run.status === "running").length <= 2,
    true,
    "actual concurrent execution remains bounded while conversation queues stay independent",
  );

  manager.close();

  const restartRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduler-restart-"));
  const restartDbPath = path.join(restartRoot, "scheduled-tasks.db");
  const restartLegacyPath = path.join(restartRoot, "scheduled-tasks.json");
  const restartSent = [];
  const restartContext = {
    ...context(),
    turnOrchestrator: {
      sendUserMessage: async (sessionId, _text, _files, opts) => {
        restartSent.push({ sessionId, opts });
        return sessionId === "origin-a"
          ? { ok: true, queued: true, itemId: `restart-queue-${restartSent.length}` }
          : { ok: true, turnId: `restart-turn-${restartSent.length}` };
      },
    },
  };
  const beforeRestart = new ScheduledTaskManager({
    dbPath: restartDbPath,
    legacyPath: restartLegacyPath,
    resolvePrincipal: () => principal,
    maxConcurrentRuns: 2,
  });
  beforeRestart.load();
  beforeRestart.start(restartContext);
  beforeRestart.stop();
  const restartQueuedTask = beforeRestart.create({
    title: "restart queued",
    prompt: "排队后重启",
    scheduleText: "每天早上9点",
    sessionId: "origin-a",
    projectId: "project-a",
  });
  const restartRunningTask = beforeRestart.create({
    title: "restart running",
    prompt: "启动后重启",
    scheduleText: "每天早上9点",
    sessionId: "origin-b",
    projectId: "project-a",
  });
  restartQueuedTask.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  restartRunningTask.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  beforeRestart.save();
  await beforeRestart.tick();
  await flushAsync();
  const queuedBeforeRestart = beforeRestart.runs.find((run) => run.taskId === restartQueuedTask.task.id);
  const runningBeforeRestart = beforeRestart.runs.find((run) => run.taskId === restartRunningTask.task.id);
  assert.equal(queuedBeforeRestart.status, "queued");
  assert.equal(runningBeforeRestart.status, "running");
  beforeRestart.close();

  const recoveryStore = new ScheduledTaskStore(restartDbPath);
  const atomicallyRecovered = recoveryStore.recoverExpired(
    new Date().toISOString(),
    "atomic-recovery-owner",
    new Date(Date.now() + 60_000).toISOString(),
  );
  const recoveredSnapshot = recoveryStore.load().runs;
  assert.equal(
    recoveredSnapshot.find((run) => run.id === queuedBeforeRestart.id)?.status,
    "queued",
    "SQLite recovery must reclaim a never-started queue without an interrupted intermediate commit",
  );
  assert.equal(
    recoveredSnapshot.find((run) => run.id === runningBeforeRestart.id)?.status,
    "interrupted",
    "SQLite recovery must terminalize a possibly side-effecting run in the same transaction",
  );
  assert.equal(atomicallyRecovered.find((run) => run.id === queuedBeforeRestart.id)?.recoveredFromStatus, "queued");
  recoveryStore.close();

  restartSent.length = 0;
  const recovered = new ScheduledTaskManager({
    dbPath: restartDbPath,
    legacyPath: restartLegacyPath,
    resolvePrincipal: () => principal,
    maxConcurrentRuns: 2,
  });
  recovered.load();
  recovered.start(restartContext);
  recovered.stop();
  await flushAsync();
  assert.equal(
    restartSent.filter((item) => item.opts.scheduledTaskRunId === queuedBeforeRestart.id).length,
    1,
    "a never-started queued occurrence must be re-admitted exactly once after restart",
  );
  assert.equal(
    recovered.runs.find((run) => run.id === queuedBeforeRestart.id)?.status,
    "queued",
    "restart recovery must preserve the exact queued run identity",
  );
  assert.equal(
    restartSent.some((item) => item.opts.scheduledTaskRunId === runningBeforeRestart.id),
    false,
    "a run that started before interruption must never be replayed because side effects may have occurred",
  );
  assert.equal(
    recovered.runs.find((run) => run.id === runningBeforeRestart.id)?.status,
    "interrupted",
  );
  recovered.close();
  fs.rmSync(restartRoot, { recursive: true, force: true });

  const accountCancelled = [];
  const accountInterrupted = [];
  const accountManager = new ScheduledTaskManager({
    resolvePrincipal: () => "user:bob",
    maxConcurrentRuns: 2,
  });
  accountManager.tasks = [
    { id: "account-queued-task", enabled: true },
    { id: "account-running-task", enabled: true },
  ];
  accountManager.runs = [
    {
      id: "account-queued-run", taskId: "account-queued-task",
      ownerPrincipal: "user:alice", sessionId: "origin-a", status: "queued",
    },
    {
      id: "account-running-run", taskId: "account-running-task",
      ownerPrincipal: "user:alice", sessionId: "origin-b", status: "running",
    },
  ];
  accountManager.ctx = {
    turnOrchestrator: {
      cancelQueuedScheduledRun: (sessionId, runId) => {
        accountCancelled.push({ sessionId, runId });
        accountManager.completeQueuedRun(runId, "turn.interrupted", { errorCode: "ACCOUNT_CHANGED" });
        return { ok: true };
      },
      interrupt: (sessionId) => accountInterrupted.push(sessionId),
    },
  };
  accountManager.handlePrincipalChange();
  assert.deepEqual(accountCancelled, [{ sessionId: "origin-a", runId: "account-queued-run" }],
    "account changes must remove only the foreign scheduled queue item");
  assert.deepEqual(accountInterrupted, ["origin-b"],
    "only a foreign scheduled turn that is actually running may interrupt its conversation");

  const metadataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduler-metadata-"));
  const metadataOptions = {
    dbPath: path.join(metadataRoot, "scheduled-tasks.db"),
    legacyPath: path.join(metadataRoot, "scheduled-tasks.json"),
    resolvePrincipal: () => "user:alice",
  };
  const legacyMetadataManager = new ScheduledTaskManager(metadataOptions);
  legacyMetadataManager.load();
  legacyMetadataManager.start(context());
  legacyMetadataManager.stop();
  const legacyMetadataTask = legacyMetadataManager.create({
    title: "legacy permission",
    prompt: "检查旧任务",
    scheduleText: "每天早上9点",
    sessionId: "origin-a",
    projectId: "project-a",
  }).task;
  legacyMetadataTask.permissionMode = "read_only";
  legacyMetadataManager.save();
  legacyMetadataManager.close();
  const normalizedMetadataManager = new ScheduledTaskManager(metadataOptions);
  normalizedMetadataManager.load();
  normalizedMetadataManager.close();
  const metadataStore = new ScheduledTaskStore(metadataOptions.dbPath);
  assert.equal(metadataStore.load().tasks[0]?.permissionMode, "inherit",
    "loading a legacy database must persist the normalized permission contract");
  metadataStore.close();
  fs.rmSync(metadataRoot, { recursive: true, force: true });

  const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduler-corrupt-"));
  const corruptLegacy = path.join(corruptRoot, "scheduled-tasks.json");
  fs.writeFileSync(corruptLegacy, "{ definitely broken", "utf8");
  const corruptManager = new ScheduledTaskManager({
    dbPath: path.join(corruptRoot, "scheduled-tasks.db"),
    legacyPath: corruptLegacy,
    resolvePrincipal: () => "device:test",
  });
  const loadResult = corruptManager.load();
  assert.equal(loadResult.ok, false);
  assert.equal(loadResult.error, "LEGACY_CORRUPT");
  assert.equal(fs.readFileSync(corruptLegacy, "utf8"), "{ definitely broken");
  corruptManager.close();
  fs.rmSync(corruptRoot, { recursive: true, force: true });

  console.log("scheduled-task-isolation: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
