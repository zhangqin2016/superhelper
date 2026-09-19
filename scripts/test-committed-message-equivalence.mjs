#!/usr/bin/env node
// Two committed messages are "the same" by one set of predicates, answered in
// time proportional to the answer rather than to the history.
//
// CPU-profiled on 2026-09-19 (real app over CDP): switching into a session with
// 359 cached messages spent 565 ms of the renderer thread in
// equivalentCommittedMessageIndex — every pair re-normalised both texts with
// three regex passes and checked the 30-minute timestamp window LAST. With a
// thousand-message conversation that is the multi-second "switch" a customer
// reported. Facets are now derived once per message object and the window is
// checked first; the predicates give the same answers. [gate: session-switch-cost]
// Run: node scripts/test-committed-message-equivalence.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const eq = await import("../src/renderer/modules/committed-message-equivalence.js");
const { createCommittedMessageProjection } = await import("../src/renderer/modules/committed-message-projection.js");
const { mergeIncomingCommittedMessages, dedupeCommittedMessages } = createCommittedMessageProjection(eq.equivalentCommittedMessageIndex);

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }
const at = (minutes) => new Date(Date.UTC(2026, 8, 19, 10, minutes)).toISOString();
const long = (seed) => `${seed} `.repeat(40).trim(); // > 80 chars once compacted

check("the predicates answer as before: key, projection duplicate, near-identical assistant turn, drafts", () => {
  const cached = [
    { id: "u1", role: "user", turnId: "t1", content: "请 分析这份报告", timestamp: at(0) },
    { id: "a1", role: "assistant", turnId: "t1", content: "", record: { assistantText: `✓ 步骤\n${long("结论一")}` }, timestamp: at(1) },
    { id: "u2", role: "user", content: "short", timestamp: at(5) },
    { id: "d1", role: "user", content: "每天提醒我", meta: { scheduledDraft: { title: "每天提醒我", scheduleText: "Every day" } }, timestamp: at(6) },
  ];
  const find = (message) => eq.equivalentCommittedMessageIndex(cached, message);
  assert.equal(find({ id: "other", role: "user", turnId: "t1", content: "x" }), 0, "same turn key");
  assert.equal(find({ id: "projection:u1", role: "user", content: "请   分析这份报告", timestamp: at(2) }), 0, "projection duplicate within the window (whitespace runs collapse)");
  assert.equal(find({ id: "projection:u1", role: "user", content: "请 分析这份报告", timestamp: at(40) }), -1, "…but not outside it");
  assert.equal(find({ id: "official-1", role: "assistant", content: long("结论一"), timestamp: at(3) }), 1, "official copy of the rich turn (subset, whitespace differs)");
  assert.equal(find({ id: "official-1", role: "assistant", content: long("结论一"), timestamp: at(50) }), -1, "same text outside the window is another turn");
  assert.equal(find({ id: "official-2", role: "assistant", content: "short", timestamp: at(1) }), -1, "short text never over-merges");
  assert.equal(find({ id: "d2", role: "user", content: "每天提醒我", meta: { scheduledDraft: { title: "每天提醒我", scheduleText: "Every day" } }, timestamp: at(7) }), 3, "matching scheduled draft");
  assert.equal(find({ id: "s1", role: "user", turnId: "t1", steer: true, steerSeq: 2, content: "顺便" }), -1, "a steer message has its own key");
  assert.equal(eq.committedMessageKey({ role: "user", turnId: "t1", steer: true, steerSeq: 2 }), "turn:user:t1:steer:2");
  assert.equal(eq.assistantTextEquivalent(long("a b"), long("ab")), true, "whitespace is insignificant");
});

check("a message edited in place is re-read — facets are validated against what they were derived from", () => {
  const message = { id: "m", role: "assistant", content: long("first"), timestamp: at(0) };
  const other = { id: "n", role: "assistant", content: long("first"), timestamp: at(1) };
  assert.equal(eq.equivalentCommittedMessageIndex([message], other), 0);
  message.content = long("second");
  assert.equal(eq.equivalentCommittedMessageIndex([message], other), -1, "the new text is compared, not the cached one");
  message.record = { assistantText: long("first") };
  message.content = "";
  assert.equal(eq.equivalentCommittedMessageIndex([message], other), 0, "and so is a replaced record");
  message.timestamp = at(90);
  assert.equal(eq.equivalentCommittedMessageIndex([message], other), -1, "and a moved timestamp");
});

check("merging a page into a thousand-message history costs milliseconds, cold and warm", () => {
  const history = [];
  for (let i = 0; i < 1000; i += 1) {
    const role = i % 2 ? "assistant" : "user";
    history.push({ id: `h${i}`, role, turnId: `t${i >> 1}`, content: role === "user" ? `问题 ${i} ${long("背景")}` : "", record: role === "assistant" ? { assistantText: long(`回答 ${i}`) } : undefined, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 3 * 60 * 1000).toISOString() });
  }
  // The official page: the last 50 messages again, as the engine renders them
  // (plain content, no turnId, different ids, whitespace differences).
  const page = history.slice(-50).map((m, i) => ({ id: `official-${i}`, role: m.role, content: (m.content || m.record?.assistantText || "").replace(/ /g, "  "), timestamp: m.timestamp }));
  const t0 = performance.now();
  const merged = mergeIncomingCommittedMessages(history, page);
  const deduped = dedupeCommittedMessages([...history, ...merged]);
  const cold = performance.now() - t0;
  const t1 = performance.now();
  mergeIncomingCommittedMessages(history, page);
  dedupeCommittedMessages([...history, ...merged]);
  const warm = performance.now() - t1;
  assert.equal(deduped.length, 1000, "every official copy collapsed into its turn");
  assert.ok(cold < 400, `cold merge under budget: ${cold.toFixed(0)}ms`);
  assert.ok(warm < 150, `warm merge under budget: ${warm.toFixed(0)}ms`);
  console.log(`   merge 1000×50 + dedupe 1050: cold ${cold.toFixed(1)}ms, warm ${warm.toFixed(1)}ms`);
});

check("the store has one equivalence — it imports these predicates and keeps no copy", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/renderer/modules/session-runtime-store.js"), "utf8");
  assert.match(src, /import \{ committedMessageKey, equivalentCommittedMessageIndex \} from "\.\/committed-message-equivalence\.js"/);
  for (const name of ["normalizedMessageText", "assistantTextEquivalent", "sameAssistantTurnWithinWindow", "sameContentWithinWindow", "scheduledDraftSignature"]) {
    assert.ok(!new RegExp(`function ${name}\\b`).test(src), `${name} is not redefined in the store`);
  }
  const mod = fs.readFileSync(path.join(ROOT, "src/renderer/modules/committed-message-equivalence.js"), "utf8");
  // The cheap gate runs before any text is compared, in both windowed predicates.
  for (const fn of ["sameContentWithinWindow", "sameAssistantTurnWithinWindow"]) {
    const body = mod.slice(mod.indexOf(`function ${fn}(`));
    assert.ok(body.indexOf("withinWindow(fa, fb") < body.indexOf("normalized ===") || body.indexOf("withinWindow(fa, fb") < body.indexOf("compactTextEquivalent(fa"), `${fn} checks the window first`);
  }
});

console.log(`\n${checks} checks passed (committed message equivalence)`);
