#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  legacyLiveTurnFromMessage,
  liveTurnFromRecord,
} from "../src/renderer/modules/turn-live-turn-adapter.js";
import {
  legacyLiveTurnFromMessage as compatLegacyLiveTurnFromMessage,
  liveTurnFromRecord as compatLiveTurnFromRecord,
} from "../src/renderer/modules/turn-view-model.js";

const legacyTurn = legacyLiveTurnFromMessage({
  id: "msg_1",
  timestamp: "2026-07-07T12:00:00.000Z",
  content: "legacy answer",
  meta: { terminal: "turn.interrupted", taskRun: { status: "interrupted" } },
});
assert.equal(legacyTurn.turnId, "msg_1");
assert.equal(legacyTurn.phase, "done");
assert.equal(legacyTurn.final.type, "turn.interrupted");
assert.equal(legacyTurn.final.payload.assistant, "legacy answer");
assert.equal(legacyTurn.taskRun.status, "interrupted");
assert.equal(legacyTurn.permissions instanceof Map, true);
assert.equal(legacyTurn.finalRendered, false);
assert.equal(compatLegacyLiveTurnFromMessage({ id: "msg_2", content: "x" }).turnId, "msg_2");

const failedLegacy = legacyLiveTurnFromMessage({ id: "failed", failed: true, content: "failed answer" });
assert.equal(failedLegacy.final.type, "turn.failed");

const recordTurn = liveTurnFromRecord({
  turnId: "record_1",
  assistantText: "record answer",
  thinkingText: "thinking",
  terminal: "turn.completed",
  tools: [{ id: "tool_1", name: "Read", status: "done" }],
  processEvents: [{ payload: { detail: "event" } }],
  notices: [{ code: "notice" }],
  meta: { taskRun: { status: "completed" }, memoryUsage: { used: true, count: 2, mode: "semantic", items: [] } },
  startedAt: 10,
  endedAt: 20,
});
assert.equal(recordTurn.turnId, "record_1");
assert.equal(recordTurn.tools.get("tool_1").name, "Read");
assert.equal(recordTurn.processEvents[0].type, "process.event");
assert.equal(recordTurn.notices[0].type, "engine.notice");
assert.equal(recordTurn.taskRun.status, "completed");
assert.equal(recordTurn.memoryUsage?.count, 2, "memoryUsage round-trips from record.meta for the memory chip");
assert.equal(recordTurn.final.ts, 20);
assert.equal(liveTurnFromRecord({ turnId: "r3", tools: [] }).memoryUsage, null, "absent memoryUsage → null (chip hidden)");
assert.equal(compatLiveTurnFromRecord({ turnId: "record_2", tools: [] }).turnId, "record_2");

const viewModelSource = readFileSync(
  new URL("../src/renderer/modules/turn-view-model.js", import.meta.url),
  "utf8",
);
assert.match(viewModelSource, /from "\.\/turn-live-turn-adapter\.js"/);
assert.doesNotMatch(viewModelSource, /function legacyLiveTurnFromMessage\s*\(/);
assert.doesNotMatch(viewModelSource, /function liveTurnFromRecord\s*\(/);

console.log("turn-live-turn-adapter: ok");
