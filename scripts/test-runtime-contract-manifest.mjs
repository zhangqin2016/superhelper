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
// Which events may be emitted with no turn active, and which may still be
// recorded after a turn ended, are contract facts too. The hand-kept copies in
// turn-event-types.js and runtime-event-bus.js had drifted from the contract
// in both directions (2026-09-19); they now derive from it. [gate: event-type-lists-from-contract]
assert.deepEqual([...runtimeSchema.TURN_OPTIONAL_TYPES].sort(), [...manifest.turnOptionalEventTypes].sort());
assert.deepEqual([...runtimeSchema.POST_TERMINAL_EVENT_TYPES].sort(), [...manifest.postTerminalEventTypes].sort());
assert.ok(manifest.turnOptionalEventTypes.includes("turn.parent_closure_recovery") && manifest.turnOptionalEventTypes.includes("context.compactionDecision"), "the union of the two drifted copies");
{
  const turnEventTypes = require("../src/main/turn-event-types.js");
  assert.equal(turnEventTypes.TERMINAL_TYPES, runtimeSchema.TERMINAL_EVENT_TYPES, "turn-event-types re-exports the contract set, not a copy");
  assert.equal(turnEventTypes.TURN_OPTIONAL_TYPES, runtimeSchema.TURN_OPTIONAL_TYPES);
  const bus = fs.readFileSync("src/main/runtime-event-bus.js", "utf8");
  assert.match(bus, /POST_TERMINAL_ALLOWED = POST_TERMINAL_EVENT_TYPES;/, "the bus reads the contract set");
  for (const rel of ["src/main/turn-event-types.js", "src/main/runtime-event-bus.js", "src/main/turn-orchestrator.js", "src/main/turn-runtime-event-router.js"]) {
    assert.ok(!/new Set\(\[\s*"turn\.(?:completed|failed)"/.test(fs.readFileSync(rel, "utf8")), `${rel} keeps no event-type list of its own`);
  }
}

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
  planSync: { todoAt: 100, toolsSinceTodo: 2, stale: true, reconciled: { source: "model", at: 120 }, tools: [{ privatePayload: "must not persist" }] },
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
  assert.deepEqual(compact(sample).planSync, { todoAt: 100, toolsSinceTodo: 2, stale: true, reconciled: { source: "model", at: 120 } }, `${label} keeps only the safe plan sync summary`);
  assert.equal(compact({ ...sample, planSync: null }).planSync, null, `${label} accepts old snapshots`);
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
