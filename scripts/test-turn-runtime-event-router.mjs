#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTurnRuntimeEventRouter } = require("../src/main/turn-runtime-event-router.js");

function createState(turnId = "turn_1") {
  return {
    turnId,
    phase: turnId ? "starting" : "idle",
    assistantText: "",
    thinkingText: "",
    contentBlocks: [],
    protocolUnknown: [],
    processEvents: [],
    notices: [],
    tools: new Map(),
    blockIndexToToolId: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingHooks: new Map(),
    timeline: [],
    taskContract: null,
  };
}

const state = createState();
const emitted = [];
const taskCalls = [];
const router = createTurnRuntimeEventRouter({
  getState: () => state,
  emit: (sessionId, type, payload, opts) => emitted.push({ sessionId, type, payload, opts }),
  taskRunRuntime: {
    markAwaitingUser: (...args) => taskCalls.push(["awaiting", ...args]),
    markResumedFromUser: (...args) => taskCalls.push(["resumed", ...args]),
    markProgress: (...args) => taskCalls.push(["progress", ...args]),
    updateLivenessFromNotice: (...args) => taskCalls.push(["liveness", ...args]),
  },
  subagentRuntime: {},
  now: () => 1_000,
});

router.applyDraft("session_1", { type: "assistant.delta", payload: { text: "hello" } });
assert.equal(state.assistantText, "hello");
assert.equal(emitted.at(-1).type, "assistant.delta");

router.applyDraft("session_1", {
  type: "permission.requested",
  payload: { requestId: "permission_1", toolName: "Bash" },
});
assert.equal(state.phase, "awaiting_user");
assert.equal(state.pendingPermissions.has("permission_1"), true);
assert.equal(taskCalls.at(-1)[0], "awaiting");

router.applyDraft("session_1", {
  type: "permission.resolved",
  payload: { requestId: "permission_1" },
});
assert.equal(state.phase, "streaming");
assert.equal(state.pendingPermissions.size, 0);
assert.equal(taskCalls.at(-1)[0], "resumed", "an answered permission returns the task to running");

// Field regression 2026-09-29: an answered question left the lifecycle at
// waiting_user for the rest of the turn. The task resumes only once NOTHING is
// left to answer — never while a second prompt is still open.
router.applyDraft("session_1", { type: "user_question.requested", payload: { requestId: "q_1" } });
router.applyDraft("session_1", { type: "permission.requested", payload: { requestId: "permission_2", toolName: "Bash" } });
router.applyDraft("session_1", { type: "user_question.resolved", payload: { requestId: "q_1" } });
assert.notEqual(taskCalls.at(-1)[0], "resumed", "still waiting on a permission: not resumed");
assert.equal(state.phase, "awaiting_user");
router.applyDraft("session_1", { type: "permission.resolved", payload: { requestId: "permission_2" } });
assert.equal(taskCalls.at(-1)[0], "resumed", "the last answer resumes the task");
assert.equal(state.phase, "streaming");
router.applyDraft("session_1", { type: "hook.requested", payload: { requestId: "h_1" } });
router.applyDraft("session_1", { type: "hook.resolved", payload: { requestId: "h_1" } });
assert.equal(taskCalls.at(-1)[0], "resumed", "a resolved hook resumes the task too");

router.applyDraft("session_1", {
  type: "engine.notice",
  payload: { notice: { code: "workProgress", level: "progress", detail: "2/5" } },
});
assert.equal(taskCalls.some((entry) => entry[0] === "liveness"), true);
assert.equal(state.notices.length, 1);

router.applyDraft("session_1", {
  type: "process.event",
  payload: { jobId: "process-job-1", event: { message: "building" } },
});
const processProgress = taskCalls.at(-1);
assert.equal(processProgress[0], "progress");
assert.deepEqual(processProgress[4], { resumeState: { processJobId: "process-job-1" } });

router.applyDraft("session_1", { type: "unknown.future.event", payload: {} });
assert.equal(emitted.at(-1).type, "engine.warning");
assert.equal(emitted.at(-1).payload.notice.code, "unknownRuntimeDraft");

const idleState = createState(null);
const idleEvents = [];
const idleRouter = createTurnRuntimeEventRouter({
  getState: () => idleState,
  emit: (_sessionId, type) => idleEvents.push(type),
});
idleRouter.applyDraft("session_idle", { type: "assistant.delta", payload: { text: "orphan" } });
assert.equal(idleState.assistantText, "", "orphan turn data is ignored");
idleRouter.applyDraft("session_idle", {
  type: "engine.notice",
  payload: { notice: { code: "compactBoundary", level: "progress" } },
});
assert.deepEqual(idleEvents, ["engine.notice"], "turn-optional maintenance events remain visible");

const brokenRouter = createTurnRuntimeEventRouter({
  getState: () => createState(),
  emit: () => { throw new Error("event bus unavailable"); },
});
assert.doesNotThrow(() => brokenRouter.applyDraft("session_broken", {
  type: "assistant.delta",
  payload: { text: "still preserve the parent loop" },
}));

console.log("turn-runtime-event-router: ok");
