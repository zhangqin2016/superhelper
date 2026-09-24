#!/usr/bin/env node
/**
 * A recovery turn is the platform's, not the user's — everywhere it is asked.
 *
 * Field case 2026-09-24: a model wrote a tool call as text 1,743 steps into a
 * task. The rescue continued the session with a correction the platform wrote;
 * the engine was then recycled for a gateway-token rotation, and the next
 * turn's resume check compared the user's "继续" with that correction, read a
 * mismatch, and discarded the 1,746-step engine session for a summary — while
 * the notice said "已在原会话中继续执行". The recovery that followed also took
 * the correction as the task's objective, and the failure copy told the user to
 * wait for a service that had never gone down.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyResumeContinuity } = require("../src/main/resume-continuity-guard.js");
const { applyInternalRecoveryLayer, initializeTurnEvidenceState } = require("../src/main/turn-recovery-context.js");
const { captureParentClosureSource } = require("../src/main/turn-parent-closure-runtime.js");
const { createTurnRecoveryRuntime } = require("../src/main/turn-recovery-runtime.js");
const rescue = require("../src/main/tool-call-rescue.js");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

// --------------------------------------- the rescue, as the field ran it
const sent = [];
const sessionManager = {
  findById: (id) => ({ id }),
  getTurnInputByTurnId: (sessionId, turnId) => ({ sessionId, turnId, userText: "继续" }),
  getLastUserMessage: () => ({ role: "user", content: "继续" }),
};
const failedTurn = { turnId: null, queue: [], wasRescueAttempt: false, tools: new Map([["call_1", { id: "call_1", name: "edit", status: "done", input: { filePath: "a.java" } }]]) };
const runtime = createTurnRecoveryRuntime({
  ctx: { sessionManager, runnerPool: { get: () => ({ isBusy: () => false }) } },
  transcriptStore: { removeLastAssistantMessage() {}, supersedeAssistantTurn: async () => ({ ok: true }) },
  getState: () => failedTurn,
  sendUserMessage: async (sessionId, content, files, opts) => { sent.push({ content, opts }); return { ok: true, turnId: "turn_rescue" }; },
  sleep: async () => {},
});
rescue.resetRescueStateForTests();
const info = console.info; console.info = () => {};
assert.equal(await runtime.maybeToolCallRescueRetry("s", { code: "MALFORMED_TOOL_CALL_TEXT", sourceTurnId: "turn_src" }), true);
console.info = info;
const { content: correction, opts } = sent[0];
assert.equal(opts.recovery.mode, "continuation", "a turn that already edited files is continued, not replayed");
assert.match(correction, /system correction|系统纠正/, "and what it sends is the platform's correction");
assert.equal(opts.recovery.objective, "继续", "while the user's own request travels with it");
check("a continuing rescue carries the user's request alongside the platform's correction");

// ----------------------------------------------- the resume check (field)
{
  const engineText = applyInternalRecoveryLayer(correction, opts.recovery);
  const local = [{ role: "user", content: "修复 identity 500" }, { role: "user", content: "继续" }];
  const verdict = classifyResumeContinuity({ localMessages: local, officialMessages: [{ role: "user", content: engineText }] });
  assert.equal(verdict.ok, true, "the correction is not read as the user's latest message, so the session keeps its resume");
  const mixed = classifyResumeContinuity({ localMessages: local, officialMessages: [{ role: "user", content: "继续" }, { role: "assistant", content: "…" }, { role: "user", content: engineText }] });
  assert.deepEqual([mixed.ok, mixed.reason], [true, "recent_user_overlap"], "the user's real messages still decide the comparison");
  check("the resume check does not mistake the platform's recovery turn for the user");
}

{
  // The guard still does its job.
  const foreign = classifyResumeContinuity({ localMessages: [{ role: "user", content: "继续" }], officialMessages: [{ role: "user", content: "帮我写一份季度销售报告" }] });
  assert.equal(foreign.ok, false, "a genuinely different history is still refused");
  const typed = classifyResumeContinuity({ localMessages: [{ role: "user", content: "继续" }], officialMessages: [{ role: "user", content: '<lily_internal_turn kind="x"> 帮我写一份季度销售报告' }] });
  assert.equal(typed.ok, false, "typing the marker as text does not hide a message — only the platform's layer does");
  check("a foreign history, or a user typing the marker, is still a mismatch");
}

// --------------------------------- the recovery that follows the rescue
{
  const state = { enginePayload: { rawText: correction }, currentPayload: { rawText: correction } };
  initializeTurnEvidenceState(state, opts.recovery);
  const source = captureParentClosureSource(state, { failed: true });
  assert.equal(source.objective, "继续", "a later recovery of the rescue turn works on the user's request");
  assert.equal(source.state.enginePayload.rawText, "继续");
  const plain = { enginePayload: { rawText: "修复 identity 500" } };
  initializeTurnEvidenceState(plain, null);
  assert.equal(captureParentClosureSource(plain, {}).objective, "修复 identity 500", "an ordinary turn is unchanged");
  check("the recovery after a rescue takes the user's request as its objective, not the correction");
}

// ---------------------------------------------------------- the copy
{
  const slip = runtime.rescueRetryNotice("s", true, "MALFORMED_TOOL_CALL_TEXT");
  assert.doesNotMatch(slip, /服务恢复/, "a model slip is not an outage");
  assert.match(slip, /继续/);
  assert.match(runtime.rescueRetryNotice("s", true, "MODEL_CONNECTION_FAILED"), /服务恢复后可随时继续/, "a connection failure still says so");
  assert.match(runtime.rescueRetryNotice("s", true, "EMPTY_ASSISTANT_COMPLETION"), /服务恢复后可随时继续/, "and so does a gateway that returned nothing");
  assert.equal(runtime.rescueRetryNotice("s", false, "MALFORMED_TOOL_CALL_TEXT"), "");
  check("a model slip is not told to wait for the service; service failures keep their wording");
}

console.log(`recovery-turn-provenance: ok (${checks} checks)`);
