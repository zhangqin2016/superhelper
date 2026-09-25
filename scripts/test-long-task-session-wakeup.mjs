#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLongTaskWakeHandler, wakeTurnId } = require("../src/main/long-task/session-wakeup.js");
const calls = [];
const reservations = [];
const order = [];
const source = { sessionId: "session-a", turnId: "turn-a", ownerScope: "owner-a",
  status: "completed", userText: "Build the full report, verify every page, and deliver the final PDF.",
  taskCore: { contract: { intentContract: { objective: "Build and verify the report" } } } };
const ctx = {
  sessionManager: {
    findById: (id) => id === "session-a" ? { id, projectId: "project-a" } : null,
    resolveTurnOwnerScope: () => ({ ok: true, ownerScope: "owner-a" }),
    getTurnInputByTurnId: (sessionId, turnId) => sessionId === source.sessionId && turnId === source.turnId ? source : null,
    reserveTaskContinuation: (sessionId, input) => {
      order.push("reserve"); reservations.push({ sessionId, ...input }); return { ok: true };
    },
  },
  turnOrchestrator: {
    sendUserMessage: async (...args) => { order.push("send"); calls.push(args); return { ok: true, queued: true }; },
  },
};
const handler = createLongTaskWakeHandler(ctx);
const wake = { id: "wake:job-a", jobId: "job-a", turnId: "turn-a", sessionId: "session-a", projectId: "project-a", ownerScope: "owner-a" };
const job = { ...wake, id: "job-a", outputFiles: ["/tmp/result.pdf"], replayPolicy: "inspect",
  status: "succeeded", exitCode: 0, command: "python", args: ["render.py"], cwd: "/tmp",
  progress: { phase: "done", current: 10, total: 10 } };
assert.deepEqual(await handler(wake, job), { ok: true, duplicate: false });
assert.equal(calls.length, 1);
assert.equal(calls[0][1], source.userText, "wake must preserve the original objective, not replace it with a job label");
assert.deepEqual(calls[0][3].sourceTaskCore, source.taskCore);
assert.match(calls[0][3].engineText, /Build the full report/);
assert.deepEqual(order, ["reserve", "send"]);
assert.equal(reservations[0].sourceTurnId, job.turnId);
assert.equal(reservations[0].continuationTurnId, wakeTurnId(wake.id));
assert.equal(reservations[0].sessionId, wake.sessionId);
assert.match(reservations[0].progressKeys[0], /^[a-f0-9]{64}$/);
assert.equal(calls[0][3].recordUser, false);
assert.equal(calls[0][3].queueVisibility, "background");
assert.equal(calls[0][3].durableQueueKey, wake.id);
assert.equal(calls[0][3].turnId, wakeTurnId(wake.id));
assert.equal(calls[0][3].sourceTurnId, job.turnId);
assert.match(calls[0][3].engineText, /result\.pdf/);

const wrongOwner = createLongTaskWakeHandler({
  ...ctx,
  sessionManager: { ...ctx.sessionManager, resolveTurnOwnerScope: () => ({ ok: true, ownerScope: "owner-b" }) },
});
assert.deepEqual(await wrongOwner(wake, job), { ok: false, permanent: true, error: "OWNER_SCOPE_CHANGED" });
assert.equal(calls.length, 1, "scope mismatch cannot dispatch into another principal's session");
assert.equal((await handler(wake, { ...job, turnId: "foreign-turn" })).error, "JOB_SCOPE_CHANGED");
assert.equal((await handler(wake, { ...job, sessionId: "foreign-session" })).error, "JOB_SCOPE_CHANGED");
assert.equal(calls.length, 1);

for (const status of ["cancelled", "interrupted"]) {
  const denied = createLongTaskWakeHandler({ ...ctx,
    sessionManager: { ...ctx.sessionManager, getTurnInputByTurnId: () => ({ ...source, status }) } });
  assert.equal((await denied(wake, job)).error, "TASK_CONTINUATION_CANCELLED");
}
for (const missing of [null, { ...source, sessionId: "foreign" }, { ...source, ownerScope: "foreign" }]) {
  const denied = createLongTaskWakeHandler({ ...ctx,
    sessionManager: { ...ctx.sessionManager, getTurnInputByTurnId: () => missing } });
  assert.equal((await denied(wake, job)).ok, false);
}
assert.equal((await handler(wake, { ...job, replayPolicy: "never" })).ok, false);
for (const reserveTaskContinuation of [undefined,
  () => ({ ok: false, reason: "TASK_CONTINUATION_NO_PROGRESS" }),
  () => { throw new Error("database unavailable"); }]) {
  const denied = createLongTaskWakeHandler({ ...ctx,
    sessionManager: { ...ctx.sessionManager, reserveTaskContinuation } });
  assert.equal((await denied(wake, job)).ok, false);
}
const unavailableSource = createLongTaskWakeHandler({ ...ctx,
  sessionManager: { ...ctx.sessionManager, getTurnInputByTurnId: () => { throw new Error("sqlite busy"); } } });
assert.deepEqual(await unavailableSource(wake, job),
  { ok: false, permanent: false, error: "TASK_CONTINUATION_STATE_UNAVAILABLE" });
const unavailableBudget = createLongTaskWakeHandler({ ...ctx,
  sessionManager: { ...ctx.sessionManager, reserveTaskContinuation: () => { throw new Error("sqlite busy"); } } });
assert.deepEqual(await unavailableBudget(wake, job),
  { ok: false, permanent: false, error: "TASK_CONTINUATION_STATE_UNAVAILABLE" });
assert.equal(calls.length, 1, "cancelled, missing, foreign, never replay and budget failures cannot dispatch");
assert.equal(reservations.length, 1, "source rejection happens before spending a reservation");

const secondWake = { ...wake, id: "wake:job-b", jobId: "job-b" };
await handler(secondWake, { ...job, id: "job-b", createdAt: 999, updatedAt: 1000,
  progressSeq: 55, terminalAt: 1001, progress: { total: 10, phase: "done", current: 10 } });
assert.deepEqual(reservations[1].progressKeys, reservations[0].progressKeys,
  "a recreated job with the same successful receipt cannot replenish progress");
await handler(secondWake, { ...job, id: "job-b", progress: { phase: "done", current: 11, total: 11 } });
assert.notDeepEqual(reservations[2].progressKeys, reservations[0].progressKeys);
for (const status of ["failed", "outcome_unknown", "cancelled", "running"]) {
  await handler(secondWake, { ...job, id: "job-b", status, exitCode: 1 });
  assert.deepEqual(reservations.at(-1).progressKeys, [], `${status} cannot mint successful progress`);
}
await handler(secondWake, { ...job, id: "job-b", exitCode: null });
assert.deepEqual(reservations.at(-1).progressKeys, [], "success without a terminal exit receipt is not progress");


// --- 2026-09-25: a wake brings the outcome to the conversation; one it already
// read, or one it can read itself because it is still running, is not sent.
{
  const before = calls.length;
  const seen = { ...job, terminalAt: 1_000, outcomeObservedAt: 1_500 };
  assert.deepEqual(await handler(wake, seen), { ok: false, permanent: true, error: "JOB_OUTCOME_OBSERVED" });
  const unseen = { ...job, terminalAt: 1_000, outcomeObservedAt: 900 };
  assert.equal((await handler(wake, unseen)).ok, true, "an observation before the outcome is not the outcome");
  assert.equal(calls.length, before + 1);
  const reserved = reservations.length;
  const busy = createLongTaskWakeHandler({ ...ctx, turnOrchestrator: { ...ctx.turnOrchestrator, snapshot: () => ({ phase: "streaming", queueLength: 0 }) } });
  assert.deepEqual(await busy(wake, job), { ok: false, permanent: false, defer: true, error: "SESSION_BUSY" });
  const queued = createLongTaskWakeHandler({ ...ctx, turnOrchestrator: { ...ctx.turnOrchestrator, snapshot: () => ({ phase: "idle", queueLength: 2 }) } });
  assert.equal((await queued(wake, job)).error, "SESSION_BUSY", "a queued user message goes first");
  assert.equal(reservations.length, reserved, "waiting spends no continuation budget");
  const idle = createLongTaskWakeHandler({ ...ctx, turnOrchestrator: { ...ctx.turnOrchestrator, snapshot: () => ({ phase: "idle", queueLength: 0 }) } });
  assert.equal((await idle(wake, job)).ok, true);
}

// Wakes of one turn make one turn: siblings ride along, read ones retire.
{
  const before = calls.length;
  const sib = (id, extra = {}) => ({ wake: { ...wake, id: `wake:${id}`, jobId: id }, job: { ...job, id, ...extra } });
  const result = await handler(wake, job, { siblings: [sib("job-b"), sib("job-c", { terminalAt: 10, outcomeObservedAt: 20 }), sib("job-d", { turnId: "other-turn" })] });
  assert.deepEqual(result, { ok: true, duplicate: false, retired: ["wake:job-c"], carried: ["wake:job-b"] });
  assert.equal(calls.length, before + 1, "one turn for the whole group");
  const text = calls.at(-1)[3].engineText;
  assert.match(text, /2 durable background processes/);
  assert.match(text, /Job id: job-a/); assert.match(text, /Job id: job-b/);
  assert.doesNotMatch(text, /job-c|job-d/, "a read outcome and a foreign turn's job are not in the text");
  assert.equal(reservations.at(-1).progressKeys.length, 1, "identical receipts collapse into one progress key");
}

// The text follows where the task stands.
{
  // The user has sent a newer message since the turn that started the jobs.
  const movedOn = createLongTaskWakeHandler({ ...ctx, sessionManager: { ...ctx.sessionManager,
    getTurnInputByTurnId: () => ({ ...source, terminalType: "turn.completed" }), getLastUserMessage: () => ({ role: "user", turnId: "turn-later", content: "next thing" }) } });
  await movedOn(wake, job);
  const text = calls.at(-1)[3].engineText;
  assert.match(text, /moved on to a newer request/);
  assert.match(text, /Do not redo or re-verify/);
  assert.doesNotMatch(text, /continue the (original )?task/, "a task the user moved on from is reported on, not resumed");
  // The turn answered while the jobs ran and nothing newer came: the jobs may
  // be what the task was waiting on.
  const answered = createLongTaskWakeHandler({ ...ctx, sessionManager: { ...ctx.sessionManager,
    getTurnInputByTurnId: () => ({ ...source, terminalType: "turn.completed" }), getLastUserMessage: () => ({ role: "user", turnId: "turn-a", content: source.userText }) } });
  await answered(wake, job);
  const waiting = calls.at(-1)[3].engineText;
  assert.match(waiting, /continue the task from there/, "a task that may be waiting on the jobs is continued");
  assert.match(waiting, /Do not redo work that answer already did/);
  const open = createLongTaskWakeHandler({ ...ctx, sessionManager: { ...ctx.sessionManager, getTurnInputByTurnId: () => ({ ...source, status: "running", terminalType: null }) } });
  await open(wake, job);
  assert.match(calls.at(-1)[3].engineText, /continue the original task/, "an unfinished task is still continued");
}

console.log("long-task-session-wakeup: ok");
