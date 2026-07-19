#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync("src/shared/runtime-contract.json", "utf8"));
const runtimeSchema = require("../src/main/runtime-event-schema.js");
const { compactTaskRun: compactMainTaskRun } = require("../src/main/task-run-state.js");
const { compactTaskRun: compactPersistedTaskRun } = require("../src/main/store/runtime-event-persistence.js");
const { compactTaskRunForStore } = await import("../src/renderer/modules/session-runtime-store.js");

assert.equal(manifest.schemaVersion, runtimeSchema.RUNTIME_EVENT_SCHEMA_VERSION);
assert.deepEqual([...runtimeSchema.RUNTIME_EVENT_TYPES].sort(), [...manifest.eventTypes].sort());
assert.deepEqual([...runtimeSchema.TERMINAL_EVENT_TYPES].sort(), [...manifest.terminalEventTypes].sort());

const sample = Object.fromEntries(manifest.taskRunFields.map((field) => [field, null]));
Object.assign(sample, {
  schemaVersion: manifest.taskRunSchemaVersion,
  id: "task-1",
  sessionId: "session-1",
  turnId: "turn-1",
  objective: "verify contract projection",
  status: "completed",
  completionStatus: "verified_complete",
  intentContractId: "intent-1",
  intentRevision: 2,
  intentRelation: "continue",
  deliverables: ["result"],
  successCriteria: ["verified"],
  phase: "completed",
  plan: [],
  evidence: [],
  risks: [],
  resumeState: {},
});

for (const [label, compact] of [
  ["main", compactMainTaskRun],
  ["persistence", compactPersistedTaskRun],
  ["renderer", compactTaskRunForStore],
]) {
  assert.deepEqual(
    Object.keys(compact(sample)).sort(),
    [...manifest.taskRunFields].sort(),
    `${label} TaskRun projection drifted from the shared contract`,
  );
}

const event = runtimeSchema.createRuntimeEvent({
  type: "turn.started",
  sessionId: "session-1",
  turnId: "turn-1",
  payload: { text: "verify runtime contract" },
});
assert.equal(event.schemaVersion, manifest.schemaVersion);
assert.throws(
  () => runtimeSchema.assertRuntimeEvent({ ...event, schemaVersion: manifest.schemaVersion + 1 }),
  /Unsupported RuntimeEvent schemaVersion/,
);

console.log("runtime-contract-manifest: ok");
