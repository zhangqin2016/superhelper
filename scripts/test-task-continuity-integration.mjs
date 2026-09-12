#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store");
const { LongTaskStore } = require("../src/main/long-task/store");
const { LongTaskSupervisor } = require("../src/main/long-task/supervisor");
const { createLongTaskWakeHandler } = require("../src/main/long-task/session-wakeup");
const { reserveTaskContinuation } = require("../src/main/store/task-continuation-budget");
const { createTurnRecoveryRuntime } = require("../src/main/turn-recovery-runtime");
const { createTurnAdmissionMethods } = require("../src/main/turn-admission-runtime");
const { queueDispatchOptions } = require("../src/main/turn-queue-options");
const sessionAdmission = require("../src/main/session-turn-admission");
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-continuity-integration-"));
  let now = 1000;
  const ownerScope = "owner-a", sessionId = "session-a", projectId = "project-a";
  let messages = new MessageStore(path.join(dir, "messages.db"), path.join(dir, "blobs"));
  const dbPath = path.join(dir, "jobs.db");
  const jobs = new LongTaskStore({ filePath: dbPath, now: () => now });
  t.after(() => { jobs.close(); messages.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  function admit(turnId, sourceTurnId, extra = {}) {
    return messages.admitTurnInput(sessionId, { turnId, userText: "Process all 22280 records",
      delivery: "direct", status: "completed", files: [], metadata: {}, createdAt: ++now },
    { ownerScope, ...(sourceTurnId ? { sourceTurnId } : {}), ...extra });
  }
  const reserve = (input) => reserveTaskContinuation(messages.db, { sessionId, ownerScope, now, ...input });
  const sends = [];
  const manager = {
    findById: () => ({ id: sessionId, projectId }),
    resolveTurnOwnerScope: () => ({ ok: true, ownerScope }),
    getTurnInputByTurnId: (_, id) => messages.getTurnInputByTurnId(id, ownerScope),
    reserveTaskContinuation: (_, input) => reserve(input),
  };
  const handler = createLongTaskWakeHandler({ sessionManager: manager,
    turnOrchestrator: { sendUserMessage: async (_, text, files, opts) => {
      sends.push(opts); admit(opts.turnId, opts.sourceTurnId); return { ok: true };
    } },
  });
  function batch(id, source, current) {
    const scope = { ownerScope, sessionId, projectId, turnId: source };
    jobs.createJob({ id, scope, command: "node", args: ["batch.js", "--resume"], cwd: dir,
      replayPolicy: "inspect", idempotencyKey: id, outputFiles: [path.join(dir, "records.json")] });
    const stdoutPath = path.join(dir, `${id}.stdout.log`);
    fs.writeFileSync(stdoutPath, `[lily-progress] ${JSON.stringify({ current, total: 22280 })}\n`);
    fs.writeFileSync(path.join(dir, `${id}.terminal.json`), JSON.stringify({ exitCode: 0, launchNonce: id }));
    const lease = jobs.claimLease(scope, id, { holder: "fixture", ttlMs: 1000 });
    assert.equal(jobs.attachProcess(scope, id, { holder: "fixture", fencingEpoch: lease.job.fencingEpoch,
      pid: 123, processIdentity: { launchNonce: id }, stdoutPath }).ok, true);
    now += 1001;
  }
  const supervisor = () => new LongTaskSupervisor({ dbPath, jobsDir: dir, now: () => now, onWake: handler });
  const reopen = () => {
    messages.close();
    messages = new MessageStore(path.join(dir, "messages.db"), path.join(dir, "blobs"));
  };
  return { dir, get messages() { return messages; }, jobs, admit, reserve, sends, manager, batch, supervisor, sessionId, ownerScope, reopen };
}

test("supervisor terminal progress admits productive batches across restart but rejects an unchanged receipt", async (t) => {
  const f = fixture(t);
  f.admit("root");
  f.batch("batch-1", "root", 1500);
  const first = f.supervisor();
  await first.reconcileOnce();
  assert.equal((await first.deliverWakesOnce()).delivered, 1);
  f.batch("batch-2", f.sends[0].turnId, 3000);
  const restarted = f.supervisor();
  await restarted.reconcileOnce();
  assert.equal((await restarted.deliverWakesOnce()).delivered, 1,
    "a productive second batch must not be abandoned as TASK_CONTINUATION_NO_PROGRESS");
  assert.deepEqual(f.jobs.getJobTrusted("batch-2").progress, { current: 3000, total: 22280 });
  assert.equal((await restarted.deliverWakesOnce()).claimed, 0, "one stable wake per job");
  f.batch("batch-3", f.sends[1].turnId, 3000);
  await restarted.reconcileOnce();
  assert.equal((await restarted.deliverWakesOnce()).abandoned, 1);
  assert.equal(f.jobs.getWake("wake:batch-3").lastError, "TASK_CONTINUATION_NO_PROGRESS");
  assert.equal(f.sends.length, 2, "the fix must not create a repeat-without-progress loop");
});

test("explicit user retry renews its budget through direct and queued admission, not automatic recovery", async (t) => {
  const f = fixture(t);
  f.admit("spent-root");
  for (let i = 0; i < 8; i++) {
    assert.equal(f.reserve({ sourceTurnId: "spent-root", continuationTurnId: `auto-${i}`, progressKeys: [hash(i)] }).ok, true);
  }
  Object.assign(f.manager, {
    _find: f.manager.findById, _ensureImported() {}, _resolveCharacterOwnerScope: () => f.ownerScope,
    _store: () => f.messages,
    admitTurnInputFromSource: sessionAdmission.admitTurnInputFromSource,
    admitQueuedTurnInput: sessionAdmission.admitQueuedTurnInput,
    getLastUserMessage: () => ({ turnId: "spent-root", content: "Process all 22280 records", files: [] }),
  });
  let id = "manual-direct";
  let expectedSource = "spent-root";
  const queueState = { phase: "streaming", queue: [] };
  const admission = Object.assign({ ctx: { sessionManager: f.manager }, _state: () => queueState, _emitQueue() {} }, createTurnAdmissionMethods({
    log: { warn() {} }, newTurnId: () => id, newQueueId: () => id,
    mergeDisplayFileMetadata: (files) => files, queueDispatchOptions,
  }));
  const recovery = createTurnRecoveryRuntime({ ctx: { sessionManager: f.manager },
    sendUserMessage: async (_, text, files, opts) => {
      assert.equal(opts.sourceTurnId, expectedSource, "retry keeps task/persona provenance");
      if (id.includes("queued")) {
        const result = await admission.sendUserMessage(f.sessionId, text, files, { ...opts, turnId: id });
        assert.equal(result.ok, true);
        assert.equal(result.queued, true);
      } else {
        admission._admitTurnInput(f.manager.findById(), { turnId: id, userText: text,
          sourceTurnId: opts.sourceTurnId, newTaskAttempt: opts.newTaskAttempt });
      }
      return { ok: true, turnId: id };
    },
  });
  t.after(() => recovery.disposeParentClosureRecovery());
  for (const next of ["manual-direct", "manual-queued"]) {
    id = next;
    assert.equal((await recovery.retryLastMessage(f.sessionId, { userInitiated: true })).ok, true);
    f.reopen();
    const claim = f.reserve({ sourceTurnId: id, continuationTurnId: `${id}-next`, progressKeys: [hash(id)] });
    assert.equal(claim.ok, true, "manual retry cannot inherit the exhausted original allowance");
    assert.equal(claim.rootTurnId, id);
  }
  id = "automatic-retry";
  await recovery.retryLastMessage(f.sessionId);
  assert.equal(f.reserve({ sourceTurnId: id, continuationTurnId: `${id}-next`, progressKeys: [hash(id)] }).reason,
    "TASK_CONTINUATION_BUDGET_EXHAUSTED", "automatic recovery must never replenish the old root");
  assert.equal(f.reserve({ sourceTurnId: "spent-root", continuationTurnId: "late-job", progressKeys: [hash("late")] }).ok,
    false, "new authorization does not revive old jobs");
  await recovery.afterParentClosureTerminal(f.sessionId, { state: { turnId: "manual-direct" } }, {
    failed: true, failure: { code: "RUNNER_ERROR" },
    selfHeal: async (_, failure) => {
      assert.equal(failure.sourceTurnId, "manual-direct",
        "self-heal must inherit the attempt that actually failed, not the last visible user turn");
      expectedSource = "manual-direct"; id = "healed-manual";
      await recovery.retryLastMessage(f.sessionId, { sourceTurnId: failure.sourceTurnId });
      const claim = f.reserve({ sourceTurnId: id, continuationTurnId: `${id}-next`, progressKeys: [hash(id)] });
      assert.equal(claim.ok, true);
      assert.equal(claim.rootTurnId, "manual-direct", "self-heal retains the new attempt's bounded root");
    },
  });
});

test("abandoned wakes retry their notice after restart without redispatching the model", async (t) => {
  const f = fixture(t);
  f.admit("root");
  f.batch("notice-job", "root", 1500);
  let modelCalls = 0, noticeCalls = 0;
  const make = (onWakeAbandoned) => new LongTaskSupervisor({
    dbPath: f.jobs.filePath, jobsDir: f.dir,
    onWake: async () => { modelCalls++; return { ok: false, permanent: true, error: "TASK_CONTINUATION_BUDGET_EXHAUSTED" }; },
    onWakeAbandoned,
  });
  const first = make(async (wake, job) => {
    noticeCalls++;
    assert.equal(wake.lastError, "TASK_CONTINUATION_BUDGET_EXHAUSTED");
    assert.equal(job.status, "succeeded", "process success is distinct from task completion");
    return { ok: false };
  });
  await first.reconcileOnce();
  await first.deliverWakesOnce();
  assert.equal(noticeCalls, 1, "permanent refusal must not disappear into a database-only error");
  // Simulate a later restart after the bounded publication backoff.
  const restarted = make(async () => { noticeCalls++; return { ok: true }; });
  restarted.now = () => Date.now() + 60_000;
  await restarted.deliverWakesOnce();
  await restarted.deliverWakesOnce();
  assert.equal(noticeCalls, 2, "notice is acknowledged only after successful publication");
  assert.equal(modelCalls, 1, "publication retry cannot restart task execution");
});

test("pause notices persist once and reach the renderer without replacing an answer or the active turn", async (t) => {
  const f = fixture(t);
  const { createLongTaskPauseHandler } = require("../src/main/long-task/session-wakeup");
  assert.equal(typeof createLongTaskPauseHandler, "function", "wire durable pause publication to the conversation");
  const { RuntimeEventBus } = require("../src/main/runtime-event-bus");
  const renderer = await import("../src/renderer/modules/session-runtime-store.js");
  const events = [];
  const bus = new RuntimeEventBus(() => null);
  bus.addObserver((_, batch) => events.push(...batch));
  Object.assign(f.manager, {
    findMessage: (_, id) => f.messages.getById(id),
    pushMessageTo: (_, role, content, files, extra) => f.messages.append(f.sessionId, {
      role, content, files, ...extra, timestamp: new Date().toISOString(),
    }),
  });
  f.admit("root"); f.batch("pause", "root", 3000);
  await f.supervisor().reconcileOnce();
  const job = f.jobs.getJobTrusted("pause");
  const wake = { ...f.jobs.getWake("wake:pause"), status: "abandoned", lastError: "TASK_CONTINUATION_NO_PROGRESS" };
  const publish = createLongTaskPauseHandler({ sessionManager: f.manager, eventBus: bus });
  assert.equal((await publish(wake, job)).ok, true);
  assert.equal((await publish(wake, job)).ok, true);
  const persisted = f.messages.getAll(f.sessionId);
  f.reopen();
  assert.equal(f.messages.getAll(f.sessionId)[0].id, persisted[0].id, "pause survives closing and reopening SQLite");
  assert.equal(persisted.length, 1, "duplicate publication cannot duplicate the transcript notice");
  assert.match(persisted[0].content, /未完成|尚未/);
  assert.match(persisted[0].content, /3000/);
  assert.equal(persisted[0].meta.taskContinuation.reason, wake.lastError);
  const { mergeProjectionConversation } = require("../src/main/opencode-conversation-source");
  const merged = mergeProjectionConversation([{ id: "old-answer", role: "assistant", turnId: "root",
    content: "Partial results already delivered", timestamp: new Date().toISOString() }], persisted);
  assert.equal(merged.length, 2, "canonical engine history must retain both partial answer and platform status");
  renderer.applyRuntimeEvent({ sessionId: f.sessionId, turnId: "new-active", type: "turn.started", ts: 1, payload: {} });
  renderer.applyRuntimeEvent({ sessionId: f.sessionId, turnId: "new-active", type: "assistant.delta", ts: 2,
    payload: { text: "A different task is running" } });
  for (const event of events) renderer.applyRuntimeEvent(event);
  const runtime = renderer.getRuntimeSession(f.sessionId);
  assert.equal(runtime.liveTurn.turnId, "new-active");
  assert.equal(runtime.liveTurn.assistantText, "A different task is running");
  assert.equal(runtime.committedMessages.filter((m) => m.id === persisted[0].id).length, 1);
  f.manager.resolveTurnOwnerScope = () => ({ ok: true, ownerScope: "foreign" });
  const before = events.length;
  assert.equal((await publish(wake, job)).ok, true, "discard publication for a revoked owner");
  assert.equal(events.length, before, "must never leak another account's task or progress");
});

test("a worker finishing between progress observation and marker observation cannot seal stale progress", async (t) => {
  const f = fixture(t);
  f.admit("race-root"); f.batch("race", "race-root", 1500);
  const marker = path.join(f.dir, "race.terminal.json");
  fs.unlinkSync(marker);
  const original = LongTaskStore.prototype.recordProgress;
  t.after(() => { LongTaskStore.prototype.recordProgress = original; });
  let wrote = false;
  LongTaskStore.prototype.recordProgress = function (...args) {
    const result = original.apply(this, args);
    if (!wrote && args[1] === "race") {
      wrote = true;
      fs.appendFileSync(path.join(f.dir, "race.stdout.log"), '[lily-progress] {"current":3000,"total":22280}\n');
      fs.writeFileSync(marker, JSON.stringify({ exitCode: 0, launchNonce: "race" }));
    }
    return result;
  };
  await f.supervisor().reconcileOnce();
  const job = f.jobs.getJobTrusted("race");
  assert.equal(job.status, "succeeded");
  assert.equal(job.progress.current, 3000, "terminal marker must precede the final progress snapshot");
});

test("automatic retry pairs the captured task identity with its own text and attachments", async (t) => {
  const f = fixture(t);
  f.admit("original");
  const captured = { ...f.manager.getTurnInputByTurnId(f.sessionId, "original"),
    files: [{ name: "original.txt", path: "/original.txt" }] };
  f.manager.getTurnInputByTurnId = () => captured;
  f.manager.getLastUserMessage = () => ({ turnId: "new-request", content: "A DIFFERENT TASK", files: [] });
  const calls = [];
  const recovery = createTurnRecoveryRuntime({ ctx: { sessionManager: f.manager },
    sendUserMessage: async (...args) => { calls.push(args); return { ok: true }; },
    getState: () => ({ turnId: null, queue: [], tools: new Map() }), sleep: async () => {},
    transcriptStore: { removeLastAssistantMessage: () => assert.fail("source recovery cannot delete the latest task's answer"),
      supersedeAssistantTurn: () => null },
  });
  t.after(() => recovery.disposeParentClosureRecovery());
  await recovery.retryLastMessage(f.sessionId, { sourceTurnId: "original" });
  assert.equal(calls[0][1], captured.userText, "an old job cannot replay the newer user request under its own identity");
  assert.deepEqual(calls[0][2], captured.files);
  const rescue = require("../src/main/tool-call-rescue");
  rescue.resetRescueStateForTests();
  assert.equal(await recovery.maybeToolCallRescueRetry(f.sessionId, {
    code: "EMPTY_ASSISTANT_COMPLETION", sourceTurnId: "original",
  }), true);
  assert.equal(calls[1][1], captured.userText, "rescue replay must use the same captured input as self-heal");
  assert.deepEqual(calls[1][2], captured.files);
  f.manager.getTurnInputByTurnId = () => null;
  assert.equal((await recovery.retryLastMessage(f.sessionId, { sourceTurnId: "original" })).ok, false);
  assert.equal(calls.length, 2, "missing source must not substitute a different request");
});

test("stale or unpersisted terminal decisions cannot trigger any automatic recovery", async (t) => {
  const f = fixture(t);
  let retries = 0;
  const recovery = createTurnRecoveryRuntime({ ctx: { sessionManager: f.manager } });
  t.after(() => recovery.disposeParentClosureRecovery());
  await recovery.afterParentClosureTerminal(f.sessionId, null, {
    failed: true, failure: { code: "RUNNER_ERROR", sourceTurnId: "original" },
    suppressRecovery: true, selfHeal: () => { retries++; },
  });
  assert.equal(retries, 0, "unknown dispatch/terminal outcomes cannot authorize a replay");
});
