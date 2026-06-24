#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { explainContextMemory, explainMemoryItem } = require("../src/main/memory-explain.js");

const item = {
  kind: "evidence_gap",
  reason: "previous final answer lacked required evidence",
  relevance: 0.5,
  trust: "lily_evidence_memory",
  proof: false,
  sourcePointers: [{ type: "turn", turnId: "turn_1" }],
};

assert.match(explainMemoryItem(item), /evidence_gap/);
assert.match(explainMemoryItem(item), /relevance 50%/);
assert.match(explainMemoryItem(item), /not proof/);
assert.match(explainMemoryItem(item), /turn:turn_1/);

const explained = explainContextMemory({
  injected: true,
  deduped: false,
  contextEpoch: 2,
  items: [item],
  skipped: [{ kind: "project_memory", skipReason: "memory_budget_exceeded" }],
});

assert.equal(explained.injected, true);
assert.equal(explained.contextEpoch, 2);
assert.equal(explained.selected.length, 1);
assert.match(explained.skipped[0], /memory_budget_exceeded/);

console.log("memory-explain: ok");
