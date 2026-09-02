#!/usr/bin/env node
/**
 * When the pinned model cannot read images, the user must be told WHICH model
 * would — and the model must never be switched for them.
 *
 * Auto selection already prefers a vision model for image turns while keeping
 * the reasoning baseline first; a MANUAL pick returns early, so those users
 * always got the bridge with no explanation and no way out.
 */
import assert from "node:assert/strict";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const {
  MAX_SUGGESTIONS,
  buildVisionFallbackAdvice,
  listVisionCapableModels,
} = require("../src/main/vision-model-advice.js");

const models = [
  { id: "ds", label: "DeepSeek V4 Flash", capabilities: { vision: false } },
  { id: "qvl", label: "Qwen-VL Max", capabilities: { vision: true } },
  { id: "gpt", label: "GPT-4o", capabilities: { vision: true } },
  { id: "sonnet", label: "Claude Sonnet", capabilities: { vision: true } },
  { id: "gemini", label: "Gemini", capabilities: { vision: true } },
];

// --- only vision-capable models, never the one already active ---------------
{
  const list = listVisionCapableModels({ models, activeModelId: "ds" });
  assert.deepEqual(list.map((m) => m.id), ["qvl", "gpt", "sonnet", "gemini"]);
  assert(!list.some((m) => m.id === "ds"), "a text-only model is never suggested");
  const fromVision = listVisionCapableModels({ models, activeModelId: "qvl" });
  assert(!fromVision.some((m) => m.id === "qvl"), "the active model is never suggested to itself");
  // A model with no label still names itself by id rather than going blank.
  assert.equal(
    listVisionCapableModels({ models: [{ id: "bare", capabilities: { vision: true } }] })[0].label,
    "bare",
  );
}

// --- the advice names real models and is capped -----------------------------
{
  const advice = buildVisionFallbackAdvice({ models, activeModelId: "ds" });
  assert(advice.includes("Qwen-VL Max") && advice.includes("GPT-4o"), "names concrete alternatives");
  assert(!advice.includes("DeepSeek"), "never suggests the text-only model the user is on");
  assert.equal(advice.split("、").length, MAX_SUGGESTIONS, "suggestion list is capped");
  assert(advice.includes("等 4 个"), "says how many more there are");
}

// --- never promise a model the user does not have ---------------------------
// Every one of these must produce NOTHING rather than advice that cannot be
// acted on. This is the fail-open contract the caller relies on.
{
  assert.equal(buildVisionFallbackAdvice({ models: [models[0]], activeModelId: "ds" }), "", "no vision model → no advice");
  assert.equal(buildVisionFallbackAdvice({ models: [models[1]], activeModelId: "qvl" }), "", "already on the only vision model → no advice");
  assert.equal(buildVisionFallbackAdvice({ models: [] }), "", "empty catalog → no advice");
  assert.equal(buildVisionFallbackAdvice({}), "", "no catalog reachable → no advice");
  assert.equal(buildVisionFallbackAdvice(), "", "no arguments → no advice");
  assert.equal(buildVisionFallbackAdvice({ models: null }), "", "malformed catalog → no advice");
  assert.equal(
    buildVisionFallbackAdvice({ models: [{ label: "no id", capabilities: { vision: true } }] }),
    "",
    "an option without an id is not actionable",
  );
}

// --- INVARIANT: advising is not switching -----------------------------------
// A manual pick is an explicit user choice and a vision model can be weaker at
// reasoning, so this module must never expose a way to reroute the turn.
{
  const api = require("../src/main/vision-model-advice.js");
  const surface = Object.keys(api).sort();
  assert.deepEqual(surface, ["MAX_SUGGESTIONS", "buildVisionFallbackAdvice", "listVisionCapableModels"]);
  for (const key of surface) {
    assert(!/(switch|select|apply|route|set)/i.test(key), `${key} must not offer to change the model`);
  }
  const source = require("node:fs").readFileSync(
    new URL("../src/main/vision-model-advice.js", import.meta.url), "utf8",
  );
  assert(
    !/setModelSelectionPreference|writeStoredSelection/.test(source),
    "the advice path must never write a model selection",
  );
}

console.log("vision-model-advice: ok");
