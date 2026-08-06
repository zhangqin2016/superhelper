#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createRuntimeEvent } = require("../src/main/runtime-event-schema.js");
const {
  ensureTaskLifecycle,
  taskIdFor,
  transitionTaskLifecycle,
  verificationLifecycleStatus,
} = require("../src/main/task-lifecycle-runtime.js");
const { bindTurnAdmission } = require("../src/main/task-core-runtime.js");

const events = [];
const lifecycle = {
  taskId: "task-runtime",
  turnId: "turn-runtime",
  status: "admitted",
  version: 0,
  deliveryStatus: "pending",
  graphId: "",
  attemptId: "",
  checkpointId: "",
  verification: {},
  delivery: {},
};
const ctx = {
  eventBus: { emit: (_sessionId, event) => events.push(createRuntimeEvent({ sessionId: "session-runtime", ...event })) },
  sessionManager: {
    ensureTaskLifecycle: () => ({ ok: true, idempotent: false, lifecycle }),
    transitionTaskLifecycle: (_sessionId, input) => ({
      ok: true,
      lifecycle: { ...lifecycle, status: input.status, version: lifecycle.version + 1, verification: input.verification || {}, deliveryStatus: "pending" },
    }),
  },
};
const state = { turnId: "turn-runtime", lifecycleTaskId: "turn-runtime", taskRun: { id: "task-runtime" } };

assert.equal(ensureTaskLifecycle(ctx, "session-runtime", state)?.ok, true);
assert.equal(transitionTaskLifecycle(ctx, "session-runtime", state, "running")?.ok, true);
assert.equal(taskIdFor(state), "turn-runtime");
assert.equal(taskIdFor({ turnId: "turn-fallback", taskRun: { id: "task-fallback" } }), "task-fallback");
assert.equal(events.length, 2);
assert.equal(events.at(-1).type, "task.lifecycle.updated");
assert.equal(events.at(-1).payload.taskId, "task-runtime");
assert.equal(verificationLifecycleStatus({ status: "not_required" }), "not_required");
assert.equal(verificationLifecycleStatus({ status: "unexpected" }), "unverified");

const admissionInputs = [];
const admissionCtx = {
  sessionManager: {
    _find: () => ({ id: "session-admission" }),
    resolveTurnOwnerScope: () => ({ ownerScope: "owner-admission" }),
    ensureTaskLifecycle: (_sessionId, input) => {
      admissionInputs.push({ phase: "admitted", ...input });
      return { ok: true, idempotent: true, lifecycle };
    },
    transitionTaskLifecycle: (_sessionId, input) => {
      admissionInputs.push({ phase: "transition", ...input });
      return { ok: true, lifecycle: { ...lifecycle, status: input.status, version: 1 } };
    },
  },
};
const admissionState = { turnId: "turn-admission", taskRun: null };
bindTurnAdmission(
  { ctx: admissionCtx },
  { id: "session-admission", projectId: "project-admission" },
  admissionState,
  { sessionId: "session-admission", turnId: "turn-admission", ownerScope: "owner-admission", delivery: "direct", status: "admitted" },
  "direct",
);
admissionState.taskRun = { id: "task-created-after-admission" };
transitionTaskLifecycle(admissionCtx, "session-admission", admissionState, "running");
assert.equal(admissionInputs[0].taskId, "turn-admission");
assert.equal(admissionInputs[1].taskId, "turn-admission");

console.log("task-lifecycle-runtime: ok");
