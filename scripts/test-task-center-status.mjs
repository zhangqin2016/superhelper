#!/usr/bin/env node
// "等待确认" means someone is being asked NOW: the turn in flight is waiting
// on the user. Field case 2026-09-29: a finished turn's lifecycle had been
// left at waiting_user, and the task center showed a working session as
// "1 个会话等待确认" — the header counted it, the row said 待确认.
import assert from "node:assert/strict";

const { buildTaskCenterItems } = await import("../src/renderer/modules/task-center.js");
const projects = [{ id: "p", name: "qiche", path: "/Users/x/qiche", sessions: [{ id: "s1", title: "新对话" }] }];
const statusOf = (runtime) => buildTaskCenterItems({ projects, runtimes: [{ sessionId: "s1", queue: [], ...runtime }] })[0]?.status || null;

assert.equal(statusOf({ phase: "idle", turnId: null, taskLifecycle: { status: "waiting_user", turnId: "turn_old" } }), null,
  "an idle session with a stale waiting lifecycle is not waiting");
assert.equal(statusOf({ phase: "streaming", turnId: "turn_now", taskLifecycle: { status: "waiting_user", turnId: "turn_old" } }), "running",
  "another turn's waiting lifecycle does not make the running turn wait");
assert.equal(statusOf({ phase: "awaiting_user", turnId: "turn_now", taskLifecycle: { status: "waiting_user", turnId: "turn_now" } }), "waiting",
  "the turn in flight waiting on the user is waiting");
assert.equal(statusOf({ phase: "streaming", turnId: "turn_now", liveTurn: { permissions: new Map([["p1", {}]]), questions: new Map(), hooks: new Map() } }), "waiting",
  "an open permission prompt is waiting");
assert.equal(statusOf({ phase: "idle", turnId: null, taskLifecycle: { status: "outcome_unknown", turnId: "turn_old" } }), "failed",
  "an unknown outcome still asks for recovery");

console.log("task-center-status: ok");
