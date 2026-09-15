#!/usr/bin/env node
// Continuation lane truthfulness (2026-09-15 audit, gaps G1/G2/G3/G8):
//  - the recovery lane's events are legal runtime events and survive the source
//    turn's terminal (before: dropped in-process, thrown after a restart → the
//    restart lane never dispatched while still consuming its claim);
//  - a stopped or refused continuation of a cut-off task leaves a DURABLE
//    assistant record in the conversation, idempotent per reason;
//  - the renderer commits that record into the transcript;
//  - the parent-closure lane demands real progress per round (floor 3), while
//    the process-job wake lane keeps its one-key-per-batch baseline;
//  - the step-budget copy only promises a continuation when the gate agreed.
// [gate: task-completion-integrity]
// Run: node scripts/test-parent-closure-notice.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const { commitParentClosureNotice, describeParentClosureStop } = require("../src/main/parent-closure-notice.js");
const { createTurnRecoveryRuntime } = require("../src/main/turn-recovery-runtime.js");
const { minProgressPerRound, MAX_ROUNDS } = require("../src/main/store/task-continuation-budget.js");
const rendererStore = await import("../src/renderer/modules/session-runtime-store.js");

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

function fakeManager() {
  const messages = new Map();
  return {
    messages,
    findMessage: (_s, id) => messages.get(id) || null,
    pushMessageTo: (_s, role, content, _files, extra) => { messages.set(extra.id, { id: extra.id, role, content, turnId: extra.turnId, meta: extra.meta }); },
  };
}

await check("recovery-lane events are accepted after the source turn ended and by a fresh bus (restart)", async () => {
  const bus = new RuntimeEventBus(() => null);
  bus.emit("s", { type: "turn.started", turnId: "t1", payload: {} });
  bus.emit("s", { type: "turn.stalled", turnId: "t1", payload: {} });
  const live = bus.emit("s", { type: "turn.parent_closure_recovery", turnId: "t1", payload: { phase: "started" } });
  assert.equal(live.length, 1, "in-process: not dropped as post-terminal noise");
  const fresh = new RuntimeEventBus(() => null);
  const afterRestart = fresh.emit("s", { type: "turn.parent_closure_recovery", turnId: "t1", payload: { phase: "started" } });
  assert.equal(afterRestart.length, 1, "after a restart: a legal type, no throw");
  assert.equal(fresh.emit("s", { type: "turn.model_recovery", turnId: "t1", payload: { phase: "waiting" } }).length, 1);
  const contract = JSON.parse(fs.readFileSync(new URL("../src/shared/runtime-contract.json", import.meta.url), "utf8"));
  assert.ok(contract.eventTypes.includes("turn.parent_closure_recovery") && contract.eventTypes.includes("turn.model_recovery"));
});

await check("a durable stop record is written once per (session, source turn, reason) and mirrored as a committed message event", async () => {
  const manager = fakeManager();
  const events = [];
  const ctx = { sessionManager: manager, eventBus: { emit: (sid, event) => events.push({ sid, ...event }) } };
  const first = commitParentClosureNotice(ctx, "s1", { sourceTurnId: "turn-src", reason: "TASK_CONTINUATION_BUDGET_EXHAUSTED" });
  assert.equal(first.ok, true);
  assert.match(first.message.content, new RegExp(`${MAX_ROUNDS} 次自动接续上限`));
  assert.match(first.message.content, /发送「继续」/);
  assert.equal(first.message.meta.taskContinuation.status, "stopped");
  assert.notEqual(first.message.turnId, "turn-src", "never masquerades as the source turn");
  const again = commitParentClosureNotice(ctx, "s1", { sourceTurnId: "turn-src", reason: "TASK_CONTINUATION_BUDGET_EXHAUSTED" });
  assert.equal(manager.messages.size, 1, "idempotent");
  assert.equal(again.message.id, first.message.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "engine.warning");
  assert.equal(events[0].source, "parent_closure_recovery");
  assert.equal(events[0].payload.notice.code, "parentClosureStopped");
  assert.equal(events[0].payload.committedMessage.id, first.message.id);
  commitParentClosureNotice(ctx, "s1", { sourceTurnId: "turn-src", reason: "NO_EXECUTION_EVIDENCE" });
  assert.equal(manager.messages.size, 2, "a different reason is a different record");
  assert.equal([...manager.messages.values()][1].meta.taskContinuation.status, "not_started");
  assert.equal(commitParentClosureNotice(ctx, "s1", { sourceTurnId: "turn-src", reason: "WAITING_FOR_USER" }).skipped, "not_applicable");
  assert.equal(describeParentClosureStop("TASK_CONTINUATION_NO_PROGRESS").detail.includes(`${minProgressPerRound()} 条`), true);
  assert.equal(commitParentClosureNotice({}, "s1", { sourceTurnId: "x", reason: "TASK_CONTINUATION_DEADLINE" }).ok, false, "no manager → reported, never thrown");
  process.env.LILY_CLOSURE_NOTICE = "0";
  assert.equal(commitParentClosureNotice(ctx, "s1", { sourceTurnId: "z", reason: "TASK_CONTINUATION_DEADLINE" }).skipped, "disabled");
  delete process.env.LILY_CLOSURE_NOTICE;
});

await check("the renderer commits stopped / not_started records into the transcript and flags attention", async () => {
  const message = { id: "msg_closure_x", role: "assistant", content: "自动接续已停止", meta: { taskContinuation: { status: "stopped", reason: "TASK_CONTINUATION_BUDGET_EXHAUSTED" } } };
  rendererStore.applyRuntimeEvent({ sessionId: "r1", seq: 1, type: "engine.warning", source: "parent_closure_recovery", turnId: null,
    payload: { notice: { code: "parentClosureStopped" }, committedMessage: message } });
  const runtime = rendererStore.getRuntimeSession("r1");
  assert.ok(runtime.committedMessages.some((m) => m.id === "msg_closure_x"));
  assert.equal(runtime.attention, "failed");
  rendererStore.applyRuntimeEvent({ sessionId: "r1", seq: 2, type: "engine.warning", source: "long_task_supervisor", turnId: null,
    payload: { notice: { code: "taskContinuationPaused" }, committedMessage: { ...message, id: "msg_pause", meta: { taskContinuation: { status: "paused" } } } } });
  assert.ok(rendererStore.getRuntimeSession("r1").committedMessages.some((m) => m.id === "msg_pause"), "the process-job lane keeps working");
});

await check("recovery runtime: a refused cut-off task and an exhausted budget both leave the durable record", async () => {
  const manager = fakeManager();
  manager.reserveTaskContinuation = () => ({ ok: false, reason: "TASK_CONTINUATION_BUDGET_EXHAUSTED" });
  const events = [];
  const runtime = createTurnRecoveryRuntime({
    ctx: { sessionManager: manager, eventBus: { emit: (sid, e) => events.push(e) } },
    sendUserMessage: async () => { throw new Error("must not send"); },
  });
  const base = { objective: "导出镜像并校验", state: { turnId: "src-1", enginePayload: { rawText: "导出镜像并校验" },
    tools: new Map([["a", { id: "a", name: "bash", status: "done" }]]), pendingPermissions: new Map(), pendingQuestions: new Map(), pendingHooks: new Map() } };
  // 1) stalled research turn with one tool receipt → NON_EXECUTION_TASK → durable "未自动接续"
  await runtime.maybeParentClosureRecovery("s", { ...base, taskContract: { active: true, taskType: "general", categories: [] }, payload: { stalled: true } });
  let records = [...manager.messages.values()];
  assert.equal(records.length, 1);
  assert.match(records[0].content, /未自动接续/);
  assert.equal(records[0].meta.taskContinuation.reason, "NON_EXECUTION_TASK");
  // A turn that ALREADY explained itself must not get a second, contradicting
  // card: a classified failure, a silent model (whose own copy promises Lily
  // will continue once it recovers), and a handoff/step-budget stop all carry
  // their own message. Seen 3× in production on 2026-09-15.
  const silentish = [
    { failed: true, errorCode: "AUTH_FAILED" },
    { failed: true, errorCode: "MODEL_NO_RESPONSE" },
    { noFirstResponse: true },
    { stalled: true, stepBudgetExhausted: { count: 160, budget: 160 } },
    { code: 0, continuationHandoff: { schemaVersion: 1, reason: "budget_exhausted", progress: 2, unfinished: [] } },
  ];
  for (const [index, payload] of silentish.entries()) {
    await runtime.maybeParentClosureRecovery("s", { ...base, state: { ...base.state, turnId: `src-quiet-${index}` }, taskContract: { active: true, taskType: "general", categories: [] }, payload });
  }
  assert.equal(manager.messages.size, 1, "no second card on a turn that already said why it stopped");
  // 2) eligible code task, but the shared budget is spent → durable "已停止"
  const result = await runtime.maybeParentClosureRecovery("s", { ...base, state: { ...base.state, turnId: "src-3" }, taskContract: { active: true, taskType: "code_change", categories: [] }, payload: { stalled: true } });
  assert.equal(result.reason, "TASK_CONTINUATION_BUDGET_EXHAUSTED");
  records = [...manager.messages.values()];
  assert.equal(records.length, 2);
  assert.match(records[1].content, /自动接续已停止/);
  assert.equal(records[1].meta.taskContinuation.sourceTurnId, "src-3");
});

await check("the parent-closure lane asks the shared budget for a progress floor; the wake lane does not", async () => {
  const runtime = fs.readFileSync(new URL("../src/main/parent-closure-recovery-runtime.js", import.meta.url), "utf8");
  assert.match(runtime, /minProgress: require\("\.\/store\/task-continuation-budget"\)\.minProgressPerRound\(\)/);
  const wrapper = fs.readFileSync(new URL("../src/main/session-parent-closure-recovery.js", import.meta.url), "utf8");
  assert.match(wrapper, /minProgress: input\.minProgress/);
  const wake = fs.readFileSync(new URL("../src/main/long-task/session-wakeup.js", import.meta.url), "utf8");
  assert.doesNotMatch(wake, /minProgress/);
  assert.equal(minProgressPerRound(), 3);
  process.env.LILY_CONTINUATION_MIN_PROGRESS = "5";
  assert.equal(minProgressPerRound(), 5);
  delete process.env.LILY_CONTINUATION_MIN_PROGRESS;
});

await check("step-budget copy is chosen by the gate's answer; acceptance-gap re-dispatch is opt-in", async () => {
  const orchestrator = fs.readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
  assert.match(orchestrator, /const closurePrepared = failed \|\| stalled \|\| blockingProcessJobs\.length \? this\.turnRecoveryRuntime\.prepareParentClosureRecovery\(sessionId, parentClosureSource\) : null;/);
  // `ok:true, prepared:false` is the fail-open answer when preparation could not
  // run at all, so only `prepared` may promise a continuation.
  assert.ok(orchestrator.includes("closurePrepared?.prepared ? stepBudget.notice : stepBudget.noticeIneligible"),
    "the stall text must key off prepared, not ok");
  assert.ok(!orchestrator.includes("closurePrepared?.ok ?"), "ok:true also covers the fail-open no-op paths");
  const { evaluateStepBudget } = require("../src/main/turn-step-budget.js");
  const result = evaluateStepBudget({ stepCount: 160, enginePayload: { rawText: "x" } }, {}, { budget: 160 });
  assert.match(result.notice, /会自动接续一次/);
  assert.match(result.noticeIneligible, /不满足自动接续条件/);
  assert.doesNotMatch(result.noticeIneligible, /会自动接续/);
  const acceptance = fs.readFileSync(new URL("../src/main/turn-acceptance-recovery.js", import.meta.url), "utf8");
  assert.match(acceptance, /process\.env\.LILY_ACCEPTANCE_GAP_CONTINUATION === "1"/);
});

await check("the stop record speaks the user's language and only names a real kind", async () => {
  const { describeParentClosureStop } = require("../src/main/parent-closure-notice.js");
  for (const locale of ["zh-CN", "en", "ar"]) {
    const described = describeParentClosureStop("TASK_CONTINUATION_BUDGET_EXHAUSTED", {}, locale);
    assert.ok(described.detail.length > 8, locale);
    assert.equal(described.status, "stopped");
  }
  assert.notEqual(describeParentClosureStop("TASK_CONTINUATION_DEADLINE", {}, "en").detail,
    describeParentClosureStop("TASK_CONTINUATION_DEADLINE", {}, "zh-CN").detail, "en is not the zh string");
  assert.equal(describeParentClosureStop("NOT_A_REASON", {}, "en"), null);
  const { commitAgentBindingNotice } = require("../src/main/agents/agent-binding-notice.js");
  const inert = { sessionManager: { findMessage: () => null, pushMessageTo: () => {} } };
  for (const kind of ["brings", "role", "autonomyLabels", "keeps"]) {
    assert.equal(commitAgentBindingNotice(inert, "s", { kind, agent: { name: "X" }, bindingVersion: 1 }).skipped,
      "not_applicable", `${kind} is a copy label, not a binding kind`);
  }
});

console.log(`\n${checks} checks passed (parent closure notice)`);
