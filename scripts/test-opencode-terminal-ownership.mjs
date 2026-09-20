import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session");
const { createOpencodeHistoryRecovery } = require("../src/main/opencode-history-recovery");
const { createOpencodeTurnLiveness } = require("../src/main/opencode-turn-liveness");
const flush = () => new Promise(setImmediate);

for (const boundary of ["unknown", "status", "history", "replay", "replacement", "success"]) {
  const r = Object.create(OpencodeAgentSession.prototype);
  let release;
  let completed = 0;
  let polls = 0;
  Object.assign(r, {
    _executionEpoch: {}, _turnSettled: false, _pendingCompletePayload: { code: 0 }, collectedOutput: "answer",
    _getSessionStatus: () => ["status", "replacement"].includes(boundary) ? new Promise(resolve => { release = resolve; }) : Promise.resolve(boundary === "unknown" ? "unknown" : "idle"),
    _syncFinalOutputFromOfficialHistory: p => boundary === "history" ? new Promise(resolve => { release = () => resolve(p); }) : Promise.resolve(p),
    _replayEmptyCompletionIfSafe: () => boundary === "replay" ? new Promise(resolve => { release = () => resolve(false); }) : Promise.resolve(false),
    _scheduleCompleteTurn: () => { polls++; }, _completeTurn: () => { completed++; },
  });
  const pending = r._confirmIdleAndComplete();
  await flush();
  if (release) {
    if (boundary !== "replacement") r._executionEpoch = {};
    r._pendingCompletePayload = { code: 0 };
    release("idle");
  }
  await pending;
  assert.equal(completed, boundary === "success" ? 1 : 0, boundary);
  assert.equal(polls, boundary === "unknown" ? 1 : 0);
}

for (const change of ["epoch", "server", "question"]) {
  let release;
  let scheduled = 0;
  const r = Object.create(OpencodeAgentSession.prototype);
  Object.assign(r, { busy: true, _turnSettled: false, _executionEpoch: {}, _server: {},
    _pendingPermissions: new Map(), _pendingQuestions: new Map(), collectedOutput: "partial",
    _getSessionStatus: () => new Promise(resolve => { release = resolve; }),
    _armIdleProbe: () => {}, _scheduleCompleteTurn: () => { scheduled++; } });
  const pending = r._probeOfficialIdleAndComplete();
  if (change === "epoch") r._executionEpoch = {};
  if (change === "server") r._server = {};
  if (change === "question") r._pendingQuestions.set("q", {});
  release("idle"); await pending;
  assert.equal(scheduled, 0, `idle probe: ${change}`);
}

const user = { info: { id: "u", role: "user", time: { created: 101 } }, parts: [{ type: "text", text: "report" }] };
const old = { info: { id: "a", parentID: "u", role: "assistant", time: { created: 102, completed: 103 } }, parts: [{ type: "text", text: "Preparing report" }] };
for (const terminal of [
  { error: { name: "APIError", data: { message: "provider failed" } } },
  { finish: "tool-calls" },
  {},
]) {
  const newest = { info: { id: "b", parentID: "u", role: "assistant", time: { created: 104, completed: 105 }, ...terminal }, parts: [] };
  const recovery = createOpencodeHistoryRecovery({ getTurnStartedAt: () => 100, getSessionStatus: async () => "idle",
    getServer: () => ({ lastPromptText: "report", messages: async () => [user, old, newest] }) });
  assert.equal(await recovery.recoverStalledFinal(), null);
  const result = await recovery.syncFinalOutput({ code: 0, output: "Preparing report" });
  assert.equal(result.engineMessageId, "b");
  if (terminal.error) { assert.equal(result.code, 1); assert.equal(result.error, "provider failed"); }
  else assert.equal(result.stalled, true);
}

{
  let release;
  let epoch = {};
  let emitted = 0;
  const recovery = createOpencodeHistoryRecovery({ captureScope: () => { const saved = epoch; return () => saved === epoch; },
    getTurnStartedAt: () => 100, getServer: () => ({ lastPromptText: "report", messages: () => new Promise(resolve => { release = resolve; }) }),
    onSupplementalOutput: () => { emitted++; } });
  const payload = { output: "" };
  const pending = recovery.syncFinalOutput(payload);
  epoch = {};
  release([user, old]);
  assert.equal(await pending, payload);
  assert.equal(emitted, 0, "stale history cannot publish output");
}

{
  let release;
  let server = { checkHealth: () => new Promise(resolve => { release = resolve; }) };
  const timers = new Set();
  const liveness = createOpencodeTurnLiveness({ getState: () => ({ busy: true }), getServer: () => server,
    getConfig: () => ({ healthProbeMs: 30, healthMaxFails: 3 }),
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn),
    onServerError: () => assert.fail("old health result must not fail a new execution") });
  liveness.armHealthProbe();
  const tick = [...timers][0]; timers.delete(tick);
  const pending = tick();
  liveness.clearHealthProbe(); server = { checkHealth: async () => true };
  liveness.armHealthProbe(); release(false); await pending;
  assert.equal(timers.size, 1, "only the new probe loop survives");
  liveness.clearHealthProbe();
}
console.log("opencode-terminal-ownership: ok");
