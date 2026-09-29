#!/usr/bin/env node
// A task that waited for the user runs again once answered, and still reaches
// a terminal state. Field case 2026-09-29: the agent asked a question, the
// user answered four seconds later, and the lifecycle stayed "waiting_user"
// — the store allows waiting_user only to running, so the terminal
// "verifying" was refused and the task center showed "待确认" for a session
// that was plainly working, through every later turn.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTaskRunRuntime } = require("../src/main/task-run-runtime.js");
const { createTaskRun } = require("../src/main/task-run-state.js");
const { TRANSITIONS } = require("../src/main/store/task-lifecycle-store.js");

function harness() {
  let status = "running";
  const refused = [];
  const ctx = {
    sessionManager: {
      // The real state machine's rules, applied to one durable row.
      transitionTaskLifecycle: (_sessionId, input) => {
        if (input.status !== status && !TRANSITIONS.get(status)?.has(input.status)) {
          refused.push(`${status}->${input.status}`);
          return { ok: false, reason: "INVALID_TRANSITION" };
        }
        status = input.status;
        return { ok: true, lifecycle: { status } };
      },
    },
  };
  const state = { turnId: "turn_wait", lifecycleTaskId: "turn_wait", taskRun: createTaskRun({ turnId: "turn_wait" }) };
  const runtime = createTaskRunRuntime({ ctx, getState: () => state });
  return { runtime, state, refused, status: () => status };
}

{
  const { runtime, state, refused, status } = harness();
  runtime.markAwaitingUser("s", "user_question_requested", "Waiting for user answer");
  assert.equal(status(), "waiting_user");
  runtime.markResumedFromUser("s");
  assert.equal(status(), "running", "answered: the task is running again");
  assert.equal(state.taskRun.status, "running");
  runtime.complete("s", "turn.completed");
  assert.deepEqual(refused, [], "no transition is refused on the way to the end");
  assert.ok(["verified", "unverified", "observed", "not_required", "blocked"].includes(status()), `the task reaches a terminal state, got ${status()}`);
}

// Resuming when nothing was awaited is a no-op, never a spurious transition.
{
  const { runtime, refused, status } = harness();
  runtime.markResumedFromUser("s");
  assert.equal(status(), "running");
  assert.deepEqual(refused, []);
}

console.log("task-wait-resume: ok");
