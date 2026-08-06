#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");

const bus = new RuntimeEventBus(() => null, {
  getEventContext: (sessionId) => ({
    ownerScope: `owner:${sessionId}`,
    projectId: "project-1",
    taskId: "task-1",
    attemptId: "attempt-1",
  }),
});
const event = bus.emit("session-1", {
  type: "task.created",
  turnId: "turn-1",
  source: "task-run",
  payload: { taskRun: { id: "task-1" } },
})[0];

assert.equal(event.ownerScope, "owner:session-1");
assert.equal(event.projectId, "project-1");
assert.equal(event.taskId, "task-1");
assert.equal(event.attemptId, "attempt-1");
console.log("task-core-runtime-event-context: ok");
