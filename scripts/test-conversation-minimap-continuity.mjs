#!/usr/bin/env node
// The right-hand question rail, from the 2026-09-15 demo reports:
//  "时有时没有，不能快速找到历史问题" and "历史问题1、历史问题2堆在一起，不是最新的问题".
// Two questions asked inside ONE turn (插话) must be two ribs pointing at two
// different bubbles, a new question during a live turn must rebuild the rail,
// two questions are already enough to show it, clearing the rail must not leave
// a cached "nothing changed" verdict behind, and a resize must recompute the
// offsets. [gate: conversation-scroll-control]
// Run: node scripts/test-conversation-minimap-continuity.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildMinimapItems } from "../src/renderer/modules/message-committed-render-model.js";
import { buildMinimapModel, computeActiveIndex } from "../src/renderer/modules/conversation-minimap-model.js";
import { runtimeVisualSig } from "../src/renderer/modules/message-live-render-model.js";
import { conversationMessageKey, mergeLatestConversationPage, mergeOlderConversationPage } from "../src/renderer/modules/conversation-pagination.js";

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log(`ok - ${name}`); };

const steeredTurn = [
  { role: "user", turnId: "t9", content: "部署一下", timestamp: 1 },
  { role: "assistant", turnId: "t9", content: "开始部署", timestamp: 2 },
  { role: "user", turnId: "t9", steer: true, steerSeq: 1, content: "改成灰度发布", timestamp: 3 },
];

check("two questions inside one turn are two ribs with two distinct DOM targets", () => {
  const items = buildMinimapItems({ committedMessages: steeredTurn });
  assert.equal(items.length, 2, "both questions are listed");
  assert.deepEqual(items.map((i) => i.label), ["部署一下", "改成灰度发布"]);
  assert.equal(items[0].turnId, items[1].turnId, "they really do share a turn");
  assert.notEqual(items[0].key, items[1].key, "…but not a render key, so they resolve to different bubbles");
  const entries = buildMinimapModel(items, { scope: "prompts", terminus: true, terminusLabel: "最新" });
  assert.deepEqual(entries.map((e) => e.kind), ["prompt", "prompt", "terminus"]);
  assert.equal(entries[1].key, "user:t9:steer:1");
  const source = fs.readFileSync(new URL("../src/renderer/modules/conversation-minimap.js", import.meta.url), "utf8");
  const resolve = source.slice(source.indexOf("function resolveTarget"), source.indexOf("function scrollOffsetOf"));
  assert.ok(resolve.indexOf("data-message-key") < resolve.indexOf("data-turn-id"), "the key lookup must win over turnId");
});

check("the rail appears from the second question, not the third", () => {
  const source = fs.readFileSync(new URL("../src/renderer/modules/conversation-minimap.js", import.meta.url), "utf8");
  assert.match(source, /const MIN_RIBS = 3;/);
  const two = buildMinimapModel(
    buildMinimapItems({ committedMessages: [
      { role: "user", turnId: "a", content: "问题一", timestamp: 1 },
      { role: "user", turnId: "b", content: "问题二", timestamp: 2 },
    ] }),
    { scope: "prompts", terminus: true },
  );
  assert.equal(two.length, 3, "2 questions + terminus clears the threshold");
});

check("a question asked during a live turn changes the render signature", () => {
  const live = { turnId: "t9", phase: "streaming", assistantText: "…", timeline: [], permissions: new Map(), questions: new Map(), hooks: new Map() };
  const before = runtimeVisualSig({ phase: "streaming", liveTurn: live, committedMessages: steeredTurn.slice(0, 2), queue: [] });
  const after = runtimeVisualSig({ phase: "streaming", liveTurn: live, committedMessages: steeredTurn, queue: [] });
  assert.notEqual(before, after, "without this the rail keeps showing only the older questions");
});

check("merging an older page keeps both questions of a steered turn", () => {
  assert.notEqual(conversationMessageKey(steeredTurn[0]), conversationMessageKey(steeredTurn[2]));
  const merged = mergeOlderConversationPage(steeredTurn, steeredTurn);
  const questions = merged.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(questions, ["部署一下", "改成灰度发布"], "the second question must not overwrite the first");
});

check("the same question asked in two different turns stays two questions", () => {
  const first = { role: "user", turnId: "t1", content: "继续", timestamp: "2026-01-01T10:00:00.000Z" };
  const second = { role: "user", turnId: "t2", content: "继续", timestamp: "2026-01-01T10:06:00.000Z" };
  assert.equal(mergeOlderConversationPage([first, second], [first, second]).filter((m) => m.role === "user").length, 2,
    "identical wording within the 10-minute window used to collapse into one rib");
  const noTimestamps = [
    { role: "user", turnId: "t3", content: "继续" },
    { role: "user", turnId: "t4", content: "继续" },
  ];
  assert.equal(mergeOlderConversationPage(noTimestamps, noTimestamps).length, 2,
    "an unparsable timestamp used to merge them at ANY distance");
  // The same message arriving from two sources (engine copy carries no turnId)
  // must still enrich rather than duplicate.
  const localCopy = { id: "local", role: "user", turnId: "t9", content: "同一个问题", timestamp: "2026-01-01T11:00:00.000Z" };
  const engineCopy = { id: "engine", role: "user", content: "同一个问题", timestamp: "2026-01-01T11:00:10.000Z", meta: { source: "opencode" } };
  assert.equal(mergeLatestConversationPage([localCopy], [engineCopy]).length, 1);
});

check("clearing the rail invalidates the cached render signature, and a resize rebuilds the offsets", () => {
  const message = fs.readFileSync(new URL("../src/renderer/modules/message.js", import.meta.url), "utf8");
  const clear = message.slice(message.indexOf("function clearStackMinimaps"), message.indexOf("function clearStackMinimaps") + 600);
  assert.match(clear, /lastRuntimeVisualSig\.clear\(\)/,
    "the rail is gone from the DOM, so 'nothing changed' is no longer true");
  const minimap = fs.readFileSync(new URL("../src/renderer/modules/conversation-minimap.js", import.meta.url), "utf8");
  assert.match(minimap, /window\.addEventListener\("resize"/);
  assert.match(minimap, /bindResizeRebuild\(panel, opts\)/);
});

check("active-rib maths is unchanged for ordinary offsets", () => {
  const offsets = [0, 100, 400, 900];
  assert.equal(computeActiveIndex(0, 300, 2000, offsets), 0);
  assert.equal(computeActiveIndex(350, 300, 2000, offsets), 2);
  assert.equal(computeActiveIndex(0, 300, 2000, []), -1);
});

check("the resize registry is keyed by panel, so repeated renders cannot grow it", () => {
  const minimap = fs.readFileSync(new URL("../src/renderer/modules/conversation-minimap.js", import.meta.url), "utf8");
  assert.match(minimap, /const resizeTargets = new Map\(\);/,
    "a Set of fresh {panel, opts} objects grew one entry per render and rebuilt the rail once per entry on resize");
  assert.match(minimap, /resizeTargets\.set\(panel, opts\)/);
  const teardown = minimap.slice(minimap.indexOf("export function teardownMinimap"), minimap.indexOf("export function teardownMinimap") + 200);
  assert.match(teardown, /resizeTargets\.delete\(panel\)/, "a torn-down rail stops being rebuilt on resize");
});

console.log(`\n${checks} checks passed (conversation minimap continuity)`);
