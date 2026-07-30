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
const {
  dispatchScheduledRun,
  reconcileScheduledRunWithTurn,
  reconcileScheduledRunsWithDurableTurns,
} = require("../src/main/scheduled-task-dispatch.js");

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
  const restartBaseContext = context();
  const restartContext = {
    ...restartBaseContext,
    sessionManager: {
      ...restartBaseContext.sessionManager,
      findTurnInputByScheduledRun: (sessionId) => (
        sessionId === "origin-b"
          ? {
              turnId: "durable-restart-running-turn",
              status: "completed",
              dispatchAttemptId: "durable-restart-attempt",
              dispatchStartedAt: 4567,
              acceptedAt: 5000,
              terminalAt: 5678,
              terminalType: "turn.completed",
              errorCode: null,
            }
          : null
      ),
    },
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
    "dispatch_unknown",
    "SQLite recovery must pause a possibly side-effecting run without claiming interruption",
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
    "succeeded",
  );
  assert.equal(
    recovered.runs.find((run) => run.id === runningBeforeRestart.id)?.dispatchAttemptId,
    "durable-restart-attempt",
  );
  assert.equal(
    recovered.runs.find((run) => run.id === runningBeforeRestart.id)?.finishedAt,
    new Date(5678).toISOString(),
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
    { id: "account-stale-running-task", enabled: true },
    { id: "account-promoted-task", enabled: true },
    { id: "account-unknown-task", enabled: true },
  ];
  accountManager.runs = [
    {
      id: "account-queued-run", taskId: "account-queued-task",
      ownerPrincipal: "user:alice", sessionId: "origin-a", status: "queued",
    },
    {
      id: "account-running-run", taskId: "account-running-task",
      ownerPrincipal: "user:alice", sessionId: "origin-b", status: "running",
      turnId: "account-running-turn",
      dispatchAttemptId: "account-running-attempt",
    },
    {
      id: "account-stale-running-run", taskId: "account-stale-running-task",
      ownerPrincipal: "user:alice", sessionId: "origin-b", status: "running",
      turnId: "account-stale-turn",
      dispatchAttemptId: "account-stale-attempt",
    },
    {
      id: "account-promoted-run", taskId: "account-promoted-task",
      ownerPrincipal: "user:alice", sessionId: "origin-b", status: "promoted",
      turnId: "account-old-promoted-turn",
      dispatchAttemptId: "account-old-promoted-attempt",
    },
    {
      id: "account-unknown-run", taskId: "account-unknown-task",
      ownerPrincipal: "user:alice", sessionId: "origin-b",
      status: "dispatch_unknown",
      turnId: "account-old-unknown-turn",
      dispatchAttemptId: "account-old-unknown-attempt",
    },
  ];
  accountManager.ctx = {
    turnOrchestrator: {
      cancelQueuedScheduledRun: (sessionId, runId) => {
        accountCancelled.push({ sessionId, runId });
        accountManager.completeQueuedRun(runId, "turn.interrupted", { errorCode: "ACCOUNT_CHANGED" });
        return { ok: true };
      },
      interruptScheduledRun: (run) => {
        if (
          run.turnId !== "account-running-turn"
          || run.dispatchAttemptId !== "account-running-attempt"
          || run.ownerPrincipal !== "user:alice"
        ) return { ok: false, error: "TURN_CLAIM_MISMATCH" };
        accountInterrupted.push({
          sessionId: run.sessionId,
          turnId: run.turnId,
          dispatchAttemptId: run.dispatchAttemptId,
          ownerPrincipal: run.ownerPrincipal,
        });
        return { ok: true };
      },
    },
  };
  accountManager.handlePrincipalChange();
  assert.deepEqual(
    accountCancelled,
    [],
    "account changes pause foreign queued work without cancelling durable admission",
  );
  assert.equal(
    accountManager.runs.find((run) => run.id === "account-queued-run").status,
    "queued",
    "foreign queued scheduled work remains recoverable when its owner returns",
  );
  assert.deepEqual(accountInterrupted, [{
    sessionId: "origin-b",
    turnId: "account-running-turn",
    dispatchAttemptId: "account-running-attempt",
    ownerPrincipal: "user:alice",
  }],
  "principal changes interrupt only the exact active scheduled turn claim");
  assert.equal(
    accountManager.runs.find((run) => run.id === "account-stale-running-run").status,
    "running",
    "a stale run sharing the session must not be falsely interrupted",
  );
  assert.equal(
    accountManager.runs.find((run) => run.id === "account-promoted-run").status,
    "promoted",
    "an old promoted run must not interrupt the unrelated current turn",
  );
  assert.equal(
    accountManager.runs.find((run) => run.id === "account-unknown-run").status,
    "dispatch_unknown",
    "dispatch-unknown work remains unknown across principal changes",
  );

  let unavailableOwnerInterrupts = 0;
  const unavailableOwnerManager = new ScheduledTaskManager({
    resolvePrincipal: () => {
      throw new Error("account provider unavailable");
    },
  });
  unavailableOwnerManager.ctx = context();
  unavailableOwnerManager.ctx.turnOrchestrator = {
    interruptScheduledRun: () => {
      unavailableOwnerInterrupts += 1;
      return { ok: true };
    },
  };
  unavailableOwnerManager.runs = [{
    id: "unavailable-owner-running-run",
    taskId: "unavailable-owner-running-task",
    ownerPrincipal: "user:alice",
    sessionId: "origin-a",
    status: "running",
    turnId: "unavailable-owner-running-turn",
    dispatchAttemptId: "unavailable-owner-running-attempt",
  }];
  const unavailableOwnerCreate = unavailableOwnerManager.create({
    title: "must fail closed",
    prompt: "不要绑定到共享的 unavailable owner",
    scheduleText: "每天早上9点",
    sessionId: "origin-a",
    projectId: "project-a",
  });
  assert.equal(unavailableOwnerCreate.ok, false);
  assert.equal(unavailableOwnerCreate.error, "OWNER_SCOPE_UNAVAILABLE");
  assert.deepEqual(
    unavailableOwnerManager.handlePrincipalChange(),
    { ok: false, error: "OWNER_SCOPE_UNAVAILABLE" },
  );
  assert.equal(
    unavailableOwnerInterrupts,
    0,
    "transient principal resolution failure cannot interrupt another owner",
  );
  const unavailableLegacyRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "lily-scheduler-owner-unavailable-"),
  );
  const unavailableLegacyPath = path.join(
    unavailableLegacyRoot,
    "scheduled-tasks.json",
  );
  fs.writeFileSync(unavailableLegacyPath, JSON.stringify({
    tasks: [{
      id: "legacy-owner-unavailable",
      projectId: "project-a",
      sessionId: "origin-a",
      prompt: "认证恢复后再迁移",
      schedule: { type: "daily", hour: 9, minute: 0 },
    }],
  }), "utf8");
  const unavailableLegacyManager = new ScheduledTaskManager({
    dbPath: path.join(unavailableLegacyRoot, "scheduled-tasks.db"),
    legacyPath: unavailableLegacyPath,
    resolvePrincipal: () => {
      throw new Error("account provider unavailable");
    },
  });
  const unavailableLegacyLoad = unavailableLegacyManager.load();
  assert.equal(unavailableLegacyLoad.ok, false);
  assert.equal(unavailableLegacyLoad.error, "OWNER_SCOPE_UNAVAILABLE");
  assert.equal(
    fs.existsSync(unavailableLegacyPath),
    true,
    "owner-unavailable migration must preserve the legacy source for retry",
  );
  assert.equal(unavailableLegacyManager.tasks.length, 0);
  unavailableLegacyManager.close();
  fs.rmSync(unavailableLegacyRoot, { recursive: true, force: true });

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

  const reconciledRun = {
    id: "scheduled-ledger-reconcile-run",
    status: "queued",
    turnId: null,
    dispatchAttemptId: null,
    dispatchStartedAt: null,
    engineAcceptedAt: null,
  };
  let markedStarted = 0;
  let savedReconciled = 0;
  let settledReconciled = 0;
  dispatchScheduledRun({
    ctx: {
      turnOrchestrator: {
        sendUserMessage: async () => ({
          ok: true,
          duplicate: true,
          outcomeUnknown: true,
          turnId: "scheduled-ledger-turn",
          durableStatus: "dispatching",
          dispatchAttemptId: "scheduled-ledger-attempt",
          dispatchStartedAt: 1234,
          acceptedAt: null,
        }),
      },
    },
    task: { id: "scheduled-ledger-task", executionSessionId: "origin-a" },
    run: reconciledRun,
    nonInteractive: true,
    markRunStarted: () => { markedStarted += 1; },
    reconcileRun: (target, result) => reconcileScheduledRunWithTurn(target, result),
    finishRun: () => {},
    saveRun: () => { savedReconciled += 1; },
    onSettled: () => { settledReconciled += 1; },
  });
  await flushAsync();
  assert.equal(markedStarted, 0, "a durable duplicate must not be marked as a new execution");
  assert.equal(reconciledRun.status, "dispatch_unknown");
  assert.equal(reconciledRun.turnId, "scheduled-ledger-turn");
  assert.equal(reconciledRun.dispatchAttemptId, "scheduled-ledger-attempt");
  assert.equal(reconciledRun.dispatchStartedAt, 1234);
  assert.equal(savedReconciled, 1);
  assert.equal(settledReconciled, 1);

  reconcileScheduledRunWithTurn(reconciledRun, {
    duplicate: true,
    durableStatus: "completed",
    terminalType: "turn.completed",
    terminalAt: 2345,
  });
  assert.equal(reconciledRun.status, "succeeded");
  assert.equal(reconciledRun.finishedAt, new Date(2345).toISOString());

  const ownerFilteredRuns = [
    {
      id: "owner-filter-run-a",
      taskId: "owner-filter-task-a",
      ownerPrincipal: "user:alice",
      sessionId: "origin-a",
      status: "dispatch_unknown",
    },
    {
      id: "owner-filter-run-b",
      taskId: "owner-filter-task-b",
      ownerPrincipal: "user:bob",
      sessionId: "origin-b",
      status: "dispatch_unknown",
    },
  ];
  const ownerFilteredTasks = [
    { id: "owner-filter-task-a", enabled: true, status: "running" },
    { id: "owner-filter-task-b", enabled: true, status: "running" },
  ];
  const ownerLookupCalls = [];
  const ownerSavedRuns = [];
  reconcileScheduledRunsWithDurableTurns(
    {
      sessionManager: {
        findTurnInputByScheduledRun(sessionId, runId) {
          ownerLookupCalls.push({ sessionId, runId });
          return {
            turnId: `turn-${runId}`,
            status: "completed",
            terminalAt: 9876,
            terminalType: "turn.completed",
          };
        },
      },
    },
    ownerFilteredRuns,
    ownerFilteredTasks,
    {
      saveRun: (run) => ownerSavedRuns.push(run.id),
      saveTask: () => {},
    },
    "user:alice",
  );
  assert.deepEqual(ownerLookupCalls, [{
    sessionId: "origin-a",
    runId: "owner-filter-run-a",
  }]);
  assert.equal(ownerFilteredRuns[0].status, "succeeded");
  assert.equal(ownerFilteredRuns[1].status, "dispatch_unknown");
  assert.deepEqual(ownerSavedRuns, ["owner-filter-run-a"]);
  corruptManager.close();
  fs.rmSync(corruptRoot, { recursive: true, force: true });

  console.log("scheduled-task-isolation: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
