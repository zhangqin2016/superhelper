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
let sessionSequence = 0;
const sessions = new Map([
  ["origin-a", { id: "origin-a", projectId: "project-a" }],
  ["origin-b", { id: "origin-b", projectId: "project-a" }],
  ["wrong-project", { id: "wrong-project", projectId: "project-b" }],
]);
const sent = [];
const published = [];
const {
  ScheduledTaskManager,
} = require("../src/main/scheduled-tasks.js");

function context() {
  return {
    sessionManager: {
      findById: (id) => sessions.get(id) || null,
      createAutomationSession: (projectId, title, taskId) => {
        const session = {
          id: `automation-${++sessionSequence}`,
          projectId,
          title,
          hidden: true,
          automationTaskId: taskId,
        };
        sessions.set(session.id, session);
        return session;
      },
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
  assert.notEqual(first.task.executionSessionId, second.task.executionSessionId);
  assert.equal(sessions.get(first.task.executionSessionId).hidden, true);

  principal = "user:bob";
  assert.equal(manager.list({ projectId: "project-a" }).tasks.length, 0);
  assert.equal(manager.runNow(first.task.id).error, "NOT_FOUND");
  principal = "user:alice";

  first.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  second.task.nextRunAt = "2020-01-01T00:00:00.000Z";
  manager.save();
  await manager.tick();
  await Promise.resolve();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].sessionId, first.task.executionSessionId);
  assert.equal(sent[1].sessionId, second.task.executionSessionId);
  assert.equal(sent.every((item) => item.opts.permissionMode === "plan"), true);

  const activeRun = manager.runs.find((run) => run.taskId === first.task.id);
  manager.setEnabled(first.task.id, false, { projectId: "project-a" });
  manager.setEnabled(first.task.id, true, { projectId: "project-a" });
  assert.equal(manager.runNow(first.task.id).error, "ALREADY_RUNNING");
  assert.equal(manager.runs.filter((run) => run.taskId === first.task.id).length, 1);

  manager.completeRunById(activeRun.id, "turn.completed", { assistant: "A 完成" });
  assert.equal(published.at(-1).sessionId, "origin-a");
  assert.equal(published.at(-1).extra.meta.scheduledTaskRunId, activeRun.id);

  // Capacity remains bounded even when many tasks become due in one tick.
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
  await Promise.resolve();
  assert.equal(sent.length - before <= 1, true, "one prior run plus new claims must respect capacity two");

  for (const run of manager.runs.filter((item) => item.status === "queued" || item.status === "running")) {
    run.leaseExpiresAt = "2020-01-01T00:00:00.000Z";
    const task = manager.tasks.find((item) => item.id === run.taskId);
    if (task && !run.manual) task.nextRunAt = run.scheduledFor;
  }
  manager.save();
  manager.close();
  const recovered = createManager();
  assert.equal(
    recovered.runs.some((run) => run.status === "queued" || run.status === "running"),
    false,
    "expired leases must recover as terminal runs after restart",
  );
  assert.equal(
    recovered.tasks
      .filter((task) => manager.runs.some((run) => run.taskId === task.id && !run.manual))
      .every((task) => Date.parse(task.nextRunAt) > Date.parse(manager.runs.find((run) => run.taskId === task.id && !run.manual).scheduledFor)),
    true,
    "recovery must advance beyond an occurrence claimed before a crash",
  );
  recovered.close();

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
