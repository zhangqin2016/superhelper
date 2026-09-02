#!/usr/bin/env node
/**
 * User-blocked time must never be billed to the assistant.
 *
 * Guards the accounting in src/main/turn-user-wait.js plus the two consumers
 * that made the defect visible: the timeline (which credits a tool that
 * finishes while a card is still open) and the renderer's duration suffix
 * (which showed an 8m27s question card as "已完成 · 507.8s").
 */
import assert from "node:assert/strict";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const {
  beginUserWait,
  creditFinishedToolWait,
  earliestPendingRequestAt,
  endUserWait,
} = require("../src/main/turn-user-wait.js");
const { upsertTimelineTool } = require("../src/main/turn-timeline.js");

const toolState = (extra = {}) => ({ timeline: [], tools: new Map(), ...extra });

// --- the field case: a question card answered after 8m27s -------------------
{
  const state = toolState();
  upsertTimelineTool(state, { id: "q1", name: "question", status: "running" }, 1_000);
  beginUserWait(state, 1_000);
  endUserWait(state, 508_799); // user answered 8m27.8s later
  const entry = state.timeline.find((e) => e.id === "q1");
  assert.equal(entry.waitMs, 507_799, "the whole card lifetime is the user's wait");
  assert.equal(state.userWait.totalMs, 507_799);
  assert.equal(state.userWait.since, 0, "the interval is closed");
}

// --- the 2026-07-22 case: a bash tool suspended by a permission card --------
// The tool did real work before the card and after the answer; only the middle
// belongs to the user.
{
  const state = toolState();
  upsertTimelineTool(state, { id: "b1", name: "bash", status: "running" }, 1_000);
  beginUserWait(state, 3_000);
  endUserWait(state, 1_203_000); // 20 minutes on the card
  upsertTimelineTool(state, { id: "b1", name: "bash", status: "done" }, 1_206_000);
  const entry = state.timeline.find((e) => e.id === "b1");
  assert.equal(entry.waitMs, 1_200_000, "only the card interval counts");
  const elapsed = entry.ts - entry.startTs;
  assert.equal(elapsed - entry.waitMs, 5_000, "5s of real compute survives");
}

// --- a tool that STARTS during a wait is credited only its own overlap ------
{
  const state = toolState();
  beginUserWait(state, 1_000);
  upsertTimelineTool(state, { id: "late", name: "read", status: "running" }, 4_000);
  endUserWait(state, 10_000);
  assert.equal(state.timeline.find((e) => e.id === "late").waitMs, 6_000);
}

// --- neither event order may double-credit ---------------------------------
// The engine resolves the card and completes the tool in the same tick and the
// order between them is not guaranteed.
for (const order of ["resolve-then-done", "done-then-resolve"]) {
  const state = toolState();
  upsertTimelineTool(state, { id: "q", name: "question", status: "running" }, 1_000);
  beginUserWait(state, 1_000);
  if (order === "resolve-then-done") {
    endUserWait(state, 61_000);
    upsertTimelineTool(state, { id: "q", name: "question", status: "done" }, 61_000);
  } else {
    upsertTimelineTool(state, { id: "q", name: "question", status: "done" }, 61_000);
    endUserWait(state, 61_000);
  }
  assert.equal(
    state.timeline.find((e) => e.id === "q").waitMs,
    60_000,
    `${order} must credit the wait exactly once`,
  );
}

// --- concurrent cards share ONE interval (no nesting, no double count) -----
{
  const state = toolState();
  upsertTimelineTool(state, { id: "t", name: "bash", status: "running" }, 1_000);
  beginUserWait(state, 1_000);
  beginUserWait(state, 5_000); // a second card opens while the first is pending
  endUserWait(state, 31_000);
  assert.equal(state.timeline.find((e) => e.id === "t").waitMs, 30_000);
}

// --- fail-safe: a missed hook degrades to today's behaviour, never worse ----
{
  const state = toolState();
  upsertTimelineTool(state, { id: "t", name: "bash", status: "running" }, 1_000);
  upsertTimelineTool(state, { id: "t", name: "bash", status: "done" }, 9_000);
  assert.equal(state.timeline.find((e) => e.id === "t").waitMs, undefined, "no wait recorded");
  assert.equal(endUserWait(state, 9_000), 0, "closing a never-opened interval is a no-op");
  assert.doesNotThrow(() => beginUserWait(null, 1));
  assert.doesNotThrow(() => endUserWait(undefined, 1));
  assert.doesNotThrow(() => creditFinishedToolWait(null, null, 1));
}

// --- earliestPendingRequestAt: the oldest open card wins --------------------
{
  const permissions = new Map([["p1", { requestedAt: 5_000 }]]);
  const questions = new Map([["q1", { requestedAt: 3_000 }], ["q2", { requestedAt: 9_000 }]]);
  assert.equal(earliestPendingRequestAt(permissions, questions), 3_000);
  assert.equal(earliestPendingRequestAt(new Map(), new Map()), 0);
  assert.equal(earliestPendingRequestAt(undefined, null), 0, "missing maps never throw");
  // Legacy entries without a stamp must not read as "waiting since epoch 0".
  assert.equal(earliestPendingRequestAt(new Map([["old", {}]])), 0);
}

// --- the renderer half: wait time is never shown as compute -----------------
const { buildToolDurationSuffix, formatWaitDuration } = await import(
  "../src/renderer/modules/turn-view-status.js"
);
const translate = (key, vars) => (
  key === "timeline.toolAwaitingYou" ? `waited ${vars.duration}` : key
);
{
  // Unchanged for an ordinary tool.
  assert.equal(buildToolDurationSuffix({ status: "done", startTs: 1_000, ts: 3_500 }, 0, translate), " · 2.5s");
  // The field case: 507.8s of the user's own deciding must not read as latency.
  const field = buildToolDurationSuffix(
    { status: "done", startTs: 1_000, ts: 508_799, waitMs: 507_799 }, 0, translate,
  );
  assert(!/507/.test(field), `the user's wait must not be billed as latency: ${field}`);
  assert.equal(field, " · waited 8m 27s");
  // Real compute plus a permission card: both, kept separate.
  assert.equal(
    buildToolDurationSuffix({ status: "done", startTs: 1_000, ts: 1_206_000, waitMs: 1_200_000 }, 0, translate),
    " · 5.0s · waited 20m",
  );
  // A running tool clocks against `now`, and a still-open card is still wait.
  assert.equal(
    buildToolDurationSuffix({ status: "running", startTs: 1_000, waitMs: 30_000 }, 61_000, translate),
    " · 30.0s · waited 30s",
  );
  // Degradations, in order of nastiness — none may ever show wait as compute:
  // no translate → drop only the annotation; absent waitMs → today's behaviour;
  // waitMs larger than the tool's own life → clamped, never negative.
  assert.equal(buildToolDurationSuffix({ status: "done", startTs: 1_000, ts: 508_799, waitMs: 507_799 }), "");
  assert.equal(buildToolDurationSuffix({ status: "done", startTs: 1_000, ts: 3_500 }, 0, translate), " · 2.5s");
  assert.equal(buildToolDurationSuffix({ status: "done", startTs: 1_000, ts: 3_000, waitMs: 9_999_999 }, 0, translate), " · waited 2s");
  assert.equal(buildToolDurationSuffix({ status: "done", startTs: 1_000, ts: 3_000, waitMs: -5 }, 0, translate), " · 2.0s");
  assert.equal(buildToolDurationSuffix({ status: "pending", startTs: 1_000, ts: 9_000 }, 0, translate), "");
  assert.equal(formatWaitDuration(507_799), "8m 27s");
  assert.equal(formatWaitDuration(1_200_000), "20m");
  assert.equal(formatWaitDuration(45_000), "45s");
}

// --- the heartbeat must name the true state, not the tool's stopwatch -------
const { createOpencodeTurnLiveness } = require("../src/main/opencode-turn-liveness.js");
{
  const drafts = [];
  const activeTools = new Map([["q", {
    id: "q", name: "question", title: "question", startedAt: 1_000, lastActivityAt: 1_000,
  }]]);
  let state = { busy: true, turnSettled: false, pendingUserInput: true, pendingUserInputSince: 1_000 };
  const liveness = createOpencodeTurnLiveness({
    sessionId: "s",
    activeTools,
    getState: () => state,
    getConfig: () => ({ activeToolLeaseMs: 0, progressNoticeMs: 45_000 }),
    ingest: (batch) => drafts.push(...batch),
    now: () => 510_000,
    setTimeout: () => null,
    clearTimeout: () => {},
  });
  assert.match(liveness.awaitingUserDetail(), /等待你确认或回答 · 已等待 8m 29s/);
  assert.equal(liveness.emitGenericToolProgressNotice(), true);
  const notice = drafts.at(-1).payload.notice;
  assert.equal(notice.code, "awaitingUser", "waiting on the user gets its own notice code");
  assert(!/正在运行/.test(notice.detail), `must not claim the tool is working: ${notice.detail}`);
  assert(!/最近活动/.test(notice.detail), "must not imply a hang while the user is deciding");

  // Once the card is answered the heartbeat goes back to reporting real work.
  state = { busy: true, turnSettled: false, pendingUserInput: false, pendingUserInputSince: 0 };
  liveness.resetProgressNotice();
  assert.equal(liveness.emitGenericToolProgressNotice(), true);
  const working = drafts.at(-1).payload.notice;
  assert.equal(working.code, "toolProgress");
  assert.match(working.detail, /正在运行/);
  // Both share one replace slot, so they swap in place instead of stacking.
  assert.equal(working.replacesCode, "genericToolProgress");
  assert.equal(notice.replacesCode, "genericToolProgress");
}

console.log("turn-user-wait: ok");
