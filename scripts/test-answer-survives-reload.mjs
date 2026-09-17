#!/usr/bin/env node
/**
 * A reloaded turn shows its ANSWER where the answer goes.
 *
 * Separating the answer from the narration written while working is a property
 * of the in-memory timeline: the last text block is the answer, every earlier
 * one belongs in the process area. Persistence drops the timeline, so reopening
 * a conversation put the whole concatenated stream — narration, the blank runs
 * left where tool cards had been, and the answer — into the answer slot. A
 * finished turn read as though the assistant had carried on talking after it
 * was done. Field case 2026-09-17, a 57-minute turn with 224 tool calls.
 *
 * The record now carries the answer text, which is the only boundary needed.
 * [gate: answer-survives-reload]
 * Run: node scripts/test-answer-survives-reload.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { compactRuntimeEventForPersistence } = require("../src/main/store/runtime-event-persistence.js");
const { timelineFromRecord } = await import("../src/renderer/modules/turn-record-timeline.js");
const { resolveAssistantStreamText } = await import("../src/renderer/modules/turn-narrative-policy.js");
const { getRenderableTimeline } = await import("../src/renderer/modules/turn-renderable-timeline.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const NARRATION = "先核对当前状态，再选目标。\n\n\n\n\n工具链确认：cwebp + sips。\n\n\n\n模式全部摸清，开始第十二批。";
const ANSWER = "第十二批完成。这一批拆的付费墙：按天限量和会员导出。\n\n下一批候选：PDF 压缩。";
const FULL = `${NARRATION}\n\n\n\n${ANSWER}`;

check("persistence keeps the answer boundary, taken from the live timeline", () => {
  const event = {
    type: "turn.completed",
    payload: {
      assistant: FULL,
      record: {
        turnId: "turn-x", sessionId: "s", assistantText: FULL,
        timeline: [
          { kind: "text", text: NARRATION },
          { kind: "tool", id: "t1" },
          { kind: "text", text: ANSWER },
        ],
      },
    },
  };
  const compact = compactRuntimeEventForPersistence(event);
  assert.equal(compact.payload.record.answerText, ANSWER, "the last text block is the answer");
  assert.equal(compact.payload.record.assistantText, FULL, "the full stream is still stored");
  assert.equal(compact.payload.record.timeline, undefined, "the timeline itself is still dropped");
});

check("the field case: the answer goes to the answer slot, the narration does not", () => {
  const record = { turnId: "turn-x", assistantText: FULL, answerText: ANSWER };
  const timeline = timelineFromRecord(record);
  assert.equal(timeline.length, 2);
  const liveTurn = { timeline, assistantText: FULL, final: { payload: { assistant: FULL } } };
  assert.equal(resolveAssistantStreamText(liveTurn), ANSWER,
    "before this, the whole 3000-character stream landed here");
  const process = getRenderableTimeline({ timeline });
  assert.equal(process.length, 1, "the narration stays visible, in the process area");
  assert.ok(process[0].text.startsWith("先核对当前状态"));
  assert.ok(!process[0].text.includes(ANSWER), "the answer is not shown twice");
});

check("blank runs are collapsed in the narration and never in the answer", () => {
  const timeline = timelineFromRecord({ assistantText: FULL, answerText: ANSWER });
  assert.ok(!/\n{3,}/.test(timeline[0].text), "runs left by removed tool cards are closed up");
  assert.equal(timeline[1].text, ANSWER, "the answer is byte-identical to what the model wrote");
  const withBlanks = "a\n\n\nb";
  assert.equal(timelineFromRecord({ assistantText: `x\n\n\n\n${withBlanks}`, answerText: withBlanks })[1].text,
    withBlanks, "even when the answer itself contains blank runs");
});

check("records without the boundary behave exactly as before", () => {
  assert.deepEqual(timelineFromRecord({ assistantText: FULL }), [], "an old record changes nothing");
  assert.deepEqual(timelineFromRecord({}), []);
  assert.deepEqual(timelineFromRecord({ assistantText: FULL, answerText: "   " }), []);
  const kept = [{ kind: "text", text: "live" }];
  assert.equal(timelineFromRecord({ timeline: kept, answerText: ANSWER }), kept, "a real timeline always wins");
  // A turn that only ever answered has no narration to separate.
  const only = timelineFromRecord({ assistantText: ANSWER, answerText: ANSWER });
  assert.equal(only.length, 1);
  assert.equal(getRenderableTimeline({ timeline: only }).length, 0, "nothing lands in the process area");
});

check("the answer survives truncation of the stream it came from", () => {
  // truncateString keeps the HEAD, so a long turn's stream loses its tail —
  // which is exactly where the conclusion lives. Storing the answer separately
  // is what keeps it.
  const huge = "x".repeat(200_000);
  const compact = compactRuntimeEventForPersistence({
    type: "turn.completed",
    payload: {
      assistant: `${huge}${ANSWER}`,
      record: {
        turnId: "t", sessionId: "s", assistantText: `${huge}${ANSWER}`,
        timeline: [{ kind: "text", text: ANSWER }],
      },
    },
  });
  assert.ok(compact.payload.record.assistantText.length < huge.length + ANSWER.length, "the stream was truncated");
  assert.ok(!compact.payload.record.assistantText.endsWith(ANSWER), "and lost its tail, as it always did");
  assert.equal(compact.payload.record.answerText, ANSWER, "the answer is kept anyway");
});

check("the reload adapter uses it", () => {
  const adapter = fs.readFileSync(path.join(ROOT, "src/renderer/modules/turn-live-turn-adapter.js"), "utf8");
  assert.match(adapter, /timeline: timelineFromRecord\(record\)/);
});

console.log(`\n${checks} checks passed (answer survives reload)`);
