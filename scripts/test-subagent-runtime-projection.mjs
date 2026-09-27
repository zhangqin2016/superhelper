#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createSubagentRuntimeProjection,
  refreshSubagentPhase,
  subagentPhaseDetail,
  subagentToolPhase,
} = require("../src/main/subagent-runtime-projection.js");
const { SLOW_SUBAGENT_MS } = require("../src/main/subagent-telemetry.js");

assert.equal(subagentToolPhase("Read"), "searching");
assert.equal(subagentToolPhase("Bash"), "running_command");
assert.equal(subagentToolPhase("Edit"), "editing");
assert.equal(subagentToolPhase("websearch"), "researching");
assert.equal(subagentToolPhase("custom"), "using_tool");
assert.equal(subagentPhaseDetail({ input: { file_path: "src/main/a.js" } }), "src/main/a.js");

const phaseItem = {
  status: "running",
  tools: new Map([["read_1", { id: "read_1", name: "Read", status: "running", input: { file_path: "a.js" } }]]),
  currentToolId: "read_1",
  pendingPermissions: [],
  pendingQuestions: [],
};
refreshSubagentPhase(phaseItem);
assert.equal(phaseItem.phase, "searching");
assert.equal(phaseItem.stats.runningTools, 1);

const states = new Map();
const stateFor = (sessionId) => {
  if (!states.has(sessionId)) {
    states.set(sessionId, {
      tools: new Map(),
      subagents: new Map(),
      subagentTimers: new Map(),
    });
  }
  return states.get(sessionId);
};
const notices = [];
const engineErrors = [];
const timers = [];
const cancelledTimers = [];
let clock = 1_000;
const runtime = createSubagentRuntimeProjection({
  getState: stateFor,
  emitEngineNotice: (sessionId, notice) => notices.push({ sessionId, notice }),
  onEngineError: (...args) => engineErrors.push(args),
  now: () => ++clock,
  setTimeout: (callback, delay) => {
    const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    timers.push(timer);
    return timer;
  },
  clearTimeout: (timer) => cancelledTimers.push(timer),
});

const parentState = stateFor("parent_1");
const taskTool = {
  id: "task_1",
  name: "Task",
  status: "running",
  input: { subagent_type: "research", description: "Inspect runtime routing" },
  metadata: { sessionId: "child_1", source: "opencode" },
};
parentState.tools.set(taskTool.id, taskTool);

const initial = runtime.syncFromTool("parent_1", taskTool);
assert.equal(initial.sessionId, "child_1");
assert.equal(initial.parentToolId, "task_1");
assert.equal(initial.label, "research");
assert.equal(initial.phase, "starting");
assert.equal(runtime.syncFromTool("parent_1", { name: "Read" }), null, "ordinary tools stay outside subagent state");

const reading = runtime.applyEvent("parent_1", {
  sessionId: "child_1",
  events: [
    { kind: "thinking", text: "Plan the inspection", ts: 1_100 },
    {
      kind: "tool",
      id: "read_1",
      name: "Read",
      status: "running",
      input: { file_path: "src/main/runtime-event-bus.js" },
      ts: 1_101,
    },
  ],
});
assert.equal(reading.subagent.phase, "searching");
assert.equal(reading.subagent.phaseDetail, "src/main/runtime-event-bus.js");
assert.equal(reading.subagent.stats.runningTools, 1);

const awaitingUser = runtime.applyEvent("parent_1", {
  sessionId: "child_1",
  events: [
    { kind: "permission", requestId: "perm_1", toolName: "Bash", status: "requested", ts: 1_102 },
    { kind: "permission", requestId: "perm_1", toolName: "Bash", status: "requested", ts: 1_103 },
  ],
});
assert.equal(awaitingUser.subagent.phase, "awaiting_user");
assert.equal(awaitingUser.subagent.pendingPermissions.length, 1, "duplicate prompts are collapsed");

const resumed = runtime.applyEvent("parent_1", {
  sessionId: "child_1",
  events: [{ kind: "permission", requestId: "perm_1", status: "approved", ts: 1_104 }],
});
assert.equal(resumed.subagent.phase, "searching");
assert.equal(resumed.subagent.pendingPermissions.length, 0);

const failed = runtime.applyEvent("parent_1", {
  sessionId: "child_1",
  events: [{ kind: "error", message: "empty response from gateway", ts: 1_105 }],
});
assert.equal(failed.subagent.status, "failed");
assert.equal(failed.subagent.phase, "failed");
assert.match(failed.subagent.lastError.message, /empty response/);
assert.deepEqual(engineErrors[0], ["parent_1", "child_1", "empty response from gateway"]);

runtime.scheduleWatch("parent_1", taskTool.id, taskTool);
assert.equal(timers.length, 2, "slow and very-slow watches are both scheduled");
assert(timers.every((timer) => timer.unrefCalled), "watch timers never keep Electron alive");
timers[0].callback();
assert.equal(notices.at(-1).notice.code, "subagentSlow");
assert.match(notices.at(-1).notice.detail, /Inspect runtime routing/);

runtime.clearWatch("parent_1", taskTool.id);
assert.equal(cancelledTimers.length, 2);
assert.equal(parentState.subagentTimers.has(taskTool.id), false);

runtime.emitDoneNotice("parent_1", {
  ...taskTool,
  status: "done",
  durationMs: SLOW_SUBAGENT_MS,
});
assert.equal(notices.at(-1).notice.code, "subagentCompleted");
assert.equal(notices.at(-1).notice.done, true);

const observerFailureRuntime = createSubagentRuntimeProjection({
  getState: stateFor,
  onEngineError: () => { throw new Error("observer unavailable"); },
  now: () => ++clock,
});
const observerFailure = observerFailureRuntime.applyEvent("parent_1", {
  sessionId: "child_observer_failure",
  events: [{ kind: "error", message: "model failed" }],
});
assert.equal(observerFailure.subagent.status, "failed", "diagnostic failure cannot hide child state");

const brokenRuntime = createSubagentRuntimeProjection({
  getState: () => { throw new Error("state unavailable"); },
});
assert.doesNotThrow(() => brokenRuntime.scheduleWatch("parent_1", "task_broken", taskTool));
assert.doesNotThrow(() => brokenRuntime.clearAllWatches("parent_1"));
assert.equal(
  brokenRuntime.applyEvent("parent_1", { sessionId: "child_broken", events: [] }),
  null,
  "projection failure falls open so the parent event loop can continue",
);

// --- Recovery-aware failure (2026-09-27): a failed tool the subagent RECOVERS
// from is not a failed subtask, and an authoritative done wins. Mirrors the main
// turn (fccfb9f3) via the shared tool-completion-status organ.
{
  const rec = createSubagentRuntimeProjection({ getState: stateFor });
  // grep fails (no match), then a later grep of the SAME tool succeeds.
  rec.applyEvent("parent_rec", { sessionId: "child_rec", events: [
    { kind: "tool", id: "g1", name: "grep", status: "running", ts: 1 },
    { kind: "tool", id: "g1", name: "grep", status: "failed", ts: 2 },
  ] });
  const afterFail = rec.applyEvent("parent_rec", { sessionId: "child_rec", events: [
    { kind: "tool", id: "g2", name: "grep", status: "done", result: "hit", ts: 3 },
  ] });
  assert.notEqual(afterFail.subagent.status, "failed", "a recovered tool failure is not a subagent failure");
  assert.notEqual(afterFail.subagent.phase, "failed", "recovered failure does not show phase failed");
  assert.equal(afterFail.subagent.stats.failedTools, 0, "the recovered grep is not counted as a failed tool");
}
{
  // A subagent that completes (authoritative done via the parent task tool) with
  // a prior unrecovered tool failure is DONE, not failed.
  const rec = createSubagentRuntimeProjection({ getState: stateFor });
  rec.applyEvent("parent_done", { sessionId: "child_done", events: [
    { kind: "tool", id: "b1", name: "bash", status: "failed", ts: 1 },
  ] });
  const done = rec.syncFromTool("parent_done", {
    id: "task_done", name: "task", status: "done",
    input: { subagent_type: "general" },
    metadata: { sessionId: "child_done" },
  });
  assert.equal(done.status, "done", "authoritative done wins over a prior tool failure");
  assert.equal(done.phase, "done", "a completed subagent shows done, not failed");
}
{
  // Guard the OLD bug directly: a lone failed tool, still running, must not
  // make the subtask read as failed (it has not recovered YET, but it is not done).
  const rec = createSubagentRuntimeProjection({ getState: stateFor });
  const live = rec.applyEvent("parent_live", { sessionId: "child_live", events: [
    { kind: "tool", id: "r1", name: "read", status: "running", ts: 1 },
  ] });
  assert.equal(live.subagent.status, "running", "a running subagent stays running");
}
{
  // The precise old-bug guard: a LONE failed tool (no recovery, no authoritative
  // done/failed) must NOT flip the subagent status to "failed" — only an engine
  // error or the parent task tool can. The old code set status="failed" here,
  // which fed the "N 个子任务失败" summary for a subagent that was merely mid-work.
  const rec = createSubagentRuntimeProjection({ getState: stateFor });
  const lone = rec.applyEvent("parent_lone", { sessionId: "child_lone", events: [
    { kind: "tool", id: "x1", name: "bash", status: "failed", ts: 1 },
  ] });
  assert.equal(lone.subagent.status, "running", "a lone failed tool does not authoritatively fail the subagent");
}

console.log("subagent-runtime-projection: ok");
