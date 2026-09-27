#!/usr/bin/env node
/**
 * A context window is known or honestly unknown, and an overflow is answered
 * by compaction — never by trimming what the model is asked, never by
 * discarding the conversation.
 *
 * Field case 2026-09-27: an unknown window was budgeted as 120,000. A 1M model
 * then had every request trimmed by the context-window guard — down to the
 * question in the user's own message, which the model answered by resuming the
 * previous task. Meanwhile the engine already compacts on the provider's
 * overflow report, and Lily failed the turn on that report; a visible overflow
 * discarded the engine session.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };
const quiet = async (fn) => {
  const saved = [console.warn, console.info, console.log];
  console.warn = console.info = () => {};
  try { return await fn(); } finally { [console.warn, console.info] = saved; }
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-overflow-"));
const previousUserData = process.env.LILY_USER_DATA_DIR;
process.env.LILY_USER_DATA_DIR = userData;

try {
  const cw = require("../src/main/model-context-window.js");
  const budgetManager = require("../src/main/context-budget-manager.js");

  // ------------------------------------------------ the window, and its source
  {
    cw.resetObservedContextWindowsForTests();
    assert.deepEqual(cw.resolveContextWindow({ configured: "256000", baseUrl: "https://a/v1", modelId: "deepseek-v4-pro" }), { tokens: 256_000, source: "configured" });
    assert.deepEqual(cw.resolveContextWindow({ baseUrl: "https://a/v1", modelId: "deepseek-v4-pro" }), { tokens: 1_000_000, source: "catalog" }, "a catalogued model id is known");
    assert.equal(cw.resolveContextWindow({ modelId: "/private/Qwen3-Next-80B-A3B-Instruct" }).source, "unknown", "a self-hosted path is not matched by a resembling name");
    assert.deepEqual(cw.resolveContextWindow({ modelId: "Qwen3.8-Flash-Next-FP8" }), { tokens: 0, source: "unknown" }, "and an uncatalogued model is unknown, not a guess");
    cw.rememberContextWindow("https://a/v1", "deepseek-v4-pro", 131_072, "overflow");
    assert.deepEqual(cw.resolveContextWindow({ baseUrl: "https://a", modelId: "deepseek-v4-pro" }), { tokens: 131_072, source: "learned_overflow" }, "what this endpoint taught beats the catalog");
    check("a window is configured, learned, catalogued — or unknown, and says which");
  }

  {
    cw.resetObservedContextWindowsForTests();
    const quietLearn = (args) => { const w = console.warn; console.warn = () => {}; try { return cw.learnFromOverflowFailure(args); } finally { console.warn = w; } };
    const overflow = { code: "CONTEXT_LIMIT" };
    assert.equal(quietLearn({ classified: overflow, raw: "413 no body", baseUrl: "https://g", modelId: "m", acceptedTokens: 0 }), 0, "an overflow naming nothing, with nothing accepted, teaches nothing");
    assert.equal(quietLearn({ classified: overflow, raw: "input too long", baseUrl: "https://g", modelId: "m", acceptedTokens: 90_000 }), 90_000, "one naming no limit is bounded by the largest accepted request");
    assert.deepEqual(cw.resolveContextWindow({ baseUrl: "https://g", modelId: "m" }), { tokens: 90_000, source: "learned_ceiling" });
    assert.equal(cw.observeAcceptedRequest("https://g", "m", 95_000), 95_000, "a larger request that succeeds raises the ceiling");
    assert.equal(cw.observeAcceptedRequest("https://g", "m", 80_000), 0, "a smaller one does not lower it");
    assert.equal(quietLearn({ classified: overflow, raw: "maximum context length is 98304 tokens", baseUrl: "https://g", modelId: "m", acceptedTokens: 95_000 }), 98_304, "a stated limit replaces the ceiling");
    assert.equal(cw.observeAcceptedRequest("https://g", "m", 99_000), 0, "and a stated window is not moved by usage");
    cw.resetObservedContextWindowsForTests();
    assert.equal(cw.recallContextWindow("https://g", "m"), 98_304, "the source survives a restart with the window");
    check("an overflow teaches the stated limit, else a ceiling that rises with later successes");
  }

  // -------------------------------------------------------------- the budget
  {
    const unknown = budgetManager.resolveContextBudget({});
    assert.deepEqual([unknown.contextWindowTokens, unknown.usableInputTokens, unknown.budgetSource], [null, null, "unknown"], "unknown is not 120,000");
    const decide = (sessionSummary, contextWindowTokens) => budgetManager.decidePreTurnCompaction({
      capabilities: { nativeCompaction: true }, model: { providerID: "p", modelID: "m", contextWindowTokens },
      runner: { alive: true, canStart: true }, sessionSummary, currentPromptTokens: 500_000, currentPromptTokenSource: "runtime_usage",
    });
    assert.equal(decide({}, undefined).reason, "window_unknown", "no pressure is invented for an unknown window");
    const at = new Date().toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();
    assert.deepEqual([decide({ lastContextOverflowAt: at, lastCompactedAt: recent }, undefined).action, decide({ lastContextOverflowAt: at }, undefined).reason], ["compact", "context_overflow"],
      "but a recorded overflow compacts first — window unknown and a compaction a minute ago notwithstanding");
    assert.equal(decide({ lastContextOverflowAt: recent, lastCompactedAt: at, turnCount: 1 }, undefined).reason, "recently_compacted", "a compaction after the overflow resolves it");
    const background = budgetManager.decideBackgroundCompaction({ capabilities: { nativeCompaction: true }, model: {}, runner: { alive: true }, sessionSummary: { lastContextOverflowAt: at, turnCount: 1 } });
    assert.equal(background.reason, "context_overflow", "and so does the background pass");
    check("an unknown window makes no pressure decision; a recorded overflow always compacts next");
  }

  // --------------------------------------------------------------- the guard
  const pluginUrl = pathToFileURL(path.resolve("resources/opencode-plugins/context-window-guard.js")).href;
  const guardWith = async (budget, tag) => {
    process.env.LILY_CONTEXT_TOKEN_BUDGET = budget ? String(budget) : "";
    const hooks = await (await import(`${pluginUrl}?${tag}`)).ContextWindowGuardPlugin({});
    process.env.LILY_CONTEXT_TOKEN_BUDGET = "";
    return hooks["experimental.chat.messages.transform"];
  };
  const tool = (i, chars) => ({ info: { role: "assistant", sessionID: "ses_g" }, parts: [{ type: "tool", tool: "read", callID: `c${i}`, state: { status: "completed", input: { path: `/f${i}` }, output: "x".repeat(chars) } }] });
  const asciiTokens = (s) => Math.ceil(s.length * 0.28);
  {
    const transform = await guardWith(0, "unknown");
    const msgs = [{ info: { role: "user" }, parts: [{ type: "text", text: "q" }] }, ...Array.from({ length: 60 }, (_, i) => tool(i, 40_000))];
    const before = JSON.stringify(msgs);
    await transform({}, { messages: msgs });
    assert.equal(JSON.stringify(msgs), before, "without a known window, a large session of ordinary parts reaches the model untouched");
    const blob = [tool(0, 2_000_000)];
    await transform({}, { messages: blob });
    assert.ok(blob[0].parts[0].state.output.length < 60_000, "while a single giant part is still bounded — the deadlock breaker stays");
    check("an unknown window trims nothing but single oversized parts");
  }
  {
    // Chinese text estimates at ~1 token per character; the engine reported
    // what the provider actually counted. Under the limit is under the limit.
    const transform = await guardWith(100_000, "reported");
    const msgs = [{ info: { role: "user" }, parts: [{ type: "text", text: "总结" }] }];
    for (let i = 0; i < 8; i += 1) msgs.push({ info: { role: "assistant", sessionID: "ses_r" }, parts: [{ type: "text", text: "中".repeat(15_000) }] });
    msgs[msgs.length - 1].info.tokens = { input: 70_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } };
    const before = JSON.stringify(msgs);
    await transform({}, { messages: msgs });
    assert.equal(JSON.stringify(msgs), before, "a 120,000-estimate history the engine measured at 71,000 is not trimmed against a 100,000 limit");
    check("the guard measures with the engine's reported usage, not a character estimate");
  }
  {
    const transform = await guardWith(100_000, "over");
    const history = Array.from({ length: 20 }, (_, i) => tool(i, 10_000));
    history[19].info.tokens = { input: 88_000, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } };
    const question = { info: { role: "user", sessionID: "ses_g" }, parts: [{ type: "text", text: `<lily_layer title="platform_context">${"p".repeat(20_000)}</lily_layer><lily_layer title="user_original_request">新问题</lily_layer>` }] };
    const fresh = tool(99, 150_000);
    const msgs = [...history, question, fresh];
    const questionText = question.parts[0].text;
    await transform({}, { messages: msgs });
    assert.equal(question.parts[0].text, questionText, "the question being asked is never trimmed");
    assert.ok(history.every((m) => m.parts[0].state.output.length === 10_000), "history is trimmed only as far as needed — here not at all");
    const sent = fresh.parts[0].state.output.length;
    assert.ok(sent < 48_000 && sent > 12_000, `the oversized new output gives up just what the limit needs: ${sent} chars`);
    const reported = 90_000;
    const after = asciiTokens(fresh.parts[0].state.output) + asciiTokens(questionText);
    assert.ok(reported + after <= 100_000 && reported + after > 97_000, `the request lands just under the limit (${reported + after}), where the usage report makes compaction fire next`);
    check("over a known limit the guard trims just enough, largest first, and never the request");
  }

  // ------------------------------------------------------------ the engine
  {
    const { reduceOpencodeRuntimeEvent, createOpencodeRuntimeState } = require("../src/main/runtime/opencode-runtime-reducer.js");
    const state = createOpencodeRuntimeState();
    const result = reduceOpencodeRuntimeEvent({
      type: "message.updated",
      properties: { info: { id: "msg_c", role: "assistant", agent: "compaction", summary: true, error: { name: "ContextOverflowError", data: { message: "Conversation history too large to compact - exceeds model context limit" } } } },
    }, state);
    const effect = result.effects.find((e) => e.kind === "error");
    assert.ok(effect?.compactionFailed, "a summary that did not fit ends the turn as an overflow, not as an empty answer");
    assert.equal(require("../src/main/agent-runner.js").classifyAssistantError(effect.message)?.code, "CONTEXT_LIMIT");
    check("a failed compaction is reported as the overflow it is");
  }

  const recovery = require("../src/main/context-overflow-recovery.js");
  const runnerStub = (overrides = {}) => ({
    sessionId: "s-overflow",
    spawnOptions: { modelRouteAudit: { baseUrl: "https://gw.example.com/v1" }, model: { modelID: "small" }, env: {} },
    activeEngineConfig: () => JSON.stringify({ compaction: { auto: true } }),
    ...overrides,
  });
  {
    cw.resetObservedContextWindowsForTests();
    const engineOverflow = { kind: "error", message: "This model's maximum context length is 65536 tokens.", cause: { name: "ContextOverflowError", data: { message: "This model's maximum context length is 65536 tokens." } } };
    assert.equal(await quiet(() => recovery.absorbEngineOverflow(runnerStub(), engineOverflow)), true, "an overflow the engine compacts away itself is not the turn's failure");
    assert.equal(cw.recallContextWindow("https://gw.example.com", "small"), 65_536, "and it teaches the window");
    assert.equal(recovery.absorbEngineOverflow(runnerStub({ activeEngineConfig: () => JSON.stringify({ compaction: { auto: false } }) }), engineOverflow), false, "unless the engine was told not to compact");
    assert.equal(recovery.absorbEngineOverflow(runnerStub(), { ...engineOverflow, compactionFailed: true }), false, "and a compaction that itself overflowed is a failure");
    assert.equal(recovery.absorbEngineOverflow(runnerStub(), { kind: "error", message: "rate limited", cause: { name: "APIError" } }), false, "other errors are untouched");

    // Through the real runner's effect switch.
    const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
    const runner = new OpencodeAgentSession("s-real", { createServer: () => ({}) });
    Object.assign(runner, runnerStub({ sessionId: "s-real" }));
    runner.activeEngineConfig = () => JSON.stringify({});
    let failed = 0;
    runner._failTurn = () => { failed += 1; return false; };
    await quiet(() => runner._handleEffect(engineOverflow));
    assert.equal(failed, 0, "the runner keeps the turn open while the engine compacts");
    await quiet(() => runner._handleEffect({ ...engineOverflow, compactionFailed: true }));
    assert.equal(failed, 1, "and fails it when the compaction could not fit");
    await quiet(() => runner._handleEffect({ kind: "usage", usage: { input_tokens: 40_000, cache_read_input_tokens: 10_000, output_tokens: 500 } }));
    assert.equal(runner._contextHighWater, 50_500, "accepted request sizes are tracked for the next overflow");
    check("the engine's own overflow compaction is let through, and learnt from");
  }

  {
    const memory = require("../src/main/session-memory.js");
    const policy = require("../src/main/opencode-session-failure-policy.js");
    const overflow = { code: "CONTEXT_LIMIT" };
    const raw = "input length exceeds the context window";
    const runner = runnerStub({ sessionId: "s-visible", _contextHighWater: 60_000 });
    const first = await quiet(() => recovery.onVisibleFailure(runner, overflow, raw));
    assert.deepEqual([first.keepConversation, first.learned], [true, 60_000], "a visible overflow keeps the conversation and learns a ceiling");
    assert.equal(policy.shouldDropResumeAfterVisibleFailure({ classified: overflow, raw, keepConversationAfterOverflow: first.keepConversation }), false, "so the engine session is not discarded");
    assert.equal(recovery.retryReady("s-visible"), true, "and the turn may be retried once");
    const second = await quiet(() => recovery.onVisibleFailure(runner, overflow, raw));
    assert.equal(second.keepConversation, false, "an overflow that nothing compacted since falls back to a fresh session");
    assert.equal(policy.shouldDropResumeAfterVisibleFailure({ classified: overflow, raw, keepConversationAfterOverflow: second.keepConversation }), true);
    assert.equal(recovery.retryReady("s-visible"), false, "and is not retried again");
    memory.markSessionCompacted("s-visible", {});
    assert.equal(recovery.retryReady("s-visible"), false, "a compaction resolves the overflow");
    assert.equal((await quiet(() => recovery.onVisibleFailure(runner, overflow, raw))).keepConversation, true, "so a later overflow is again a first one");
    assert.equal(recovery.onVisibleFailure(runner, overflow, "413 request entity too large").keepConversation, false, "an upload too large for the gateway keeps its own path");
    assert.equal(recovery.preferCompactionOverReplay({ _pendingPromptPayload: { files: [] } }, overflow, raw), true, "a same-turn replay into a blank session is not used for a conversation overflow");
    assert.equal(recovery.preferCompactionOverReplay({ _pendingPromptPayload: { files: [{ path: "/a.pdf" }] } }, overflow, raw), false, "but attachments still get the manifest replay");
    check("a visible overflow keeps the conversation once, then falls back; a compaction resets it");
  }

  {
    // The retry, as the orchestrator runs it after the failure above.
    const memory = require("../src/main/session-memory.js");
    const rescue = require("../src/main/tool-call-rescue.js");
    const { createTurnRecoveryRuntime } = require("../src/main/turn-recovery-runtime.js");
    const sessionId = "s-retry";
    await quiet(() => recovery.onVisibleFailure(runnerStub({ sessionId }), { code: "CONTEXT_LIMIT" }, "maximum context length is 32768 tokens"));
    const sent = [];
    const state = { turnId: null, queue: [], wasRescueAttempt: false, tools: new Map([["t1", { id: "t1", name: "write", status: "done", input: { filePath: "a.md" } }]]) };
    const runtime = createTurnRecoveryRuntime({
      ctx: { sessionManager: { findById: (id) => ({ id }), getTurnInputByTurnId: (sid, turnId) => ({ sessionId: sid, turnId, userText: "整理报告" }), getLastUserMessage: () => ({ role: "user", content: "整理报告" }) }, runnerPool: { get: () => ({ isBusy: () => false }) } },
      transcriptStore: { removeLastAssistantMessage() {}, supersedeAssistantTurn: async () => ({ ok: true }) },
      getState: () => state,
      sendUserMessage: async (sid, content, files, opts) => { sent.push({ content, opts }); return { ok: true, turnId: "turn_retry" }; },
      attemptRescue: (sid, failure) => runtime.maybeToolCallRescueRetry(sid, failure),
      sleep: async () => {},
    });
    rescue.resetRescueStateForTests();
    await quiet(() => runtime.maybeSelfHealAndRetry(sessionId, { code: "CONTEXT_LIMIT", retryable: false, sourceTurnId: "turn_src" }));
    assert.equal(sent.length, 1, "a kept overflow is retried although the code is not retryable");
    assert.equal(sent[0].opts.skipPreflight, false, "on a runner rebuilt with the window the overflow taught");
    assert.equal(sent[0].opts.recovery.mode, "continuation", "continuing — the turn had already written a file");
    assert.equal(sent[0].opts.recovery.objective, "整理报告", "with the user's request carried along");
    assert.equal(budgetManager.unresolvedContextOverflow(memory.readSessionSummary(sessionId)), true, "and the overflow still on record, so that turn compacts first");
    rescue.resetRescueStateForTests();
    await quiet(() => runtime.maybeSelfHealAndRetry("s-never-overflowed", { code: "CONTEXT_LIMIT", retryable: false }));
    assert.equal(sent.length, 1, "an overflow that was not kept is not retried");
    assert.match(runtime.rescueRetryNotice(sessionId, true, "CONTEXT_LIMIT"), /上下文窗口/, "and a failed retry says what happened, not to wait for a service");
    check("a kept overflow is retried once on a rebuilt runner, compacting first");
  }

  // ------------------------------------------------------------ the settings
  {
    const { publicCapabilities } = require("../src/main/model-preset-capabilities.js");
    assert.deepEqual(publicCapabilities({ vision: true, imageGen: true, contextWindowTokens: 256_000 }), { vision: true, imageGen: true, contextWindowTokens: 256_000 },
      "the edit form gets back every capability it saves");
    cw.resetObservedContextWindowsForTests();
    assert.deepEqual(cw.presetContextWindow({ model: "deepseek-v4-pro", baseUrl: "https://x/v1", capabilities: {} }, {}), { tokens: 1_000_000, source: "catalog" });
    assert.deepEqual(cw.presetContextWindow({ model: "company-model", capabilities: { contextWindowTokens: 256_000 } }, {}), { tokens: 256_000, source: "configured" });
    const html = fs.readFileSync("src/renderer/modules/model-settings.js", "utf8");
    assert.match(html, /contextWindowPlaceholder\(preset\)/, "and shows the window the engine will use when the field is left empty");
    check("settings round-trip the window and show where the effective one comes from");
  }
} finally {
  if (previousUserData === undefined) delete process.env.LILY_USER_DATA_DIR; else process.env.LILY_USER_DATA_DIR = previousUserData;
  fs.rmSync(userData, { recursive: true, force: true });
}

console.log(`context-overflow-recovery: ok (${checks} checks)`);
