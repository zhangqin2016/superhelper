#!/usr/bin/env node
// First-response watchdog: a model that returns ZERO bytes ends the turn fast
// (default 90s, env-tunable, 0 disables) as a retryable MODEL_NO_RESPONSE
// failure; the first progress action clears it; a pending user card or an
// active tool pauses it; the classifier + rescue table know the new code; the
// model picker marks the silent model. [gate: task-completion-integrity]
// Run: node scripts/test-first-response-watchdog.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpencodeTurnLiveness } = require("../src/main/opencode-turn-liveness.js");
const { classifyAssistantError } = require("../src/main/agent-runner.js");
const { rescueStrategyFor } = require("../src/main/tool-call-rescue.js");
const availability = require("../src/main/model-availability.js");
const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

// Deterministic timers.
function fakeTimers() {
  let now = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return { id, unref() {} }; },
    clearTimeout: (handle) => { if (handle?.id) timers.delete(handle.id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

function makeLiveness({ firstResponseTimeoutMs = 90_000, state = {}, activeTools = new Map(), compaction = { active: false }, retry = { nextAt: 0 } } = {}) {
  const timers = fakeTimers();
  const events = { noFirstResponse: [], completed: [], notices: [] };
  const shared = { busy: true, turnSettled: false, sawActivity: false, collectedOutput: "", pendingUserInput: false, ...state };
  const liveness = createOpencodeTurnLiveness({
    sessionId: "s-watchdog",
    activeTools,
    getState: () => shared,
    getConfig: () => ({ responseTimeoutMs: 600_000, firstResponseTimeoutMs, progressNoticeMs: 45_000, activeToolLeaseMs: 1_200_000 }),
    hasActiveCompaction: () => compaction.active === true,
    engineRetryNextAt: () => retry.nextAt,
    ingest: (drafts) => events.notices.push(...drafts),
    completeTurn: (payload) => events.completed.push(payload),
    onNoFirstResponse: (info) => events.noFirstResponse.push(info),
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { liveness, timers, events, shared, compaction, retry };
}

check("zero activity for the whole window fires onNoFirstResponse once, long before the 10-minute stall", () => {
  const { liveness, timers, events } = makeLiveness();
  liveness.armResponseTimer();
  assert.equal(liveness.diagnostics().firstResponse, true, "first-response timer armed with the no-progress timer");
  timers.advance(89_000);
  assert.equal(events.noFirstResponse.length, 0);
  timers.advance(1_000);
  assert.equal(events.noFirstResponse.length, 1);
  assert.equal(events.noFirstResponse[0].timeoutMs, 90_000);
  assert.equal(events.completed.length, 0, "the callback decides; the liveness module does not settle the turn itself");
  timers.advance(600_000);
  assert.equal(events.noFirstResponse.length, 1, "fires once");
});

// 2026-09-15 field case: a pre-turn compaction generates the handoff summary in
// this very session. It produces no TURN output, so the fuse read it as a dead
// model, killed the turn as MODEL_NO_RESPONSE *and* aborted the compaction — the
// user lost both, and the retry then showed the summary itself as the answer.
check("a compaction in flight extends the fuse instead of killing the turn", () => {
  const { liveness, timers, events, compaction } = makeLiveness({ compaction: { active: true } });
  liveness.armResponseTimer();
  timers.advance(90_000);
  assert.equal(events.noFirstResponse.length, 0, "compaction silence never ends the turn");
  timers.advance(500_000);
  assert.equal(events.noFirstResponse.length, 0, "and keeps extending while it runs");
  assert.equal(liveness.diagnostics().firstResponse, true, "the fuse stays armed, not disabled");

  // Once the summary lands the turn gets a FULL fresh window, then fires normally.
  compaction.active = false;
  timers.advance(89_000);
  assert.equal(events.noFirstResponse.length, 0, "a fresh full window after compaction");
  timers.advance(1_000);
  assert.equal(events.noFirstResponse.length, 1, "a genuinely silent model still ends the turn");
});

// 2026-09-28 integration audit: a provider that answers 429/5xx is not silent —
// the engine retries with backoff (or the provider's retry-after) and says when.
// The fuse used to read those minutes as a dead model, end the turn as
// MODEL_NO_RESPONSE and mark the model silent, steering auto mode away from it.
check("an engine retry moves the fuse to after the scheduled attempt; silence after it still ends the turn", () => {
  const { liveness, timers, events, retry } = makeLiveness();
  liveness.armResponseTimer();
  timers.advance(10_000);
  retry.nextAt = timers.now() + 180_000; // provider said retry-after: 180s
  timers.advance(80_000); // the ordinary 90s window is over
  assert.equal(events.noFirstResponse.length, 0, "a scheduled retry is not a silent model");
  timers.advance(189_000); // t=279s: the retry went out at t=190s, 89s of silence since
  assert.equal(events.noFirstResponse.length, 0, "the window is measured from the retry itself");
  timers.advance(1_000); // t=280s: a full window of silence after the retry
  assert.equal(events.noFirstResponse.length, 1, "silence for a full window AFTER the retry ends the turn");
});

// 2026-09-29 re-review: a retry scheduled farther away than the no-progress
// window (retry-after of hours for an exhausted quota) is an outage — the turn
// ends as before, so auto mode can fail over instead of waiting silently.
check("a retry scheduled beyond the no-progress window is an outage, not engine work", () => {
  const { liveness, timers, events, retry } = makeLiveness();
  liveness.armResponseTimer();
  timers.advance(10_000);
  retry.nextAt = timers.now() + 3_600_000; // retry-after: 1 hour
  timers.advance(80_000);
  assert.equal(events.noFirstResponse.length, 1, "the fuse fires on time instead of following a one-hour retry");
});

check("the reducer records the engine's scheduled retry and clears it on any other status", () => {
  const { createOpencodeRuntimeState, reduceOpencodeRuntimeEvent, engineRetryNextAt } = require("../src/main/runtime/opencode-runtime-reducer.js");
  const state = createOpencodeRuntimeState();
  reduceOpencodeRuntimeEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "retry", attempt: 2, message: "rate limited", next: 1_700_000_000_000 } } }, state);
  assert.equal(engineRetryNextAt(state), 1_700_000_000_000, "retry.next is kept");
  reduceOpencodeRuntimeEvent({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } }, state);
  assert.equal(engineRetryNextAt(state), 0, "a busy status clears it");
  const src = require("node:fs").readFileSync(new URL("../src/main/opencode-agent-session.js", import.meta.url), "utf8");
  assert.match(src, /engineRetryNextAt: \(\) => engineRetryNextAt\(this\._eventState\)/, "the session hands the retry schedule to the fuse");
});

// 2026-09-28 audit: the no-progress window must honour the same engine-busy
// evidence, and a tool's lease is at least the timeout it declared.
check("the no-progress window waits out an engine retry and a running compaction", () => {
  const timers = fakeTimers();
  const retry = { nextAt: 0 };
  const compaction = { active: false };
  let watchdogFired = 0;
  const liveness = createOpencodeTurnLiveness({
    sessionId: "s-no-progress",
    activeTools: new Map(),
    getState: () => ({ busy: true, turnSettled: false, sawActivity: true, collectedOutput: "x" }),
    getConfig: () => ({ responseTimeoutMs: 600_000, firstResponseTimeoutMs: 90_000, progressNoticeMs: 45_000, activeToolLeaseMs: 1_200_000 }),
    hasActiveCompaction: () => compaction.active,
    engineRetryNextAt: () => retry.nextAt,
    recoverStalledFinal: () => { watchdogFired += 1; return new Promise(() => {}); },
    now: timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  liveness.armResponseTimer();
  retry.nextAt = timers.now() + 900_000; // provider retry-after: 15 minutes
  timers.advance(600_000);
  assert.equal(watchdogFired, 0, "a scheduled retry past the window is not a stall");
  retry.nextAt = 0;
  compaction.active = true;
  timers.advance(900_000);
  assert.equal(watchdogFired, 0, "a running compaction is not a stall");
  compaction.active = false;
  timers.advance(1_600_000);
  assert.equal(watchdogFired, 1, "real silence after both still ends the turn");
});

check("a tool keeps its lease as long as the timeout it declared", () => {
  const activeTools = new Map([["build", { id: "build", name: "bash", input: { command: "make all", timeout: 1_800_000 }, startedAt: 1, lastActivityAt: 1 }]]);
  const { liveness, timers } = makeLiveness({ state: { sawActivity: true }, activeTools });
  timers.advance(1_500_000); // 25 minutes, past the 20-minute default lease
  assert.equal(liveness.hasActiveToolLease(), true, "a 30-minute declared build is still leased at 25 minutes");
  timers.advance(400_000); // past its own timeout + margin
  assert.equal(liveness.hasActiveToolLease(), false, "and released after its own timeout");
});

check("a subagent's progress keeps its parent task tool's lease alive", () => {
  const src = require("node:fs").readFileSync(new URL("../src/main/opencode-agent-session.js", import.meta.url), "utf8");
  const onProgress = src.slice(src.indexOf("createOpencodeSubagentRuntime({"), src.indexOf("createOpencodeSubagentRuntime({") + 900);
  assert.match(onProgress, /toLowerCase\(\) === "task"\) tool\.lastActivityAt = Date\.now\(\)/,
    "subagent progress refreshes the parent task tool, so a long child run is not an expired lease");
});

check("the first progress action clears the fuse; later silence is the ordinary no-progress window's job", () => {
  const { liveness, timers, events, shared } = makeLiveness();
  liveness.armResponseTimer();
  timers.advance(30_000);
  shared.sawActivity = true;
  liveness.armResponseTimer(); // what onProgress does
  assert.equal(liveness.diagnostics().firstResponse, false);
  timers.advance(120_000);
  assert.equal(events.noFirstResponse.length, 0);
});

check("a pending user card or an active tool lease pauses the fuse instead of blaming the model", () => {
  const card = makeLiveness({ state: { pendingUserInput: true } });
  card.liveness.armResponseTimer();
  card.timers.advance(90_000);
  assert.equal(card.events.noFirstResponse.length, 0);
  const tools = new Map([["t1", { id: "t1", name: "bash", startedAt: 0, lastActivityAt: 0 }]]);
  const tool = makeLiveness({ activeTools: tools });
  tool.liveness.armResponseTimer();
  tool.timers.advance(90_000);
  assert.equal(tool.events.noFirstResponse.length, 0);
});

check("0 disables the fuse; a settled turn never fires it", () => {
  const off = makeLiveness({ firstResponseTimeoutMs: 0 });
  off.liveness.armResponseTimer();
  assert.equal(off.liveness.diagnostics().firstResponse, false);
  off.timers.advance(600_000);
  assert.equal(off.events.noFirstResponse.length, 0);
  const settled = makeLiveness();
  settled.liveness.armResponseTimer();
  settled.shared.turnSettled = true;
  settled.timers.advance(90_000);
  assert.equal(settled.events.noFirstResponse.length, 0);
});

check("default fuse is 90s and env-tunable", () => {
  assert.equal(OpencodeAgentSession.FIRST_RESPONSE_TIMEOUT_MS, 90_000);
  assert.ok(OpencodeAgentSession.FIRST_RESPONSE_TIMEOUT_MS < OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS);
});

check("MODEL_NO_RESPONSE is classified (Chinese copy) ahead of the broad connection matcher and is rescued twice on a fresh engine", () => {
  const classified = classifyAssistantError("MODEL_NO_RESPONSE: no model response within 90s");
  assert.equal(classified?.code, "MODEL_NO_RESPONSE");
  assert.equal(classified.retryable, true);
  assert.match(classified.message, /没有返回任何内容/);
  assert.match(classified.message, /自动接续/);
  const strategy = rescueStrategyFor("MODEL_NO_RESPONSE");
  assert.equal(strategy?.kind, "model_connection_retry");
  assert.equal(strategy.recycleEngine, true);
  assert.equal(strategy.maxAttempts, 2);
  // Existing classification is untouched.
  assert.equal(classifyAssistantError("API Error: fetch failed")?.code, "MODEL_CONNECTION_FAILED");
});

check("model availability marks are informational, expiring, cleared on first output, and ride the picker list", () => {
  availability.resetModelAvailabilityForTests();
  const model = { providerID: "lily-model-x", modelID: "deepseek-v4-flash" };
  assert.equal(availability.getModelAvailability(model), null);
  const mark = availability.noteModelUnresponsive(model, { silentMs: 90_000, now: 1_000 });
  assert.equal(mark.count, 1);
  assert.equal(availability.getModelAvailability(model, 2_000).reason, "no_response");
  availability.noteModelUnresponsive(model, { silentMs: 90_000, now: 3_000 });
  assert.equal(availability.getModelAvailability(model, 4_000).count, 2);
  const annotated = availability.annotateModelOptions([{ id: "a", providerID: "lily-model-x", modelID: "deepseek-v4-flash" }, { id: "b", providerID: "p", modelID: "other" }], 5_000);
  assert.equal(annotated[0].unavailable.count, 2);
  assert.equal(annotated[1].unavailable, undefined);
  assert.equal(availability.getModelAvailability(model, 3_000 + availability.DEFAULT_TTL_MS + 1), null, "marks expire");
  availability.noteModelUnresponsive(model, { now: 10_000 });
  assert.equal(availability.clearModelAvailability(model), true, "first output clears the mark");
  assert.equal(availability.getModelAvailability(model, 10_001), null);
});

console.log(`\n${checks} checks passed (first-response watchdog)`);
