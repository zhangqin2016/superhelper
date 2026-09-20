import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
const { createOpencodeHistoryRecovery } = require("../src/main/opencode-history-recovery.js");

let status = "busy";
const recovery = createOpencodeHistoryRecovery({
  getTurnStartedAt: () => 100,
  getSessionStatus: async () => status,
  getServer: () => ({ lastPromptText: "long task", messages: async () => [
    { info: { id: "u", role: "user", time: { created: 101 } }, parts: [{ type: "text", text: "long task" }] },
    { info: { id: "a", parentID: "u", role: "assistant", finish: "tool-calls", time: { created: 102, completed: 103 } },
      parts: [{ type: "text", text: "I will inspect the next file." }] },
  ] }),
});
const runner = Object.create(OpencodeAgentSession.prototype);
runner._historyRecovery = recovery;
for (status of ["busy", "unknown"]) {
  assert.equal(await runner._recoverCompletedAssistantFromHistory({ requireCurrentPrompt: true }), null,
    `${status}: a completed assistant step is not a completed task`);
  assert.equal(await recovery.recoverStalledFinal(), null, `${status}: watchdog must not declare success`);
}
status = "idle";
assert.equal((await runner._recoverCompletedAssistantFromHistory({ requireCurrentPrompt: true })).engineMessageId, "a",
  "confirmed idle still recovers missing terminal delivery");

for (const boundary of ["history", "status"]) {
  let release;
  let completed = 0;
  let failed = 0;
  const r = Object.create(OpencodeAgentSession.prototype);
  Object.assign(r, {
    busy: true, _turnSettled: false, collectedOutput: "intermediate text",
    _pendingTransientFailure: { startedAt: Date.now() - 999999, message: "network" },
    _recoverCompletedAssistantFromHistory: () => boundary === "history"
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve(null),
    _getSessionStatus: () => new Promise(resolve => { release = resolve; }),
    _completeTurn: () => { completed++; }, _failTurn: () => { failed++; },
  });
  const pending = r._recoverOrContinueAfterTransientFailure();
  await new Promise(resolve => setImmediate(resolve));
  // Real progress clears the pending failure while this asynchronous read runs.
  r._pendingTransientFailure = null;
  release(boundary === "history" ? { output: "stale answer" } : "idle");
  await pending;
  assert.equal(completed, 0, `${boundary}: superseded recovery must not settle`);
  assert.equal(failed, 0, `${boundary}: superseded recovery must not fail`);
}
{
  const r = Object.create(OpencodeAgentSession.prototype);
  let polls = 0;
  Object.assign(r, {
    busy: true, _turnSettled: false, collectedOutput: "",
    _pendingTransientFailure: { startedAt: Date.now() - 999999, message: "network" },
    _recoverCompletedAssistantFromHistory: async () => null,
    _getSessionStatus: async () => "busy",
    _scheduleTransientFailureRecovery: () => { polls++; },
    _failTurn: () => assert.fail("a confirmed busy engine is not a transport timeout"),
  });
  await r._recoverOrContinueAfterTransientFailure();
  assert.equal(polls, 1, "busy work remains governed by progress/health guards, not the transport grace period");
}
console.log("long-turn-recovery-ownership: ok");
