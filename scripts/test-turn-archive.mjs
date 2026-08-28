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

console.log("turn-archive: ok");
