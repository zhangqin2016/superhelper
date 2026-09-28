#!/usr/bin/env node
/**
 * A custom model's context window is configured, learned, and kept.
 *
 * Custom presets had no field for it and a window read from an endpoint's
 * listing lived only in memory, so every compaction decision on one install
 * budgeted company models as 120,000 tokens: a 1M model compacted at 8% of
 * its window, and a 32K one would overflow before compaction ever triggered
 * (2026-09-27).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-window-learning-"));
const previous = process.env.LILY_USER_DATA_DIR;
process.env.LILY_USER_DATA_DIR = userData;

try {
  const cw = require("../src/main/model-context-window.js");

  // The preset carries it, and it reaches the engine environment.
  {
    const { normalizePresetCapabilities } = require("../src/main/model-preset-capabilities.js");
    assert.deepEqual(normalizePresetCapabilities({ vision: true, contextWindowTokens: "1000000" }), { vision: true, contextWindowTokens: 1_000_000 });
    assert.equal(normalizePresetCapabilities({ vision: true }, { contextWindowTokens: 256_000 }).contextWindowTokens, 256_000, "an update without the field keeps it");
    assert.equal(normalizePresetCapabilities({ contextWindowTokens: "" }, { contextWindowTokens: 256_000 }), null, "an explicit empty value clears it");
    assert.equal(normalizePresetCapabilities({ contextWindowTokens: 12 }), null, "an implausible value is not a window");
    const { buildCustomPresetEnv } = require("../src/main/model-preset-runtime.js");
    assert.equal(buildCustomPresetEnv({ baseUrl: "https://x/v1", capabilities: { contextWindowTokens: 256_000 } }).LILY_CONTEXT_WINDOW_TOKENS, "256000");
    assert.equal(buildCustomPresetEnv({ baseUrl: "https://x/v1", capabilities: { contextWindowTokens: 256_000 } }, { LILY_CONTEXT_WINDOW_TOKENS: "64000" }).LILY_CONTEXT_WINDOW_TOKENS, "64000", "an operator-delivered value still wins");
    check("a custom preset carries its window into the engine environment");
  }

  // A learned window survives a restart, under one key per endpoint.
  {
    cw.resetObservedContextWindowsForTests();
    cw.rememberContextWindow("https://llm.example.com/v1/", "Qwen-Flash", 256_000);
    assert.ok(fs.existsSync(path.join(userData, "model-context-windows.json")), "it is written to disk");
    cw.resetObservedContextWindowsForTests();
    assert.equal(cw.recallContextWindow("https://llm.example.com/v1", "Qwen-Flash"), 256_000, "and read back after a restart");
    assert.equal(cw.recallContextWindow("https://LLM.example.com", "Qwen-Flash"), 256_000, "a listing and the engine config spelling the base URL differently meet");
    assert.equal(cw.recallContextWindow("https://llm.example.com/v1", "other"), null, "a window belongs to its model");
    check("a learned window is kept on disk and found under any spelling of its endpoint");
  }

  // An overflow error names the limit; the request size it also quotes is ignored.
  {
    assert.equal(cw.contextWindowFromOverflowError("This model's maximum context length is 32768 tokens. However, you requested 40000 tokens"), 32_768);
    assert.equal(cw.contextWindowFromOverflowError("max_model_len (65536)"), 65_536);
    assert.equal(cw.contextWindowFromOverflowError("Input length exceeds the context window of 131,072 tokens"), 131_072);
    assert.equal(cw.contextWindowFromOverflowError("请求超过最大上下文长度 262144"), 262_144);
    assert.equal(cw.contextWindowFromOverflowError("500 internal server error"), 0, "an unrelated error teaches nothing");
    check("the model's limit is read from the overflow errors providers write");
  }

  {
    cw.resetObservedContextWindowsForTests();
    const raw = "This model's maximum context length is 32768 tokens.";
    assert.equal(cw.learnFromOverflowFailure({ classified: { code: "RATE_LIMITED" }, raw, baseUrl: "https://gw.example.com/v1", modelId: "small" }), 0, "only an overflow teaches");
    const warn = console.warn; console.warn = () => {};
    try {
      assert.equal(cw.learnFromOverflowFailure({ classified: { code: "CONTEXT_LIMIT" }, raw, baseUrl: "https://gw.example.com/v1", modelId: "small" }), 32_768);
    } finally { console.warn = warn; }
    assert.equal(cw.recallContextWindow("https://gw.example.com/v1", "small"), 32_768, "and the next budget uses it");
    check("a context-overflow failure teaches the model's real window");
  }

  // The runner's visible-failure path does the learning.
  {
    cw.resetObservedContextWindowsForTests();
    const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
    const runner = new OpencodeAgentSession("s-window", { createServer: () => ({}) });
    runner.spawnOptions = { modelRouteAudit: { baseUrl: "https://gw2.example.com/v1" }, model: { modelID: "tiny" }, env: {} };
    const warn = console.warn; console.warn = () => {};
    try { runner._invalidateEngineSessionAfterVisibleFailure("This model's maximum context length is 16384 tokens.", null); }
    catch { /* the rest of the failure path is not under test */ }
    finally { console.warn = warn; }
    assert.equal(cw.recallContextWindow("https://gw2.example.com/v1", "tiny"), 16_384, "a visible overflow on a runner teaches its model's window");
    check("the runner learns from its own overflow failures");
  }
  // The context-window guard's budget follows the same window the engine
  // config and compaction use — a learned one included, not the env alone.
  {
    cw.resetObservedContextWindowsForTests();
    process.env.OPENCODE_BIN = process.execPath;
    const spawnEnv = require("../src/main/spawn-env.js");
    const env = { LILY_MODEL: "learned-model", LILY_API_BASE_URL: "https://gw3.example.com/v1", LILY_API_KEY: "fixture" };
    spawnEnv.resolveLilyEnv = () => ({ ...env });
    const { SessionRunnerPool } = require("../src/main/session-runner-pool.js");
    const budgetFor = () => {
      const pool = new SessionRunnerPool();
      pool._opencodeMcpServers = () => ({}); pool._opencodePlugins = () => []; pool._opencodeGuideContent = () => "";
      const info = console.info; console.info = () => {};
      try { return pool.ensure("s-guard", userData, {}, { lazy: true }).spawnOptions; } finally { console.info = info; }
    };
    const unknown = budgetFor();
    assert.equal(unknown.model.contextWindowTokens, null, "an unknown window is not replaced by a guess");
    assert.equal(unknown.env.LILY_CONTEXT_TOKEN_BUDGET, undefined, "so the guard gets no whole-request budget to trim toward");
    cw.rememberContextWindow("https://gw3.example.com/v1", "learned-model", 32_768);
    const learned = budgetFor();
    assert.equal(learned.model.contextWindowTokens, 32_768, "the engine config carries the learned window");
    assert.equal(learned.model.contextWindowSource, "listing", "and says where it came from");
    const limit = Number(learned.env.LILY_CONTEXT_TOKEN_BUDGET);
    assert.ok(limit > 32_768 * 0.8 && limit < 32_768, `the guard's budget is the model's real input limit, window minus output reserve: ${limit}`);
    check("the context-window guard budgets against the learned window, and against nothing when none is known");
  }
} finally {
  if (previous === undefined) delete process.env.LILY_USER_DATA_DIR; else process.env.LILY_USER_DATA_DIR = previous;
  fs.rmSync(userData, { recursive: true, force: true });
}

// 2026-09-28 audit: only wording about the INPUT not fitting is an overflow.
// Parameter errors ("max_tokens is too large", a tool name over 64 chars)
// used to classify as CONTEXT_LIMIT and teach a tiny window.
{
  const { classifyAssistantError } = require("../src/main/agent-runner.js");
  for (const text of ["max_tokens: 65536 > 32768 output tokens", "tool name exceeds maximum length of 64", "400 max_tokens is too large: 100000"]) {
    assert.notEqual(classifyAssistantError(text)?.code, "CONTEXT_LIMIT", `a parameter error is not a context overflow: ${text}`);
  }
  for (const text of [
    "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576)",
    "Range of input length should be [1, 30720]",
    "Your request exceeded model token limit: 262144",
    "context_length_exceeded",
    "413 Request Entity Too Large",
  ]) {
    assert.equal(classifyAssistantError(text)?.code, "CONTEXT_LIMIT", `each provider's overflow wording is still an overflow: ${text}`);
  }
}

console.log(`model-context-window-learning: ok (${checks} checks)`);
