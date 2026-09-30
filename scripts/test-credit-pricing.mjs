#!/usr/bin/env node
// Lily credits (积分): per-model, three-way pricing. [gate: lily-credits]
import assert from "node:assert/strict";
import { CREDITS_PER_YUAN, FALLBACK_RATE, creditRateFor, creditsForUsage, reserveCredits, LEGACY_CREDITS_PER_MILLION_TOKENS } from "../server/src/services/credit-pricing.js";
import { scanRealTokenUsage, realTokenSplit } from "../server/src/services/model-gateway/usage.js";

assert.equal(CREDITS_PER_YUAN, 1000);
const flash = creditRateFor({ metadata: { creditsPerMillion: { inputCached: 60, input: 2900, output: 11500 } } });
const pro = creditRateFor({ metadata: { creditsPerMillion: { inputCached: 450, input: 13000, output: 39000 } } });
assert.equal(flash.fallback, false);

// A missing or broken rate is charged as the most expensive model — never free.
for (const rule of [null, {}, { metadata: {} }, { metadata: { creditsPerMillion: { input: "x", output: 1 } } }]) {
  assert.deepEqual({ ...creditRateFor(rule), fallback: undefined }, { ...FALLBACK_RATE, fallback: undefined });
}

// A typical agent turn: 50k input (80% cached) + 1k output.
const turn = { cachedInputTokens: 40000, inputTokens: 10000, outputTokens: 1000 };
assert.equal(creditsForUsage(turn, flash), Math.ceil((40000 * 60 + 10000 * 2900 + 1000 * 11500) / 1e6)); // 43 credits ≈ ¥0.043
assert.equal(creditsForUsage(turn, pro), Math.ceil((40000 * 450 + 10000 * 13000 + 1000 * 39000) / 1e6)); // 187
assert.ok(creditsForUsage(turn, pro) > 4 * creditsForUsage(turn, flash), "different models consume at different speeds");
assert.equal(creditsForUsage({ outputTokens: 1 }, flash), 1, "rounded up: a request is never free");
assert.equal(creditsForUsage({}, flash), 0);

// The reservation is the cheapest reading of the input and at least 1.
assert.equal(reserveCredits(50000, flash), Math.ceil(50000 * 60 / 1e6));
assert.equal(reserveCredits(0, flash), 1);
assert.ok(reserveCredits(50000, pro) <= creditsForUsage({ ...turn, outputTokens: 0 }, pro), "never above the real charge for the same input");

// Cached tokens are counted once, whichever wire format reported them.
const openai = realTokenSplit(scanRealTokenUsage(`data: {"usage":{"prompt_tokens":50000,"completion_tokens":1000,"prompt_cache_hit_tokens":40000}}`));
const anthropic = realTokenSplit(scanRealTokenUsage(`data: {"usage":{"output_tokens":1000}}`,
  scanRealTokenUsage(`data: {"message":{"usage":{"input_tokens":10000,"cache_read_input_tokens":40000,"cache_creation_input_tokens":0}}}`)));
assert.deepEqual(openai, turn); assert.deepEqual(anthropic, turn);
const noCache = realTokenSplit(scanRealTokenUsage(`{"usage":{"prompt_tokens":1200,"completion_tokens":30}}`));
assert.deepEqual(noCache, { cachedInputTokens: 0, inputTokens: 1200, outputTokens: 30 });

assert.equal(LEGACY_CREDITS_PER_MILLION_TOKENS, 1600);
console.log("credit pricing: ok");
