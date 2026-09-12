import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { rememberExecutionProgress, executionProgressKeys } = require("../src/main/task-execution-progress");
const { createTurnGateState, claimContinuation } = require("../src/main/turn-continuation-budget");
const { buildTodoGiveUpPayload, todoContinuationDecision } = require("../src/main/opencode-todo-completion-policy");
const { shouldRecoverParentClosure } = require("../src/main/parent-task-closure");

const state = createTurnGateState();
let sequence = 0;
function receipt(record, isError = false) {
  const id = String(++sequence);
  rememberExecutionProgress(state.todo, { type: "tool.started", payload: { id, name: "read", input: { filePath: `/synthetic/${record}` } } });
  return rememberExecutionProgress(state.todo, { type: "tool.done", payload: { id, content: `record ${record}`, isError } });
}
for (let i = 0; i < 3200; i++) {
  state.todo.attempts = 1;
  assert.equal(receipt(i), true, `fresh successful receipt ${i} remains observable`);
  assert.equal(state.todo.attempts, 0);
}
state.todo.attempts = 1;
assert.equal(executionProgressKeys(state.todo).length, 128);
assert.ok(executionProgressKeys(state.todo).every(key => /^[a-f0-9]{64}$/.test(key)));
assert.deepEqual(executionProgressKeys({}), []);
assert.equal(receipt(3199), false, "new call ID is not new progress");
assert.equal(receipt("failed", true), false, "failed work earns no continuation");
assert.equal(state.todo.attempts, 1);
assert.deepEqual(Array.from({ length: 6 }, () => claimContinuation(state, "todo")), [true, true, true, true, false, false], "progress cannot replenish absolute cap");

const snapshot = { total: 4, completed: 1, unfinished: [{ title: "remaining batches", status: "in_progress" }] };
function settled(gate, decision = todoContinuationDecision(snapshot, gate.attempts, gate.total)) {
  return buildTodoGiveUpPayload({ code: 0, output: "Partial report" }, snapshot, "", { gate, decision });
}
const productive = settled({ attempts: 0, total: 6, progress: 3000 });
assert.equal(productive.continuationHandoff?.reason, "budget_exhausted", "productive absolute exhaustion retains bounded parent handoff");
assert.equal(productive.continuationStopReason, "turn_budget_exhausted");
assert.match(productive.output, /上限/);
assert.ok(productive.output.startsWith("Partial report"));
const stuck = settled({ attempts: 2, total: 6, progress: 3000 });
assert.equal(stuck.continuationHandoff, undefined, "historical progress cannot bypass current no-progress limit");
assert.equal(stuck.continuationStopReason, "no_progress");
assert.match(stuck.output, /未观察到新的执行进展/);
const shared = settled({ attempts: 0, total: 4, progress: 20 }, "nudge");
assert.equal(shared.continuationHandoff?.reason, "budget_exhausted");
assert.equal(settled({ attempts: 0, total: 6, progress: 0 }).continuationHandoff, undefined);
assert.equal(settled({ attempts: 2, total: 2, progress: 0 }).code, 0, "partial text is preserved, not fabricated as transport failure");
// A long repeated cycle can exceed the recent window. It must STILL be bounded
// by independent total allowances, never promoted to unlimited task recovery.
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < 1500; i++) receipt(i);
  assert.equal(claimContinuation(state, "todo"), false);
}
const recovery = { sessionId: "synthetic", taskContract: { active: true, taskType: "code_change" },
  state: { turnId: "synthetic-turn", tools: new Map([["receipt", { name: "read", status: "done" }]]) }, payload: productive };
assert.equal(shouldRecoverParentClosure(recovery).ok, true);
assert.equal(shouldRecoverParentClosure({ ...recovery, state: { ...recovery.state, currentPayload: { parentClosureRecovery: true } } }).ok, false, "bounded handoff cannot recurse");
assert.equal(shouldRecoverParentClosure({ ...recovery, payload: { ...productive, interruptedByUser: true } }).ok, false);
assert.equal(shouldRecoverParentClosure({ ...recovery, state: { ...recovery.state, pendingPermissions: new Map([["permission", {}]]) } }).ok, false);
const answerless = buildTodoGiveUpPayload({ code: 0 }, snapshot, "", { gate: { attempts: 2, total: 2, progress: 3 } });
assert.equal(answerless.stalled, true);
assert.match(answerless.output, /未观察到新的执行进展/);
assert.equal(shouldRecoverParentClosure({ ...recovery, payload: answerless }).reason, "NO_PROGRESS", "generic stalled recovery cannot bypass no-progress stop");
assert.equal(buildTodoGiveUpPayload(productive, snapshot, "", { gate: { attempts: 2, total: 2, progress: 3 } }).continuationHandoff, undefined, "no-progress clears stale handoff");
console.log("task long progress: passed");
