#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  formatTokenCount,
  summarizeTurnUsage,
} from "../src/renderer/modules/turn-usage-summary.js";

assert.deepEqual(summarizeTurnUsage({ estimatedTokens: 203 }), {
  input: 0,
  output: 0,
  total: 203,
});

assert.deepEqual(summarizeTurnUsage({ usage: { output_tokens: 5, input_tokens: 12 } }), {
  input: 12,
  output: 5,
  total: 17,
});

assert.deepEqual(summarizeTurnUsage({
  usage: {
    "claude-sonnet": { inputTokens: 123, outputTokens: 48 },
    "claude-haiku": { inputTokens: 7, outputTokens: 2 },
  },
}), {
  input: 130,
  output: 50,
  total: 180,
});

assert.equal(formatTokenCount(8420), "8.4k");
assert.equal(formatTokenCount(180), "180");

console.log("turn-usage-summary: ok");
