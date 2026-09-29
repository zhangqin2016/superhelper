#!/usr/bin/env node
// "The input does not fit" has ONE list, based on the engine's own
// (opencode/packages/llm/src/provider-error.ts). A hand-written list that
// replaced the old broad patterns missed vLLM's overflow wording, so a long
// task on a self-hosted model failed as an unknown error instead of compacting
// and retrying (2026-09-29 re-review). Parameter errors must still never read
// as overflow — they taught the model a tiny window (2026-09-28).
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wording = require("../src/main/runtime/context-overflow-wording.js");
const { classifyAssistantError } = require("../src/main/agent-runner.js");

// 1. The engine's list, read from the vendored source, is exactly ours.
{
  const source = fs.readFileSync(new URL("../opencode/packages/llm/src/provider-error.ts", import.meta.url), "utf8");
  const block = (source.match(/const patterns = \[([\s\S]*?)\n\]/) || [])[1] || "";
  const engine = block.split("\n").map((line) => line.trim().replace(/,$/, "")).filter((line) => line.startsWith("/"));
  assert.ok(engine.length >= 20, `fixture: the engine's pattern list was found (${engine.length})`);
  assert.deepEqual(wording.ENGINE_PATTERNS.map(String), engine, "ENGINE_PATTERNS follows the vendored engine list — resync after an engine upgrade");
  const exclusions = ((source.match(/const exclusions = \[([^\n]*)\]/) || [])[1] || "").split(/,\s*(?=\/)/).map((s) => s.trim());
  assert.deepEqual(wording.ENGINE_EXCLUSIONS.map(String), exclusions, "and its exclusions");
}

const isOverflow = (text) => classifyAssistantError(text)?.code === "CONTEXT_LIMIT";

// 2. Real provider overflow messages are all recognised.
const overflow = [
  "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens (139000 in the messages, 1000 in the completion).", // DeepSeek / OpenAI
  "prompt is too long: 210000 tokens > 200000 maximum", // Anthropic
  "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).", // Gemini
  "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 129024]", // DashScope
  "Invalid request: Your request exceeded model token limit: 8192", // Moonshot
  "ValueError: The decoder prompt (length 5951) is longer than the maximum model length of 4096. Make sure that `max_model_len` is no smaller than the number of text tokens.", // vLLM V0
  "Prompt length of 40000 is longer than the maximum model length of 32768.", // vLLM V1
  "the request exceeds the available context size, try increasing it", // llama.cpp
  "context window exceeds limit", // MiniMax
  "Error code: 400 - {'error': {'code': 'context_length_exceeded'}}", // Azure / Groq
  "413 Request Entity Too Large",
];
for (const text of overflow) assert.ok(isOverflow(text), `recognised as overflow: ${text}`);

// 3. Parameter and rate-limit errors are not overflow.
const notOverflow = [
  "max_tokens is too large: 100000. This model supports at most 8192 completion tokens, whereas you provided 100000.",
  "Invalid 'tools[0].function.name': string too long. Expected a string with maximum length 64, but got a string with length 72 instead.",
  "Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000.",
  "RateLimitExceeded.EndpointTPMExceeded: The Tokens Per Minute (TPM) limit of the associated endpoint for your account has been exceeded.",
  "429 Too Many Requests",
  "Rate limit exceeded: too many tokens per minute, retry after 20s", // overflow wording inside a rate limit
];
for (const text of notOverflow) assert.ok(!isOverflow(text), `not overflow: ${text}`);

console.log("context-overflow-wording: ok");
