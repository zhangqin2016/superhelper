#!/usr/bin/env node
/**
 * What a turn produced survives the app dying, and reopens the way it ran.
 *
 * 2026-09-24: a 38-minute, 224-tool turn was cut off by a restart. Recovery
 * marked it `turn.dispatch_outcome_unknown`, and that branch of the projection
 * REPLACED the accumulated answer with "本次回复的持久化结果无法确认…" — the
 * turn reopened as one sentence, its 90 KB of thinking still in the row and
 * every tool event still in the log, neither shown (the rebuilt record had
 * `tools: []`, `timeline: []`).
 *
 * The projection is the durable copy of a running turn; now nothing overwrites
 * it, it records the order things streamed in, and a turn with no archived
 * record is rebuilt from it. It is also written once per batch, not once per
 * delta.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { DISPATCH_OUTCOME_UNKNOWN_ASSISTANT } = require("../src/main/turn-recovery-projection.js");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-survives-kill-"));
const store = new MessageStore(path.join(root, "messages.db"), path.join(root, "blobs"));
let seq = 0;
const ev = (turnId, type, payload = {}) => ({ id: `evt_${++seq}`, seq, turnId, type, source: "test", ts: 1_790_000_000_000 + seq, payload });

function runTurn(turnId, steps) {
  const events = [ev(turnId, "turn.started", { text: "完整闭环" })];
  for (const step of steps) events.push(ev(turnId, step[0], step[1]));
  return events;
}
const assistantOf = (sessionId, turnId) =>
  store.getProjectedConversation(sessionId).find((m) => m.role === "assistant" && m.turnId === turnId);

// ------------------------------------------------ killed mid-run, content kept
{
  const events = runTurn("turn_killed", [
    ["assistant.thinking.delta", { text: "先看现状，" }],
    ["assistant.thinking.delta", { text: "再修。" }],
    ["assistant.delta", { text: "定位「运行目标」" }],
    ["assistant.delta", { text: "400 根因。" }],
    ["tool.started", { id: "t1", name: "bash", input: { command: "curl :8080" }, preview: "Bash curl :8080" }],
    ["tool.done", { id: "t1", status: "done", result: "HTTP 400" }],
    ["assistant.delta", { text: "根因是连错了模型网关。" }],
    ["tool.started", { id: "t2", name: "edit", input: { file: "console.sh" }, preview: "Edit console.sh" }],
  ]);
  // Streamed in several batches, as the event bus delivers them.
  store.appendRuntimeEvents("s1", events.slice(0, 3));
  store.appendRuntimeEvents("s1", events.slice(3, 7));
  store.appendRuntimeEvents("s1", events.slice(7));
  // The app dies; on restart recovery records the ending it can prove.
  store.appendRuntimeEvents("s1", [ev("turn_killed", "turn.dispatch_outcome_unknown", { assistant: DISPATCH_OUTCOME_UNKNOWN_ASSISTANT, manualRecoveryRequired: true })]);

  const deltasLeft = store.db.get(`SELECT count(*) AS n FROM runtime_events WHERE turn_id = 'turn_killed' AND type IN ('assistant.delta','assistant.thinking.delta')`).n;
  assert.equal(deltasLeft, 0, "the live-only deltas were pruned as the turn ended — the projection is the copy that must hold");

  const answer = assistantOf("s1", "turn_killed");
  assert.equal(answer.content, "定位「运行目标」400 根因。根因是连错了模型网关。", "what streamed is what reopens, not the notice");
  assert.equal(answer.record.thinkingText, "先看现状，再修。");
  assert.deepEqual(answer.record.timeline.map((e) => `${e.kind}:${e.kind === "tool" ? e.id : e.text}`), [
    "thinking:先看现状，再修。",
    "text:定位「运行目标」400 根因。",
    "tool:t1",
    "text:根因是连错了模型网关。",
    "tool:t2",
  ], "and it reopens in the order it ran");
  const [t1, t2] = answer.record.tools;
  assert.deepEqual([t1.name, t1.status, t1.result], ["bash", "done", "HTTP 400"], "a finished step keeps its result");
  assert.equal(t2.status, "interrupted", "a step the kill cut off says so rather than 'running' forever");
  assert.equal(answer.record.notices[0]?.detail, DISPATCH_OUTCOME_UNKNOWN_ASSISTANT, "the recovery notice is shown beside the content");
  assert.equal(answer.meta.outcomeUnknown, true, "and the no-automatic-retry safety still applies");
  check("a turn killed mid-run reopens with its text, thinking and steps in order, and the notice beside them");
}

{
  // Killed before anything streamed: exactly the old behaviour.
  store.appendRuntimeEvents("s2", [
    ev("turn_empty", "turn.started", { text: "hi" }),
    ev("turn_empty", "turn.dispatch_outcome_unknown", { assistant: DISPATCH_OUTCOME_UNKNOWN_ASSISTANT }),
  ]);
  const answer = assistantOf("s2", "turn_empty");
  assert.equal(answer.content, DISPATCH_OUTCOME_UNKNOWN_ASSISTANT, "with nothing streamed, the notice is the message, as before");
  assert.equal(answer.record.notices.length, 0, "and it is not shown twice");
  check("a turn killed before it produced anything shows the recovery notice exactly as before");
}

// ------------------------------------------------ a settled turn stays small
{
  store.appendRuntimeEvents("s3", runTurn("turn_done", [
    ["assistant.delta", { text: "完成了。" }],
    ["tool.started", { id: "t9", name: "read" }],
    ["assistant.final", { assistant: "完成了。" }],
    ["turn.completed", { assistant: "完成了。", record: { turnId: "turn_done", assistantText: "完成了。" } }],
  ]));
  const row = store.db.get(`SELECT payload_json FROM turn_projection WHERE turn_id = 'turn_done'`);
  assert.equal(JSON.parse(row.payload_json).blocks, undefined, "an archived ending drops the running sequence");
  assert.equal(assistantOf("s3", "turn_done").content, "完成了。");
  check("a turn that ends with an archived record keeps no running sequence in its row");
}

// ------------------------------------------------ one write per turn per batch
{
  const steps = [];
  for (let i = 0; i < 60; i += 1) steps.push(["assistant.thinking.delta", { text: `思考${i} ` }]);
  for (let i = 0; i < 60; i += 1) steps.push(["assistant.delta", { text: `词${i} ` }]);
  const batched = runTurn("turn_batched", steps);
  const single = batched.map((event) => ({ ...event, id: `${event.id}_single`, turnId: "turn_single" }));

  const realRun = store.db.run.bind(store.db);
  let projectionWrites = 0;
  store.db.run = (sql, ...args) => {
    if (/INSERT INTO turn_projection/.test(sql)) projectionWrites += 1;
    return realRun(sql, ...args);
  };
  try {
    store.appendRuntimeEvents("s4", batched);
    assert.equal(projectionWrites, 1, `121 events in one batch write the projection once (was one write per event)`);
    projectionWrites = 0;
    for (const event of single) store.appendRuntimeEvents("s5", [event]);
    assert.equal(projectionWrites, single.length, "one event per batch still writes each time");
  } finally { store.db.run = realRun; }

  const a = store.db.get(`SELECT assistant_text, thinking_text, payload_json FROM turn_projection WHERE turn_id = 'turn_batched'`);
  const b = store.db.get(`SELECT assistant_text, thinking_text, payload_json FROM turn_projection WHERE turn_id = 'turn_single'`);
  assert.equal(a.assistant_text, b.assistant_text, "batched and unbatched projections are identical");
  assert.equal(a.thinking_text, b.thinking_text);
  assert.deepEqual(JSON.parse(a.payload_json).blocks, JSON.parse(b.payload_json).blocks);
  assert.equal(JSON.parse(a.payload_json).blocks.length, 2, "consecutive deltas of one kind are one block, not one per delta");
  check("a batch writes each turn's projection once, with the same result as event-by-event");
}

// ------------------------------------------------ the renderer keeps it too
{
  // The same rule where the live turn is still in memory (the engine died, the
  // app did not): the recovery notice used to replace everything shown so far.
  const { recoveryRecord } = await import("../src/renderer/modules/turn-recovery-projection.js");
  const live = {
    turnId: "turn_live", startedAt: 1_790_000_000_000,
    assistantText: "已定位根因，正在修复。", thinkingText: "先看日志",
    timeline: [
      { kind: "thinking", id: "think_1", text: "先看日志", status: "done" },
      { kind: "text", id: "text_1", text: "已定位根因，正在修复。", status: "streaming" },
      { kind: "tool", id: "t1", name: "edit", status: "running" },
    ],
    tools: new Map([["t1", { id: "t1", name: "edit", status: "running" }]]),
  };
  const record = recoveryRecord({ type: "turn.dispatch_outcome_unknown", turnId: "turn_live", ts: 1_790_000_060_000, payload: { assistant: "结果无法确认" } }, live);
  assert.equal(record.assistantText, "已定位根因，正在修复。", "what the live turn showed is what closes it");
  assert.deepEqual(record.timeline.map((e) => `${e.kind}:${e.status}`), ["thinking:done", "text:done", "tool:interrupted"]);
  assert.equal(record.tools[0].status, "interrupted");
  assert.equal(record.notices[0].detail, "结果无法确认", "with the notice beside it");
  const empty = recoveryRecord({ type: "turn.dispatch_outcome_unknown", turnId: "t", payload: { assistant: "结果无法确认" } }, null);
  assert.deepEqual([empty.assistantText, empty.notices.length], ["结果无法确认", 0], "and with nothing produced, the notice as before");
  check("the renderer closes a turn whose outcome became unknown with what it produced, not with the notice");
}

// ------------------------------------------------ the bus coalesces deltas only
{
  const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
  const writes = [];
  const bus = new RuntimeEventBus(() => null, {
    persistEvents: (_sessionId, events) => writes.push(events.map((e) => e.type)),
    deltaPersistWindowMs: 60_000, // long enough that only the rules below can flush it
  });
  bus.emit("s", { type: "turn.started", turnId: "t", payload: { text: "hi" } });
  for (let i = 0; i < 50; i += 1) bus.emit("s", { type: "assistant.delta", turnId: "t", payload: { text: "x" } });
  bus.emit("s", { type: "assistant.thinking.delta", turnId: "t", payload: { text: "y" } });
  assert.equal(writes.length, 1, "51 deltas are held, not written one by one");
  bus.emit("s", { type: "tool.started", turnId: "t", payload: { id: "t1", name: "bash" } });
  assert.equal(writes.length, 2, "any other event persists at once");
  assert.deepEqual(writes[1].slice(0, 2), ["assistant.delta", "assistant.delta"], "after the deltas that preceded it");
  assert.equal(writes[1].at(-1), "tool.started", "so the log keeps its order");
  assert.equal(writes[1].length, 52);
  bus.emit("s", { type: "assistant.delta", turnId: "t", payload: { text: "tail" } });
  bus.flushPersistence();
  assert.deepEqual(writes.at(-1), ["assistant.delta"], "a quit flushes what is still in the window");
  check("the bus coalesces streamed deltas, persists everything else at once and in order, and flushes on quit — with no window at all");
}

console.log(`turn-survives-kill: ok (${checks} checks)`);
