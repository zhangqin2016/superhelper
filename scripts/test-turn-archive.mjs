#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TurnArchive } = require("../src/main/turn-archive.js");

const pushed = [];
const sessionManager = {
  pushMessageTo(sessionId, role, content, files, extra) {
    pushed.push({ sessionId, role, content, files, extra });
  },
  findById() {
    return { id: "s1", projectId: "p1" };
  },
  pm: {
    find() {
      return { path: process.cwd() };
    },
  },
};

const archive = new TurnArchive(sessionManager);
const { estimateTokensForText } = require("../src/main/context-budget-manager.js");
const engineText = "测试模型的上下文统计".repeat(20);
const modelRecord = archive.buildRecord({
  sessionId: "s1", turnId: "turn_model_receipt", assistantText: "done",
  enginePayload: { text: engineText, model: { providerID: "anthropic", modelID: "claude-example" } },
}, "turn.completed");
assert.equal(modelRecord.meta.engine.estimatedPromptTokens,
  estimateTokensForText(engineText, { provider: "anthropic", model: "claude-example" }).tokens,
  "per-turn model references must retain provider-aware token estimates");
// The skill audit's candidates are the router's recommendation for this turn,
// carried on the engine trace (2026-09-25).
{
  const auditModule = require("../src/main/skill-usage-audit.js");
  const original = auditModule.buildSkillUsageAudit;
  const seen = [];
  auditModule.buildSkillUsageAudit = (input) => { seen.push(input.recommendedSkillIds); return { candidateSource: Array.isArray(input.recommendedSkillIds) ? "router" : "token_overlap" }; };
  try {
    const routed = archive.buildRecord({
      sessionId: "s1", turnId: "turn_routed", assistantText: "done",
      enginePayload: { text: "x", trace: { capabilityContext: { injected: true, recommendedSkillIds: ["lily-coding-core"] } } },
    }, "turn.completed");
    assert.deepEqual(seen[0], ["lily-coding-core"], "the archive hands the audit the router's recommendation");
    assert.equal(routed.meta.skillUsageAudit.candidateSource, "router");
    archive.buildRecord({ sessionId: "s1", turnId: "turn_plain", assistantText: "done", enginePayload: { text: "x" } }, "turn.completed");
    assert.equal(seen[1], null, "a turn without routing hands none, and the audit keeps its previous guess");
  } finally {
    auditModule.buildSkillUsageAudit = original;
  }
}
archive.commit("s1", {
  turnId: "turn_opencode",
  sessionId: "s1",
  terminal: "turn.completed",
  assistantText: "OpenCode answer",
  engineMessageId: "msg_engine_1",
  meta: { terminal: "turn.completed" },
});

assert.equal(pushed.length, 1);
assert.equal(pushed[0].content, "OpenCode answer", "legacy fallback text is retained");
assert.equal(pushed[0].extra.record.engineMessageId, "msg_engine_1");
assert.equal(pushed[0].extra.meta.canonicalSource, "opencode");
assert.equal(pushed[0].extra.meta.lilyStorageRole, "metadata");
assert.equal(pushed[0].extra.record.meta.canonicalSource, "opencode");
assert.equal(pushed[0].extra.record.meta.lilyStorageRole, "metadata");

archive.commit("s1", {
  turnId: "turn_legacy",
  sessionId: "s1",
  terminal: "turn.completed",
  assistantText: "Legacy answer",
  meta: { terminal: "turn.completed" },
});

assert.equal(pushed.length, 2);
assert.equal(pushed[1].extra.meta.canonicalSource, undefined, "non-OpenCode turns stay canonical in Lily fallback store");

// The engine reported durationMs: 0 for every turn of a real session, including
// one with 20 tool calls and 42 s of visible thinking, so a record that trusted
// it alone said the turn took no time at all. Both ends of the turn are already
// in the record; there is no reason to store nothing.
{
  const archive = new TurnArchive({});
  const state = () => ({
    turnId: "t-duration", sessionId: "s", startedAt: Date.now() - 42_000,
    tools: new Map(), timeline: [], assistantText: "x", contentBlocks: [], fileChanges: [],
  });
  const measured = archive.buildRecord(state(), "turn.completed", { durationMs: 0 }).durationMs;
  assert.ok(measured >= 41_000 && measured <= 45_000, `a zero from the engine falls back to the turn's own clock: ${measured}`);
  assert.equal(archive.buildRecord(state(), "turn.completed", { durationMs: 1234 }).durationMs, 1234, "a real engine number still wins");
  const noStart = archive.buildRecord({ ...state(), startedAt: undefined }, "turn.completed", {}).durationMs;
  assert.ok(Number.isFinite(noStart) && noStart >= 0, "and a turn with no recorded start still reports a number, never a negative one");
  console.log("ok - a turn's duration is its own clock when the engine reports none");
}

console.log("turn-archive: ok");
