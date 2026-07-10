#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { evaluateModelEval, parseModelEvalArgs } from "./eval/model-eval-policy.mjs";
import { buildEvalPlatformConfig } from "./eval/model-eval-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildCompatibilityProfileRuntimeEnv } = require("../src/main/model-presets.js");
const knownCases = ["a", "b"];

{
  assert.deepEqual(
    parseModelEvalArgs([], knownCases),
    { ok: true, onlyCase: "", updateBaseline: false },
  );
  assert.deepEqual(
    parseModelEvalArgs(["--update-baseline", "--case", "a"], knownCases),
    { ok: true, onlyCase: "a", updateBaseline: true },
  );
  assert.equal(parseModelEvalArgs(["--case"], knownCases).error, "CASE_VALUE_REQUIRED");
  assert.equal(parseModelEvalArgs(["--case", "--update-baseline"], knownCases).error, "CASE_VALUE_REQUIRED");
  assert.equal(parseModelEvalArgs(["--case", "renamed"], knownCases).error, "UNKNOWN_CASE");
  assert.equal(parseModelEvalArgs(["--case", "a", "--case", "b"], knownCases).error, "DUPLICATE_CASE");
  assert.equal(
    parseModelEvalArgs([], ["a", "a"]).error,
    "INVALID_CASE_DEFINITIONS",
    "duplicate source CASE ids must fail setup before any live work",
  );
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: false } },
    baseline: null,
  });
  assert.equal(outcome.exitCode, 2, "a full eval without a committed baseline must fail setup");
  assert.equal(outcome.missingBaseline, true, "missing baseline must be explicit in the outcome");
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true } },
    baseline: { results: { a: { pass: true } } },
    expectedCaseIds: ["a", "a"],
  });
  assert.equal(outcome.exitCode, 2, "duplicate expected case ids make coverage ambiguous");
  assert.equal(outcome.setupError, "INVALID_EXPECTED_CASES");
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true } },
    baseline: false,
    updateBaseline: true,
    expectedCaseIds: ["a"],
  });
  assert.equal(outcome.exitCode, 2, "a present but malformed baseline cannot be mistaken for a missing baseline");
  assert.equal(outcome.setupError, "INVALID_BASELINE");
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true } },
    baseline: { results: { a: { pass: true } } },
    expectedCaseIds: [],
  });
  assert.equal(outcome.exitCode, 2, "an explicitly empty expected-case contract is invalid setup");
  assert.equal(outcome.setupError, "INVALID_EXPECTED_CASES");
}

{
  const env = buildCompatibilityProfileRuntimeEnv({
    probeVersion: 6,
    requestBodyOverlay: { chat_template_kwargs: { enable_thinking: false } },
    toolShapeCompat: true,
    prompt: { systemMaxChars: 4096 },
    capability: {
      grade: "lite",
      confidence: "confirmed",
      recipes: { instructionLanguage: "zh", toolCallHint: true, outputTokenCeiling: 2048 },
    },
  });
  assert.equal(env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "4096");
  assert.equal(env.LILY_OPENCODE_TOOL_COMPAT, "1");
  assert.equal(env.LILY_MODEL_CAPABILITY_GRADE, "lite");
  assert.deepEqual(JSON.parse(env.LILY_MODEL_RECIPES), {
    instructionLanguage: "zh",
    toolCallHint: true,
    outputTokenCeiling: 2048,
  });
  assert.deepEqual(JSON.parse(env.LILY_OPENCODE_BODY_OVERLAY_JSON), {
    chat_template_kwargs: { enable_thinking: false },
  });
}

{
  const oldLite = buildCompatibilityProfileRuntimeEnv({
    probeVersion: 5,
    prompt: { systemMaxChars: 2048 },
    capability: { grade: "lite", confidence: "confirmed" },
  });
  assert.equal(oldLite.LILY_MODEL_CAPABILITY_GRADE, undefined, "old lite evidence must stay non-destructive");
  assert.equal(oldLite.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, undefined, "old prompt ceilings must stay ignored");
}

{
  const lilyEnv = {
    LILY_OPENCODE_BASE_URL: "https://example.invalid/v1",
    LILY_OPENCODE_API_KEY: "sk-eval",
    LILY_OPENCODE_MODEL: "provider/eval-model",
    LILY_OPENCODE_PROTOCOL: "openai",
  };
  const plain = buildEvalPlatformConfig({ lilyEnv, compatibilityProfile: null });
  const full = buildEvalPlatformConfig({
    lilyEnv,
    compatibilityProfile: {
      probeVersion: 6,
      capability: { grade: "full", confidence: "confirmed" },
    },
  });
  const standard = buildEvalPlatformConfig({
    lilyEnv,
    compatibilityProfile: {
      probeVersion: 6,
      capability: { grade: "standard", confidence: "confirmed" },
    },
  });
  const unconfirmedLite = buildEvalPlatformConfig({
    lilyEnv,
    compatibilityProfile: {
      probeVersion: 5,
      prompt: { systemMaxChars: 2048 },
      capability: { grade: "lite", confidence: "confirmed" },
    },
  });
  assert.equal(plain.ok, true);
  assert.equal(full.configContent, plain.configContent, "full grade must keep generated eval config byte-identical");
  assert.equal(standard.configContent, plain.configContent, "standard grade must keep generated eval config byte-identical");
  assert.equal(unconfirmedLite.configContent, plain.configContent, "unconfirmed/old lite evidence must fail open");

  const lite = buildEvalPlatformConfig({
    lilyEnv,
    compatibilityProfile: {
      probeVersion: 6,
      toolShapeCompat: true,
      prompt: { systemMaxChars: 4096 },
      capability: {
        grade: "lite",
        confidence: "confirmed",
        recipes: { toolCallHint: true, outputTokenCeiling: 2048 },
      },
    },
  });
  assert.equal(lite.ok, true);
  assert.equal(lite.runtimeEnv.LILY_MODEL_CAPABILITY_GRADE, "lite");
  assert.equal(lite.runtimeEnv.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "4096");
  assert.equal(lite.runtimeEnv.LILY_OPENCODE_TOOL_COMPAT, "1");
  const config = JSON.parse(lite.configContent);
  assert.equal(config.permission.task, "deny", "confirmed lite eval must exercise production task shaping");
  assert.match(config.agent.build.prompt, /## Execution Protocol \(lite support\)/, "confirmed lite eval must exercise runner guidance");
  assert.match(config.agent.build.prompt, /## Tool Protocol \(model recipe\)/, "eval must exercise confirmed model recipes");
}

{
  const outcome = evaluateModelEval({
    results: {},
    baseline: { results: { a: { pass: true } } },
    expectedCaseIds: ["a"],
  });
  assert.equal(outcome.exitCode, 2, "an empty full-suite result cannot pass the release gate");
  assert.equal(outcome.setupError, "EMPTY_RESULTS");
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true } },
    baseline: { results: {} },
    expectedCaseIds: ["a"],
  });
  assert.equal(outcome.exitCode, 2, "an empty baseline is invalid setup, not a successful comparison");
  assert.equal(outcome.setupError, "INVALID_BASELINE");
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true } },
    baseline: { results: { a: { pass: "yes" } } },
    expectedCaseIds: ["a"],
  });
  assert.equal(outcome.exitCode, 2, "baseline pass fields must be real booleans");
  assert.equal(outcome.setupError, "INVALID_BASELINE");
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true } },
    baseline: { results: { a: { pass: true }, b: { pass: true } } },
    expectedCaseIds: ["a", "b"],
  });
  assert.equal(outcome.exitCode, 2, "a baseline pass case missing from current results cannot silently pass");
  assert.equal(outcome.setupError, "RESULT_COVERAGE_MISMATCH");
  assert.deepEqual(outcome.missingResultCases, ["b"]);
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true }, renamed: { pass: true } },
    baseline: { results: { a: { pass: true }, b: { pass: true } } },
    expectedCaseIds: ["a", "renamed"],
  });
  assert.equal(outcome.exitCode, 2, "renaming a case requires an explicit baseline refresh");
  assert.equal(outcome.setupError, "BASELINE_COVERAGE_MISMATCH");
  assert.deepEqual(outcome.missingBaselineCases, ["renamed"]);
  assert.deepEqual(outcome.unexpectedBaselineCases, ["b"]);
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true }, renamed: { pass: true } },
    baseline: { results: { a: { pass: true }, b: { pass: true } } },
    expectedCaseIds: ["a", "renamed"],
    updateBaseline: true,
  });
  assert.equal(outcome.exitCode, 0, "update mode must be able to replace an otherwise valid outdated baseline");
  assert.equal(outcome.baselineRefreshRequired, true);
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: false } },
    baseline: null,
    updateBaseline: true,
    expectedCaseIds: ["a"],
  });
  assert.equal(outcome.exitCode, 0, "baseline bootstrap remains allowed after full result validation");
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: false } },
    baseline: { results: { a: { pass: true } } },
  });
  assert.equal(outcome.exitCode, 1, "a baseline pass that now fails must block release");
  assert.deepEqual(outcome.regressions, ["a"]);
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: false } },
    baseline: null,
    onlyCase: "a",
  });
  assert.equal(outcome.exitCode, 1, "a failed explicit case must fail even without a baseline");
  assert.deepEqual(outcome.failedCases, ["a"]);
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: true } },
    baseline: { results: { a: { pass: true } } },
  });
  assert.equal(outcome.exitCode, 0, "a passing result with no regression must pass");
}

{
  const outcome = evaluateModelEval({
    results: { a: { pass: false } },
    baseline: null,
    updateBaseline: true,
  });
  assert.equal(outcome.exitCode, 0, "baseline creation mode must not be rejected for a missing baseline");
  assert.equal(outcome.missingBaseline, undefined);
}

const evalSource = fs.readFileSync(path.join(here, "eval", "run-model-evals.mjs"), "utf8");
const runtimeSource = fs.readFileSync(path.join(here, "eval", "model-eval-runtime.mjs"), "utf8");
assert.match(evalSource, /buildEvalPlatformConfig/, "live eval must use the testable production runtime assembly");
assert.match(
  evalSource,
  /buildEvalPlatformConfig\(\{\s*lilyEnv,\s*compatibilityProfile:\s*probe\.profile\s*\}\)/,
  "live eval must feed the entire probe profile through production runtime mapping",
);
assert.match(runtimeSource, /buildSharedBaseConfig/, "eval runtime must use the same shared config builder as Lily");
assert.match(runtimeSource, /buildAgentBasePersona/, "eval runtime must inject Lily's real base persona");
assert.match(runtimeSource, /buildCompatibilityProfileRuntimeEnv/, "eval runtime must share production profile-to-env mapping");
assert.match(runtimeSource, /_appendModelRecipeHints/, "eval runtime must exercise the runner's production guidance shaping");
assert.doesNotMatch(
  `${evalSource}\n${runtimeSource}`,
  /const\s*\{\s*resolveOpencodeModelConfig\s*\}\s*=\s*require\(/,
  "live eval must not bypass Lily's shared config/persona path",
);
assert.match(
  evalSource,
  /const\s+LILY_IDENTITY\s*=\s*\/(?:[^\n]|\\n)*(?:Lily|智能工作台)/,
  "Chinese identity eval must recognize Lily's product identity",
);
assert.match(
  evalSource,
  /check:\s*\(text\)\s*=>\s*CJK\.test\(text\)\s*&&\s*LILY_IDENTITY\.test\(text\)/,
  "a generic Chinese coding-CLI identity must not pass the Lily identity case",
);

for (const args of [["--case"], ["--case", "--update-baseline"], ["--case", "not-a-real-case"]]) {
  const env = { ...process.env };
  delete env.LILY_EVAL_BASE_URL;
  delete env.LILY_EVAL_API_KEY;
  delete env.LILY_EVAL_MODEL;
  const result = spawnSync(process.execPath, [path.join(here, "eval", "run-model-evals.mjs"), ...args], {
    cwd: path.join(here, ".."),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 2, `invalid args ${args.join(" ")} must be a setup failure`);
  assert.match(result.stderr, /invalid --case/i, "CLI argument validation must run before credential checks");
  assert.doesNotMatch(result.stderr, /LILY_EVAL_BASE_URL/, "invalid --case must not reach credential/probe work");
}

console.log("model-eval-policy: ok");
