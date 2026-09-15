#!/usr/bin/env node
// A pre-turn compaction writes its handoff summary as an ordinary assistant
// message in the SAME engine session. Nothing that produces the user-facing
// answer may adopt that message. 2026-09-15 field case: a question was
// "answered" with the summary's Relevant Files list and the question itself
// never ran. [gate: task-completion-integrity]
// Run: node scripts/test-compaction-summary-not-answer.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpencodeHistoryRecovery } = require("../src/main/opencode-history-recovery.js");
const {
  assistantTextFromOpenCodeMessageItem,
  adaptOpencodeMessageItem,
  isCompactionSummaryInfo,
} = require("../src/main/runtime/opencode-conversation-adapter.js");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

const FIELD_SUMMARY = [
  "## Objective",
  "- 原始请求（原样保留）：「为啥很多还是展示待接入」",
  "## Work State",
  "### Completed",
  "- 第五批已接入",
  "## Next Move",
  "1. 直接回答「为啥很多还是展示待接入」",
  "## Relevant Files",
  "- `/Users/zhangqin/toolhub/backend/caps.js`：能力探测",
].join("\n");

const msg = (info, text) => ({ info, parts: text ? [{ type: "text", text }] : [] });

check("engine summary flags are recognised", () => {
  assert.equal(isCompactionSummaryInfo({ summary: true }), true);
  assert.equal(isCompactionSummaryInfo({ agent: "compaction" }), true);
  assert.equal(isCompactionSummaryInfo({ role: "assistant" }), false);
});

check("a summary message yields no assistant text", () => {
  const summary = msg({ role: "assistant", summary: true, time: { created: 10, completed: 20 } }, FIELD_SUMMARY);
  assert.equal(assistantTextFromOpenCodeMessageItem(summary), "");
  assert.equal(adaptOpencodeMessageItem(summary), null, "and never enters chat history");
  const real = msg({ role: "assistant", time: { created: 10, completed: 20 } }, "只剩 5 个待接入。");
  assert.equal(assistantTextFromOpenCodeMessageItem(real), "只剩 5 个待接入。", "a real answer is untouched");
});

// The field session: user prompt, then ONLY the compaction summary. Recovery
// must report no output instead of adopting the summary as the answer.
function recovery(items, { turnStartedAt = 100, promptText = "为啥很多还是展示待接入" } = {}) {
  return createOpencodeHistoryRecovery({
    getServer: () => ({ messages: async () => ({ data: items }), lastPromptText: promptText }),
    getTurnStartedAt: () => turnStartedAt,
    getPendingPromptPayload: () => ({ text: promptText }),
    getSessionStatus: async () => "idle",
    getSyncTimeoutMs: () => 50,
  });
}

const onlySummary = [
  msg({ role: "user", time: { created: 110 } }, "为啥很多还是展示待接入"),
  msg({ role: "assistant", summary: true, time: { created: 120, completed: 180 } }, FIELD_SUMMARY),
];
const latest = await recovery(onlySummary).latestAssistant({ requireCurrentPrompt: true });
assert.equal(latest, null, "the summary is not offered as the turn result");
checks += 1; console.log("ok - the summary is never the turn result");

// Streamed output must not be replaced by a newer summary either.
const withReal = [
  msg({ role: "user", time: { created: 110 } }, "为啥很多还是展示待接入"),
  msg({ role: "assistant", time: { created: 120, completed: 130 } }, "只剩 5 个待接入。"),
  msg({ role: "assistant", summary: true, time: { created: 140, completed: 190 } }, FIELD_SUMMARY),
];
const synced = await recovery(withReal).syncFinalOutput({ output: "只剩 5 个" });
assert.equal(synced.output, "只剩 5 个待接入。", "the real answer wins over a newer summary");
checks += 1; console.log("ok - a newer summary never overwrites the real answer");

const kept = await recovery(onlySummary).syncFinalOutput({ output: "已经流式产出的真实回答" });
assert.equal(kept.output, "已经流式产出的真实回答", "streamed output survives when only a summary exists");
checks += 1; console.log("ok - streamed output is not replaced by a summary");

// The runtime reducer must publish the compaction window so the first-response
// watchdog can wait it out, and must keep the summary's text out of turn output.
{
  const { createOpencodeRuntimeState, reduceOpencodeRuntimeEvent } = require("../src/main/runtime/opencode-runtime-reducer.js");
  const state = createOpencodeRuntimeState();
  const ev = (type, properties) => reduceOpencodeRuntimeEvent({ type, properties }, state);

  const started = ev("message.updated", { info: { id: "msg_sum", role: "assistant", summary: true, time: { created: 1 } } });
  assert.deepEqual([...state.activeCompactions.keys()], ["msg_sum"], "the compaction window opens");
  assert.deepEqual(started.effects, [], "a compaction is not turn output");
  assert.equal(started.progress, false, "and is not turn progress");

  const summaryText = ev("message.part.updated", {
    part: { id: "p1", type: "text", messageID: "msg_sum", text: FIELD_SUMMARY },
  });
  assert.deepEqual(summaryText.effects, [], "summary text is never turn output");
  assert.equal(summaryText.drafts.length, 0, "and is never streamed to the renderer");

  ev("message.updated", { info: { id: "msg_sum", role: "assistant", summary: true, time: { created: 1, completed: 2 } } });
  assert.equal(state.activeCompactions.size, 0, "a finished compaction closes the window");

  ev("message.updated", { info: { id: "msg_sum2", role: "assistant", agent: "compaction" } });
  ev("message.updated", { info: { id: "msg_sum2", role: "assistant", agent: "compaction", error: { name: "MessageAbortedError" } } });
  assert.equal(state.activeCompactions.size, 0, "an aborted compaction also closes the window");

  ev("message.updated", { info: { id: "msg_real", role: "assistant", time: { created: 3 } } });
  const real = ev("message.part.updated", { part: { id: "p2", type: "text", messageID: "msg_real", text: "只剩 5 个待接入。" } });
  assert.deepEqual(real.effects, [{ kind: "assistant_text", text: "只剩 5 个待接入。" }], "a real answer still reaches the turn");
  checks += 1; console.log("ok - the reducer tracks the compaction window and suppresses its text");
}

// The session hands the watchdog a predicate over that same state, so a turn
// whose engine is mid-compaction is never reported as a silent model.
{
  const { createOpencodeRuntimeState } = require("../src/main/runtime/opencode-runtime-reducer.js");
  const { hasActiveCompaction } = require("../src/main/runtime/opencode-runtime-reducer.js");
  const eventState = createOpencodeRuntimeState();
  assert.equal(hasActiveCompaction(eventState), false, "idle session: the fuse behaves normally");
  eventState.activeCompactions.set("msg_sum", Date.now());
  assert.equal(hasActiveCompaction(eventState), true, "mid-compaction: the fuse waits");
  eventState.activeCompactions.delete("msg_sum");
  assert.equal(hasActiveCompaction(eventState), false, "after the summary lands the fuse resumes");
  const source = require("node:fs").readFileSync(new URL("../src/main/opencode-agent-session.js", import.meta.url), "utf8");
  assert.match(source, /hasActiveCompaction: \(\) => hasActiveCompaction\(this\._eventState\)/,
    "the session wires the predicate to the shared reducer helper");
  checks += 1; console.log("ok - the watchdog predicate is wired to the compaction window");
}

// A pre-turn compaction is dispatched BEFORE the turn and keeps generating
// across the turn's state reset. Clearing the window there would hide it from
// the watchdog again — the exact bug this fix exists to prevent.
{
  const { createOpencodeRuntimeState, resetOpencodeRuntimeState, reduceOpencodeRuntimeEvent, hasActiveCompaction, COMPACTION_WINDOW_MAX_MS } =
    require("../src/main/runtime/opencode-runtime-reducer.js");
  const state = createOpencodeRuntimeState();
  const ev = (type, properties) => reduceOpencodeRuntimeEvent({ type, properties }, state);

  ev("message.updated", { info: { id: "sum", role: "assistant", summary: true, time: { created: 1 } } });
  assert.equal(hasActiveCompaction(state), true, "the window opens when the summary starts");
  resetOpencodeRuntimeState(state);
  assert.equal(hasActiveCompaction(state), true, "and survives the turn reset that follows the dispatch");
  ev("message.updated", { info: { id: "sum", role: "assistant", summary: true, time: { created: 1, completed: 2 } } });
  assert.equal(hasActiveCompaction(state), false, "completion closes it");

  const removed = createOpencodeRuntimeState();
  const ev2 = (type, properties) => reduceOpencodeRuntimeEvent({ type, properties }, removed);
  ev2("message.updated", { info: { id: "s", role: "assistant", agent: "compaction" } });
  ev2("message.removed", { messageID: "s" });
  assert.equal(hasActiveCompaction(removed), false, "a removed summary closes it");

  // A compaction that never reports completion must not disable the fuse forever.
  const stuck = createOpencodeRuntimeState();
  stuck.activeCompactions.set("stuck", Date.now() - COMPACTION_WINDOW_MAX_MS - 1);
  assert.equal(hasActiveCompaction(stuck), false, "an expired window stops extending the fuse");
  stuck.activeCompactions.set("fresh", Date.now());
  assert.equal(hasActiveCompaction(stuck), true, "a live window still counts");

  // Repeated updates must not push the start time forward (it would never expire).
  const steady = createOpencodeRuntimeState();
  const ev3 = (type, properties) => reduceOpencodeRuntimeEvent({ type, properties }, steady);
  ev3("message.updated", { info: { id: "s", role: "assistant", summary: true } });
  const startedAt = steady.activeCompactions.get("s");
  steady.activeCompactions.set("s", startedAt - 1000);
  ev3("message.updated", { info: { id: "s", role: "assistant", summary: true } });
  assert.equal(steady.activeCompactions.get("s"), startedAt - 1000, "the start time is recorded once");
  checks += 1; console.log("ok - the compaction window survives the turn reset, closes and expires");
}

console.log(`compaction-summary-not-answer: ok (${checks} checks)`);
