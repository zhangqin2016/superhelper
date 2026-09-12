import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createParentClosureRecoveryRuntime } = require("../src/main/parent-closure-recovery-runtime");
const { shouldRecoverParentClosure } = require("../src/main/parent-task-closure");
const { createTurnDispatchMethods } = require("../src/main/turn-dispatch-runtime");
const key = "a".repeat(64);
const source = {
  objective: "Finish every original record", taskCore: { fingerprint: "original" },
  taskContract: { active: true, taskType: "code_change" },
  state: { turnId: "source", currentPayload: { parentClosureRecovery: true },
    tools: new Map([["t", { name: "read", status: "done" }]]) },
  payload: { stalled: true, executionProgressKeys: [key] },
};
assert.equal(shouldRecoverParentClosure({ sessionId: "s", ...source }).ok, false);
assert.equal(shouldRecoverParentClosure({ sessionId: "s", ...source, allowProductiveContinuation: true }).ok, true);
assert.equal(shouldRecoverParentClosure({ sessionId: "s", ...source, allowProductiveContinuation: true,
  payload: { ...source.payload, continuationStopReason: "no_progress" } }).ok, false);

async function run(reserve) {
  const events = [], calls = [];
  const manager = {
    claimParentClosureRecovery: () => ({ ok: true, claimToken: "claim", recovery: { recoveryTurnId: "next" } }),
    reserveTaskContinuation: (sid, input) => { calls.push(["reserve", sid, input]); return reserve(); },
    markParentClosureRecoveryUnavailable: (_, input) => calls.push(["unavailable", input]),
    markParentClosureRecoveryDispatched: () => ({ ok: true }),
  };
  const runtime = createParentClosureRecoveryRuntime({ ctx: { sessionManager: manager },
    emit: (...args) => events.push(args),
    sendUserMessage: async (...args) => { calls.push(["send", ...args]); return { ok: true }; },
  });
  const result = await runtime.maybeParentClosureRecovery("s", source);
  runtime.dispose?.();
  return { result, calls, events };
}
const allowed = await run(() => ({ ok: true, rounds: 2 }));
assert.equal(allowed.result.ok, true);
assert.deepEqual(allowed.calls.map(call => call[0]), ["reserve", "send"]);
assert.deepEqual(allowed.calls[0][2].progressKeys, [key]);
assert.equal(allowed.calls[1][2], source.objective);
assert.deepEqual(allowed.calls[1][4].sourceTaskCore, source.taskCore);
const denied = await run(() => ({ ok: false, reason: "TASK_CONTINUATION_NO_PROGRESS" }));
assert.equal(denied.result.ok, false);
assert.equal(denied.calls.some(call => call[0] === "send"), false);
assert.equal(denied.calls.at(-1)[0], "unavailable");
const broken = await run(() => { throw new Error("injected database failure"); });
assert.equal(broken.result.ok, false);
assert.equal(broken.calls.some(call => call[0] === "send"), false);
let dispatchClaims = 0;
const dispatch = createTurnDispatchMethods({ log: console });
const stoppedContext = { ctx: { sessionManager: {
  validateTaskContinuation: () => ({ ok: false, reason: "TASK_CONTINUATION_CANCELLED" }),
  claimTurnInputDispatch: () => { dispatchClaims++; return { ok: true }; },
} } };
const stopped = dispatch._claimTurnDispatch.call(stoppedContext, { id: "s" }, { turnId: "next", ownerScope: "o" });
assert.equal(stopped.ok, false, "queued continuation rechecks cancellation immediately before dispatch");
assert.equal(dispatchClaims, 0);
console.log("task-continuation-dispatch: ok");
