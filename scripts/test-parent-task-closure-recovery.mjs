#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildParentClosurePrompt,
  createParentClosureLedger,
  shouldRecoverParentClosure,
  toolEvidenceSnapshot,
} from "../src/main/parent-task-closure.js";
import { createTurnRecoveryRuntime } from "../src/main/turn-recovery-runtime.js";

const executionContract = {
  active: true,
  taskType: "code_change",
  categories: ["code", "bugfix"],
  semanticIntent: { operation: "change" },
  intentContract: { objective: "把安装流程补完整" },
};

const state = {
  turnId: "turn_parent_1",
  assistantText: "先检查了构建脚本，但还没有完成修改。",
  enginePayload: { rawText: "把 macOS 安装包的 OpenConnect 集成完整并打包验证" },
  tools: new Map([
    ["t1", { id: "t1", name: "read", status: "done", input: { path: "Sources/Model.swift" } }],
    ["t2", { id: "t2", name: "bash", status: "done", input: { command: "swiftc ..." } }],
  ]),
  pendingPermissions: new Map(),
  pendingQuestions: new Map(),
  pendingHooks: new Map(),
};

const evidence = toolEvidenceSnapshot(state);
assert.deepEqual(
  { done: evidence.done.length, failed: evidence.failed.length, running: evidence.running.length },
  { done: 2, failed: 0, running: 0 },
  "tool evidence is compact and classified",
);

const eligible = shouldRecoverParentClosure({
  sessionId: "session_1",
  taskContract: executionContract,
  state,
  payload: { stalled: true },
});
assert.equal(eligible.ok, true, "an incomplete execution task with tool results is recoverable");
assert.equal(eligible.recoveryKey, "parent-closure:session_1:turn_parent_1");

const prompt = buildParentClosurePrompt({
  objective: state.enginePayload.rawText,
  evidence,
});
assert.match(prompt, /OpenConnect/);
assert.match(prompt, /继续完成/);
assert.match(prompt, /不要只返回计划/);
assert.match(prompt, /验证/);

assert.equal(
  shouldRecoverParentClosure({
    sessionId: "session_1",
    taskContract: { active: false, taskType: "general", categories: [] },
    state,
    payload: { stalled: true },
  }).ok,
  false,
  "ordinary chat is never auto-resumed",
);
assert.equal(
  shouldRecoverParentClosure({
    sessionId: "session_1",
    taskContract: executionContract,
    state: { ...state, tools: new Map() },
    payload: { stalled: true },
  }).ok,
  false,
  "a task with no execution evidence is not guessed into a retry",
);
assert.equal(
  shouldRecoverParentClosure({
    sessionId: "session_1",
    taskContract: executionContract,
    state,
    payload: { stalled: true, interruptedByUser: true },
  }).ok,
  false,
  "explicit user interruption wins over automation",
);
assert.equal(
  shouldRecoverParentClosure({
    sessionId: "session_1",
    taskContract: executionContract,
    state: { ...state, pendingPermissions: new Map([["p1", {}]]) },
    payload: { stalled: true },
  }).ok,
  false,
  "a pending permission belongs to the user, not the recovery loop",
);

const ledger = createParentClosureLedger();
assert.equal(ledger.claim(eligible.recoveryKey), true, "first recovery claim succeeds");
assert.equal(ledger.claim(eligible.recoveryKey), false, "duplicate recovery claim is rejected");
assert.equal(ledger.has(eligible.recoveryKey), true);
ledger.clear(eligible.recoveryKey);
assert.equal(ledger.claim(eligible.recoveryKey), true, "dispatch failure can release an unconsumed claim");

const sent = [];
const emitted = [];
const runtime = createTurnRecoveryRuntime({
  ctx: {},
  emit: (_sessionId, type, payload) => emitted.push({ type, payload }),
  sendUserMessage: async (...args) => {
    sent.push(args);
    return { ok: true, turnId: "turn_parent_recovery" };
  },
});
const recovered = await runtime.maybeParentClosureRecovery("session_1", {
  taskContract: executionContract,
  taskCore: { contract: { intentContract: executionContract.intentContract } },
  objective: state.enginePayload.rawText,
  files: [{ path: "Sources/Model.swift" }],
  state,
  payload: { stalled: true },
});
assert.equal(recovered.ok, true, "eligible parent task is internally resumed");
assert.equal(sent.length, 1);
assert.equal(sent[0][0], "session_1");
assert.equal(sent[0][1], state.enginePayload.rawText, "original objective is reused as the hidden user turn");
assert.equal(sent[0][3].recordUser, false);
assert.equal(sent[0][3].recovery.kind, "parent_task_closure");
assert.equal(sent[0][3].sourceTurnId, "turn_parent_1");
assert.equal(sent[0][3].recovery.kind, "parent_task_closure");
assert.equal(emitted.at(-1).payload.phase, "dispatched");
const duplicate = await runtime.maybeParentClosureRecovery("session_1", {
  taskContract: executionContract,
  objective: state.enginePayload.rawText,
  state,
  payload: { stalled: true },
});
assert.equal(duplicate.attempted, false, "duplicate engine terminal cannot dispatch a second continuation");
assert.equal(sent.length, 1);

const durableCalls = { prepared: 0, claimed: 0, dispatched: 0 };
const durableManager = {
  prepareParentClosureRecovery(_sessionId, input) {
    durableCalls.prepared += 1;
    return {
      ok: true,
      recovery: {
        sourceTurnId: input.sourceTurnId,
        recoveryKey: input.recoveryKey,
        recoveryTurnId: "turn_parent_closure_durable",
        status: "prepared",
        source: input.source,
      },
    };
  },
  claimParentClosureRecovery() {
    durableCalls.claimed += 1;
    return {
      ok: true,
      claimToken: "claim-token",
      recovery: {
        recoveryTurnId: "turn_parent_closure_durable",
        status: "claimed",
      },
    };
  },
  getTurnInputByTurnId() {
    return null;
  },
  markParentClosureRecoveryDispatched(_sessionId, input) {
    durableCalls.dispatched += 1;
    assert.equal(input.recoveryTurnId, "turn_parent_closure_durable");
    assert.equal(input.claimToken, "claim-token");
    return { ok: true };
  },
};
const durableSent = [];
const durableRuntime = createTurnRecoveryRuntime({
  ctx: { sessionManager: durableManager },
  emit: () => {},
  sendUserMessage: async (...args) => {
    durableSent.push(args);
    return { ok: true, turnId: "turn_parent_closure_durable" };
  },
});
const durableSource = {
  taskContract: executionContract,
  taskCore: { fingerprint: "sha256:source" },
  objective: "持久化续跑",
  files: [],
  state,
  payload: { stalled: true },
};
assert.equal(durableRuntime.prepareParentClosureRecovery("session_1", durableSource).prepared, true);
const durableRecovered = await durableRuntime.maybeParentClosureRecovery("session_1", durableSource);
assert.equal(durableRecovered.ok, true);
assert.equal(durableCalls.prepared, 1);
assert.equal(durableCalls.claimed, 1);
assert.equal(durableCalls.dispatched, 1);
assert.equal(durableSent[0][3].turnId, "turn_parent_closure_durable");

console.log("parent-task-closure-recovery: all assertions passed");
