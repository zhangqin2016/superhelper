#!/usr/bin/env node
/**
 * The budget has to be measured against the model's real context, not a guess.
 *
 * Lily had one source for a model's window: an environment variable the server
 * sends only when an operator typed the number in by hand. Measured across 595
 * real compaction decisions on one install, 22 knew the model's actual window
 * and 573 fell through to a hardcoded 120,000.
 *
 * The error runs in the dangerous direction. Compaction triggers at a fraction
 * of the window, so assuming 120,000 for a model that holds 32,000 puts the
 * trigger beyond anything the model can accept: pressure never registers, the
 * conversation never compacts, and the turn dies on an overflow the budget
 * called impossible. Meanwhile the number was being thrown away — endpoints
 * advertise it in their own listing and discovery kept only the id.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cw = require("../src/main/model-context-window.js");
const { decideBackgroundCompaction, decidePreTurnCompaction } = require("../src/main/context-budget-manager.js");

let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

// ------------------------------------------------------------ reading it
{
  // The shape a real endpoint returns, captured from the live relay listing.
  assert.equal(cw.readContextWindow({ id: "gpt-6-astra", context_window: 272_000, owned_by: "openai" }), 272_000);
  // The spellings other compatible servers use for the same fact.
  for (const field of ["contextWindowTokens", "context_window_tokens", "context_length", "max_model_len", "maxContextTokens", "max_input_tokens"]) {
    assert.equal(cw.readContextWindow({ id: "m", [field]: 32_768 }), 32_768, `${field} names the context window`);
  }
  assert.equal(cw.readContextWindow({ id: "m", limits: { contextTokens: 65_536 } }), 65_536, "some gateways nest it");
  assert.equal(cw.readContextWindow({ id: "m", meta: { max_model_len: 8_192 } }), 8_192);
  check("a window is recognised under every spelling endpoints actually use");
}

{
  assert.equal(cw.readContextWindow({ id: "m" }), 0, "a listing that says nothing reports nothing");
  assert.equal(cw.readContextWindow(null), 0);
  assert.equal(cw.readContextWindow("not an object"), 0);
  // A unit mix-up must never become a budget: 128 "k" is not 128 tokens, and a
  // parsing accident is not a 900-million-token model.
  assert.equal(cw.readContextWindow({ id: "m", context_window: 128 }), 0, "implausibly small is a unit mix-up, not a window");
  assert.equal(cw.readContextWindow({ id: "m", context_window: 9e9 }), 0, "implausibly large is a parsing accident");
  assert.equal(cw.readContextWindow({ id: "m", context_window: "65536" }), 65_536, "a numeric string is still a number");
  check("nonsense is refused rather than turned into a budget");
}

// --------------------------------------------------------- remembering it
{
  cw.resetObservedContextWindowsForTests();
  assert.equal(cw.recallContextWindow("https://api.example.com/v1", "m"), null, "nothing is known before anything is seen");
  cw.rememberContextWindow("https://api.example.com/v1", "m", 32_768);
  assert.equal(cw.recallContextWindow("https://api.example.com/v1", "m"), 32_768);
  assert.equal(cw.recallContextWindow("https://api.example.com/v1/", "m"), 32_768, "a trailing slash is the same endpoint");
  assert.equal(cw.recallContextWindow("https://other.example.com/v1", "m"), null, "a window belongs to one endpoint, not to a model name");
  assert.equal(cw.recallContextWindow("https://api.example.com/v1", "other"), null);
  check("an observed window is keyed to the endpoint that reported it");
}

{
  cw.resetObservedContextWindowsForTests();
  cw.rememberContextWindow("https://e/v1", "m", 32_768);
  cw.rememberContextWindow("https://e/v1", "m", 0);
  assert.equal(cw.recallContextWindow("https://e/v1", "m"), 32_768, "a later listing that omits the field must not erase what was learned");
  cw.rememberContextWindow("https://e/v1", "m", 8);
  assert.equal(cw.recallContextWindow("https://e/v1", "m"), 32_768, "nor may an implausible one");
  cw.rememberContextWindow("https://e/v1", "m", 65_536);
  assert.equal(cw.recallContextWindow("https://e/v1", "m"), 65_536, "a real update is taken");
  check("learning only ever improves on what is known");
}

// ------------------------------------------------- discovery keeps the window
{
  const { discoverEndpointModels } = require("../src/main/model-endpoint-discovery.js");
  cw.resetObservedContextWindowsForTests();
  const listing = { data: [{ id: "big", context_window: 272_000 }, { id: "small", max_model_len: 8_192 }, { id: "silent" }] };
  globalThis.fetch = async () => new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json" } });
  const result = await discoverEndpointModels({ baseUrl: "https://disco.example.com/v1", apiKey: "k" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ["big", "small", "silent"], "every model is still listed, as before");
  assert.equal(result.contextWindows.big, 272_000, "and the window it advertised is no longer discarded");
  assert.equal(result.contextWindows.small, 8_192);
  assert.equal(result.contextWindows.silent, undefined, "a model that said nothing claims nothing");
  assert.equal(cw.recallContextWindow("https://disco.example.com/v1", "small"), 8_192, "and it is remembered for the budget to use");
  check("discovery keeps the window the endpoint advertised instead of only the id");
}

// --------------------------------------------- what the budget does with it
const budgetFor = (contextWindowTokens) => decidePreTurnCompaction({
  capabilities: { nativeCompaction: true },
  model: { providerID: "p", modelID: "m", contextWindowTokens },
  runner: { alive: true, canStart: true, busy: false },
  sessionSummary: {},
  currentPromptTokens: 26_000,
  currentPromptTokenSource: "runtime_usage",
});

{
  // The whole point: a small model must compact at a small number. Under the
  // 120,000 default this same conversation reports no pressure at all, and
  // keeps growing until the model rejects it.
  const real = budgetFor(32_768);
  const guessed = budgetFor(undefined);
  assert.equal(real.contextWindowTokens, 32_768, "the model's own window is used");
  assert.ok(real.compactionTriggerTokens < guessed.compactionTriggerTokens, "a smaller window triggers sooner");
  assert.equal(real.action, "compact", "26k into a 32k model is real pressure");
  assert.equal(guessed.action, "skip", "and the hardcoded guess calls the same conversation comfortable");
  assert.equal(real.budgetSource, "model_capability");
  assert.equal(guessed.budgetSource, "default_capability", "a guess admits that it is one");
  check("a real window makes a small model compact where the default would have let it overflow");
}

{
  // Every decision taken after the budget is resolved reports it — the two
  // most common outcomes used to drop it, which left the compaction taken on
  // turn count alone with no record of whether it was needed.
  const longSession = decideBackgroundCompaction({
    capabilities: { nativeCompaction: true },
    model: { providerID: "p", modelID: "m", contextWindowTokens: 32_768 },
    runner: { alive: true, canStart: true, busy: false },
    sessionSummary: { turnCount: 40 },
  });
  assert.equal(longSession.reason, "long_session");
  assert.equal(longSession.contextWindowTokens, 32_768, "a turn-count compaction now says what it was measured against");
  assert.ok(longSession.compactionTriggerTokens > 0, "and how far it was from real pressure");

  const belowThreshold = decideBackgroundCompaction({
    capabilities: { nativeCompaction: true },
    model: { providerID: "p", modelID: "m", contextWindowTokens: 32_768 },
    runner: { alive: true, canStart: true, busy: false },
    sessionSummary: { turnCount: 1 },
  });
  assert.equal(belowThreshold.reason, "below_threshold");
  assert.equal(belowThreshold.contextWindowTokens, 32_768, "so does the skip beside it");
  check("every decision measured against a budget now reports that budget");
}

// ------------------------------------- the built model actually carries it
{
  // The reader, the registry and the budget can all be right while nothing
  // connects them. This is the wire: what discovery observed has to reach the
  // model object the compaction budget is handed.
  const { resolveOpencodeModelConfig } = require("../src/main/runtime/opencode-model-config.js");
  cw.resetObservedContextWindowsForTests();
  const env = { LILY_API_BASE_URL: "https://wired.example.com/v1", LILY_API_KEY: "k", LILY_MODEL: "small-ctx" };

  const before = resolveOpencodeModelConfig(env, {});
  assert.equal(before.ok, true);
  assert.equal(before.model.contextWindowTokens, null, "nothing observed stays unspecified, as it was before observation existed");

  cw.rememberContextWindow("https://wired.example.com/v1", "small-ctx", 32_768);
  const after = resolveOpencodeModelConfig(env, {});
  assert.equal(after.model.contextWindowTokens, 32_768, "what the endpoint advertised reaches the model the budget measures");

  // Operator configuration still outranks observation.
  const configured = resolveOpencodeModelConfig({ ...env, LILY_CONTEXT_WINDOW_TOKENS: "65536" }, {});
  assert.equal(configured.model.contextWindowTokens, 65_536, "an explicitly configured window still wins");
  check("an observed window reaches the model object, without outranking configuration");
}

console.log(`model-context-window: ok (${checks} checks)`);
