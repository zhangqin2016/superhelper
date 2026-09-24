#!/usr/bin/env node
/**
 * A slow model is not a failing model, and an audit does not hold the answer.
 *
 * Measured 2026-09-24: the company gateway writes about 18 tokens a second
 * (471 replies). The objective-coverage audit writes a verdict with verbatim
 * quotes — a minute of output — and it sat in front of the answer behind a
 * fixed 10s deadline: every task turn waited for it, and 164 of the 165
 * verdicts ever recorded were "unavailable". A deadline measured the model's
 * speed and called it a fault; the wait bought nothing.
 *
 * Now: the reply is judged by liveness (still arriving = alive), and the turn
 * completes without the verdict, which amends the conclusion when it lands.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
console.info = () => {};
const warn = console.warn;
console.warn = () => {};

const { readModelStream, liveness } = require("../src/main/model-stream-reader.js");

// A streaming Response whose chunks arrive on a schedule.
function scheduledStream(frames) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    async start(controller) {
      for (const [delayMs, text] of frames) {
        await sleep(delayMs);
        if (cancelled) return;
        controller.enqueue(encoder.encode(text));
      }
      if (!cancelled) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const chat = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

// ------------------------------------------------------------ liveness, not speed
{
  // 40 tokens, one every 25ms: a whole second, far past a 300ms "deadline",
  // but never silent for longer than the stall bound.
  const frames = Array.from({ length: 40 }, (_, i) => [25, chat(`t${i} `)]);
  frames.push([5, "data: [DONE]\n\n"]);
  const read = await readModelStream(scheduledStream(frames), { firstOutputMs: 300, stallMs: 300 });
  assert.equal(read.ok, true, "a slow reply that keeps arriving is accepted");
  assert.ok(read.totalMs >= 900, `it took ${read.totalMs}ms — longer than any fixed bound the audit ever had, scaled`);
  assert.match(read.text, /^t0 t1 .* t39 $/);
  check("a reply judged by liveness is accepted however long it takes while it keeps arriving");
}

{
  const read = await readModelStream(scheduledStream([[10, chat("partial ")], [2_000, chat("late")]]), { firstOutputMs: 500, stallMs: 150 });
  assert.equal(read.ok, false);
  assert.match(read.reason, /^stalled_150ms_after_8_chars$/, "a reply that stops is named as stalled, with how far it got");
  check("a reply that stops producing is a stall, reported with how much arrived");
}

{
  const read = await readModelStream(scheduledStream([[400, chat("too late")]]), { firstOutputMs: 120, stallMs: 100 });
  assert.equal(read.ok, false);
  assert.match(read.reason, /^no_output_within_120ms$/);
  const keepalive = await readModelStream(scheduledStream([[20, ": ping\n\n"], [20, ": ping\n\n"], [400, chat("x")]]), { firstOutputMs: 120, stallMs: 100 });
  assert.match(keepalive.reason, /no_output_within/, "SSE keep-alive comments are not the model producing anything");
  // Once output has begun, a gateway that only pings has still stopped.
  const pingsAfterOutput = await readModelStream(scheduledStream([[10, chat("partial")], ...Array.from({ length: 8 }, () => [60, ": ping\n\n"]), [60, chat("late")]]), { firstOutputMs: 500, stallMs: 150 });
  assert.match(pingsAfterOutput.reason, /^stalled_150ms/, "keep-alives do not mask a stalled model");
  const startedEarlier = await readModelStream(scheduledStream([[80, chat("x")]]), { firstOutputMs: 120, stallMs: 100, startedAt: Date.now() - 100 });
  assert.match(startedEarlier.reason, /no_output_within/, "time spent waiting for headers counts against the first-output window");
  check("no first output, keep-alives and header waits are all bounded by the first-output window");
}

{
  const responses = await readModelStream(scheduledStream([
    [5, `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "{\"a\":" })}\n\n`],
    [5, `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "1}" })}\n\n`],
    [5, `data: ${JSON.stringify({ type: "response.completed" })}\n\n`],
  ]), { firstOutputMs: 500, stallMs: 500 });
  assert.equal(responses.text, "{\"a\":1}", "Responses-surface events");
  const reasoning = await readModelStream(scheduledStream([
    [5, `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think " } }] })}\n\n`],
    [5, `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] })}\n\n`],
  ]), { firstOutputMs: 500, stallMs: 500 });
  assert.deepEqual([reasoning.text, reasoning.reasoning], ["answer", "think "], "reasoning is liveness too");
  check("chat chunks and Responses events both read, text and reasoning apart");
}

{
  assert.deepEqual(liveness({}), { firstOutputMs: 120_000, stallMs: 60_000 });
  assert.deepEqual(liveness({ LILY_MODEL_STALL_MS: "180000" }), { firstOutputMs: 180_000, stallMs: 180_000 }, "first output is never tighter than a stall");
  check("the liveness bounds are configurable and consistent");
}

// ------------------------------------------------------ the judge in liveness mode
{
  const judge = require("../src/main/evidence-entailment-judge.js");
  const realFetch = globalThis.fetch;
  const frames = Array.from({ length: 12 }, (_, i) => [20, chat(i === 0 ? "{\"ok\":" : i === 11 ? "true}" : " ")]);
  frames.push([5, "data: [DONE]\n\n"]);
  let sentBody = null;
  globalThis.fetch = async (_url, init) => { sentBody = JSON.parse(init.body); return scheduledStream(frames); };
  try {
    const diagnostics = {};
    const raw = await judge.postJudgeChat({
      connection: { baseUrl: "https://gw.example/v1", apiKey: "k", model: "m", protocol: "openai" },
      prompt: "p", diagnostics, liveness: { firstOutputMs: 200, stallMs: 200 },
    });
    assert.equal(sentBody.stream, true, "the judge streams in liveness mode");
    assert.equal(JSON.parse(raw).ok, true);
    assert.ok(diagnostics.totalMs >= 200, "and reports how long the model really took");

    globalThis.fetch = async () => new Response("nope", { status: 502 });
    const failed = {};
    assert.equal(await judge.postJudgeChat({ connection: { baseUrl: "https://gw.example/v1", apiKey: "k", model: "m" }, prompt: "p", diagnostics: failed, liveness: {} }), "");
    assert.equal(failed.reason, "http_502", "a refused request says so");

    globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const silent = {};
    await judge.postJudgeChat({ connection: { baseUrl: "https://gw.example/v1", apiKey: "k", model: "m" }, prompt: "p", diagnostics: silent, liveness: { firstOutputMs: 80, stallMs: 80 } });
    assert.equal(silent.reason, "no_output_within_80ms", "a gateway that never answers is bounded, and named");
  } finally { globalThis.fetch = realFetch; }
  check("the judge's liveness mode streams, accepts slow output, and names what went wrong");
}

// ----------------------------------------------- the answer is not held for the audit
const { MessageStore } = require("../src/main/store/message-store.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-after-delivery-"));
const store = new MessageStore(path.join(root, "messages.db"), path.join(root, "blobs"));
const ownerScope = "account:coverage";
const sessionManager = {
  record: null,
  amendTaskLifecycleVerification: (sessionId, input) => store.amendTaskLifecycleVerification({ ...input, sessionId, ownerScope }),
  getAssistantForTurnAsync: async (_sessionId, turnId) => (sessionManager.record?.turnId === turnId ? sessionManager.record : null),
  updateMessageRecordMeta: (_sessionId, id, updater) => {
    if (sessionManager.record?.id !== id) return null;
    sessionManager.record = { ...sessionManager.record, record: { ...sessionManager.record.record, meta: updater(sessionManager.record.record.meta || {}) } };
    return sessionManager.record;
  },
};
const events = [];
const ctx = { sessionManager, eventBus: { emit: (_sessionId, event) => events.push(event) } };

function lifecycleAt(turnId, status) {
  const identity = { sessionId: "s", ownerScope, taskId: `task-${turnId}`, turnId };
  store.ensureTaskLifecycle(identity);
  for (const next of ["running", "verifying", status]) {
    store.transitionTaskLifecycle({ ...identity, status: next, ...(next === status ? { verification: { status } } : {}) });
  }
  store.markTaskLifecycleDelivered({ ...identity, delivery: { archived: true } });
  return identity;
}

function turnState(turnId, baselineStatus) {
  const taskRun = { id: `task-${turnId}`, plan: [{ id: "execute", title: "Execute", status: "completed" }], evidence: [] };
  const amendment = require("../src/main/objective-coverage-amendment.js");
  amendment.rememberBaseline(taskRun, { status: baselineStatus, reason: "test_or_build_evidence" });
  // What delivery did: coverage pending, so a verified task is delivered as observed.
  const delivered = require("../src/main/task-original-acceptance.js").applyObjectiveCoverage({ status: baselineStatus, reason: "test_or_build_evidence" }, amendment.COVERAGE_PENDING);
  require("../src/main/task-run-state.js").completeTaskRun(taskRun, "turn.completed", delivered);
  sessionManager.record = { id: `msg-${turnId}`, turnId, record: { meta: { taskRun: { completionStatus: taskRun.completionStatus } } } };
  return { turnId, sessionId: "s", lifecycleTaskId: `task-${turnId}`, taskRun, tools: new Map([["t", { name: "bash" }]]) };
}

{
  const amendment = require("../src/main/objective-coverage-amendment.js");
  const identity = lifecycleAt("turn-ok", "observed");
  const state = turnState("turn-ok", "verified");
  assert.equal(state.taskRun.verification.status, "observed", "delivered while the audit had not answered: exactly the old unavailable-audit outcome");
  let release;
  const verdict = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const running = amendment.auditAfterDelivery({ ctx, sessionId: "s", state, assess: async ({ state: audited }) => { seen.push(audited.tools.size); return verdict; } });
  // The session moves on: the next turn reuses the state object.
  state.tools.clear(); state.turnId = "turn-next";
  await tick();
  assert.deepEqual(seen, [1], "the audit reads the turn it belongs to, not the state the next turn reused");
  release({ status: "complete", requirements: [{ title: "Build", status: "complete" }] });
  const result = await running;
  assert.deepEqual([result.amended, result.from, result.to], [true, "observed", "verified"]);
  const lifecycle = store.getTaskLifecycle("s", ownerScope, "turn-ok");
  assert.equal(lifecycle.status, "verified", "the lifecycle carries the verdict that landed");
  assert.equal(lifecycle.deliveryStatus, "delivered", "and delivery is untouched");
  assert.deepEqual([lifecycle.verification.amendment.by, lifecycle.verification.amendment.from], ["objective_coverage", "observed"], "with who amended it and from what");
  assert.equal(sessionManager.record.record.meta.taskRun.completionStatus, "verified_complete", "reopening the conversation shows it");
  assert.ok(events.some((event) => event.type === "task.lifecycle.updated" && event.payload.status === "verified"));
  assert.equal(identity.turnId, "turn-ok");
  check("a verdict that lands after delivery amends the lifecycle and the record, never the delivery");
}

{
  const amendment = require("../src/main/objective-coverage-amendment.js");
  lifecycleAt("turn-missing", "observed");
  const state = turnState("turn-missing", "verified");
  const result = await amendment.auditAfterDelivery({ ctx, sessionId: "s", state, assess: async () => ({ status: "missing", requirements: [{ title: "deliver REPORT.md", status: "missing" }] }) });
  assert.deepEqual([result.from, result.to], ["observed", "unverified"]);
  assert.equal(store.getTaskLifecycle("s", ownerScope, "turn-missing").verification.reason, "original_requirements_missing");

  lifecycleAt("turn-unknown", "observed");
  const unknownState = turnState("turn-unknown", "verified");
  const unknown = await amendment.auditAfterDelivery({ ctx, sessionId: "s", state: unknownState, assess: async () => ({ status: "unknown", reason: "judge_unavailable:stalled", requirements: [] }) });
  assert.equal(unknown.amended, false, "an audit that could not decide changes nothing — delivery already recorded that");
  assert.equal(store.getTaskLifecycle("s", ownerScope, "turn-unknown").status, "observed");

  lifecycleAt("turn-throws", "observed");
  const thrown = await amendment.auditAfterDelivery({ ctx, sessionId: "s", state: turnState("turn-throws", "verified"), assess: async () => { throw new Error("boom"); } });
  assert.equal(thrown.amended, false, "an audit that throws leaves the delivered verdict and cannot reject");
  check("missing requirements downgrade, unknown and failures leave the delivered verdict");
}

// ------------------------------------------------------------- the store's rule
{
  const identity = lifecycleAt("turn-store", "observed");
  const bad = store.amendTaskLifecycleVerification({ ...identity, fromStatus: "observed", verification: { status: "delivered" }, amendedBy: "x" });
  assert.equal(bad.reason, "INVALID_TASK_LIFECYCLE_AMENDMENT", "only a verdict can replace a verdict");
  const stale = store.amendTaskLifecycleVerification({ ...identity, fromStatus: "verified", verification: { status: "unverified" }, amendedBy: "x" });
  assert.equal(stale.reason, "TASK_LIFECYCLE_STATUS_CONFLICT", "amended against the status it was read at, or not at all");
  const anonymous = store.amendTaskLifecycleVerification({ ...identity, fromStatus: "observed", verification: { status: "verified" }, amendedBy: "" });
  assert.equal(anonymous.ok, false, "an amendment always names who made it");
  const failedIdentity = { sessionId: "s", ownerScope, taskId: "task-failed", turnId: "turn-failed" };
  store.ensureTaskLifecycle(failedIdentity);
  store.transitionTaskLifecycle({ ...failedIdentity, status: "failed" });
  assert.equal(store.amendTaskLifecycleVerification({ ...failedIdentity, fromStatus: "failed", verification: { status: "verified" }, amendedBy: "x" }).ok, false, "a failed task is never amended into a verified one");
  check("the store amends only verdict to verdict, optimistically, and always attributed");
}

// ------------------------------------------------- the finalizer no longer waits
{
  const { completeWithAcceptance } = require("../src/main/turn-acceptance-recovery.js");
  const completed = [];
  let auditStarted = false;
  delete process.env.LILY_ACCEPTANCE_GAP_CONTINUATION;
  const state = {
    turnId: "turn-fin",
    taskRun: { id: "task-fin", plan: [] },
    tools: new Map([["t", { name: "bash" }]]),
    taskContract: { active: true, taskType: "code_change" },
  };
  const result = completeWithAcceptance({
    ctx: {}, sessionId: "s", state, type: "turn.completed", payload: {},
    taskRunRuntime: { complete: (_sessionId, _type, options) => completed.push(options.objectiveCoverage) },
    assess: () => { auditStarted = true; return new Promise(() => {}); },
  });
  assert.equal(typeof result?.then, "undefined", "the finalizer is not handed a promise to wait on");
  assert.deepEqual(completed.map((coverage) => coverage.reason), ["audit_pending"], "the turn completes at once, coverage pending");
  await tick();
  assert.equal(auditStarted, true, "and the audit runs beside it");

  process.env.LILY_ACCEPTANCE_GAP_CONTINUATION = "1";
  const waiting = completeWithAcceptance({
    ctx: {}, sessionId: "s", state, type: "turn.completed", payload: {},
    taskRunRuntime: { complete() {} },
    assess: async () => ({ status: "complete", requirements: [] }),
  });
  assert.equal(typeof waiting?.then, "function", "acceptance-gap continuation, which decides from the verdict, still waits for it");
  await waiting;
  delete process.env.LILY_ACCEPTANCE_GAP_CONTINUATION;
  check("the answer is not held for the audit; only the opt-in continuation mode waits");
}

console.warn = warn;
console.log(`objective-coverage-after-delivery: ok (${checks} checks)`);
