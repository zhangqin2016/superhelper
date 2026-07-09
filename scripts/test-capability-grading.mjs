#!/usr/bin/env node
// Capability grading (能力分档 → 差异化放权) — capability-gate assertions:
//   1. presets: a stored capability.grade reaches the runtime env as
//      LILY_MODEL_CAPABILITY_GRADE; garbage grades are dropped in
//      normalization (absence = standard).
//   2. runner-pool lite: MCP shrinks to lily_tool_broker only, subagents are
//      denied (task: deny), and the system-guide budget tightens to
//      min(probed, 8000).
//   3. standard/full/ungraded/kill-switch: byte-identical to today's config —
//      the "no probed evidence → never deviate" hard gate.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-capability-grading-"));
const savedEnv = {};
for (const key of [
  "OPENCODE_BIN",
  "LILY_USER_DATA_DIR",
  "LILY_HOME",
  "LILY_DOCUMENTS_DIR",
  "LILY_ENABLE_CAPABILITY_GRADING",
  "LILY_MODEL",
  "LILY_API_BASE_URL",
  "LILY_API_KEY",
]) {
  savedEnv[key] = process.env[key];
}
process.env.OPENCODE_BIN = process.platform === "win32" ? process.execPath : "/bin/true";
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = os.homedir();
process.env.LILY_DOCUMENTS_DIR = tmp;
delete process.env.LILY_ENABLE_CAPABILITY_GRADING;
delete process.env.LILY_MODEL;
delete process.env.LILY_API_BASE_URL;
delete process.env.LILY_API_KEY;

const baseProfile = {
  probeVersion: 3,
  conformance: { chatCompletions: true, streaming: true, toolCalls: true, contentSource: "plain" },
  prompt: { systemMaxChars: 24576 },
};
const presetEntry = (id, capability) => ({
  id,
  label: id,
  model: `provider/${id}`,
  baseUrl: "https://example.invalid/v1",
  apiKey: "sk-test",
  protocol: "openai",
  compatibilityProfile: { ...baseProfile, ...(capability ? { capability } : {}) },
});
fs.writeFileSync(path.join(tmp, "model-settings.json"), JSON.stringify({
  activePresetId: "custom-lite",
  customPresets: [
    presetEntry("custom-lite", { grade: "lite", signals: { instructionFidelity: false, toolChoiceAuto: false } }),
    presetEntry("custom-full", { grade: "full", signals: { instructionFidelity: true, toolChoiceAuto: true } }),
    presetEntry("custom-badgrade", { grade: "superduper" }),
    presetEntry("custom-nograde", null),
    presetEntry("custom-recipes", {
      grade: "standard",
      signals: { instructionFidelity: true, toolChoiceAuto: true },
      recipes: { instructionLanguage: "zh", toolCallHint: true },
    }),
    presetEntry("custom-badrecipes", {
      grade: "standard",
      recipes: { instructionLanguage: "fr", toolCallHint: "yes" },
    }),
  ],
}, null, 2));

const require = createRequire(import.meta.url);

try {
  const modelPresets = require("../src/main/model-presets.js");
  const { SessionRunnerPool } = require("../src/main/session-runner-pool.js");

  // --- 1. presets: capability grade normalization + env delivery ---
  modelPresets.setActivePreset("custom-lite");
  assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_CAPABILITY_GRADE, "lite",
    "a stored lite grade must reach the runtime env");
  assert.equal(modelPresets.getUserApiEnv().LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "24576",
    "the probed prompt budget still rides the env untouched");

  modelPresets.setActivePreset("custom-full");
  assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_CAPABILITY_GRADE, "full",
    "a stored full grade must reach the runtime env");

  modelPresets.setActivePreset("custom-badgrade");
  assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_CAPABILITY_GRADE, undefined,
    "an unknown grade must be dropped in normalization (absence = standard)");

  modelPresets.setActivePreset("custom-nograde");
  assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_CAPABILITY_GRADE, undefined,
    "profiles without capability must emit no grade env");

  modelPresets.setActivePreset("custom-recipes");
  assert.deepEqual(JSON.parse(modelPresets.getUserApiEnv().LILY_MODEL_RECIPES),
    { instructionLanguage: "zh", toolCallHint: true },
    "probed recipes reach the runtime env as JSON");

  modelPresets.setActivePreset("custom-badrecipes");
  assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_RECIPES, undefined,
    "unknown recipe values are dropped in normalization — absence = today's behavior");

  // --- 2. runner-pool: lite differentiation ---
  const buildFor = (presetId, sessionId) => {
    modelPresets.setActivePreset(presetId);
    const pool = new SessionRunnerPool();
    let mcpOpts = null;
    pool._opencodeMcpServers = (_skillIds, opts) => {
      mcpOpts = opts;
      return {};
    };
    pool._opencodePlugins = () => [];
    pool._opencodeGuideContent = () => "";
    const runner = pool.ensure(sessionId, process.cwd(), {}, { lazy: true });
    return { runner, mcpOpts, spawnOptions: runner.spawnOptions };
  };

  const lite = buildFor("custom-lite", "session_lite");
  assert.equal(lite.mcpOpts.capabilityGrade, "lite", "the active model's grade must reach MCP assembly");
  assert.equal(lite.spawnOptions.env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "8000",
    "lite tightens the system-guide budget to min(probed 24576, 8000)");
  const liteCfg = JSON.parse(lite.spawnOptions.opencodeConfig || "{}");
  assert.equal(liteCfg.permission?.task, "deny", "lite denies subagents (task tool) in the shared config");

  const full = buildFor("custom-full", "session_full");
  assert.equal(full.mcpOpts.capabilityGrade, "full", "full grade is passed through (未来增益挂点)");
  const fullCfg = JSON.parse(full.spawnOptions.opencodeConfig || "{}");
  assert.equal(fullCfg.permission?.task, undefined, "full keeps today's permission set — no task rule at all");
  // Under plain node buildAgentSpawnEnv fails open to {} (no electron), so the
  // ONLY way this key can appear is the lite injection — full must not inject.
  assert.equal(full.spawnOptions.env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, undefined,
    "full must not inject a tightened prompt budget");

  const ungraded = buildFor("custom-nograde", "session_nograde");
  assert.equal(ungraded.mcpOpts.capabilityGrade, "", "no stored grade → empty grade → standard behavior");
  const ungradedCfg = JSON.parse(ungraded.spawnOptions.opencodeConfig || "{}");
  assert.equal(ungradedCfg.permission?.task, undefined, "ungraded models keep today's exact permission set");

  // Hard gate: graded-but-not-lite must be BYTE-IDENTICAL to ungraded config
  // (model refs differ by preset, so compare everything except provider/model).
  const stripModel = (cfg) => {
    const clone = JSON.parse(JSON.stringify(cfg));
    delete clone.provider;
    delete clone.model;
    delete clone.small_model;
    delete clone.agent;
    return clone;
  };
  assert.deepEqual(stripModel(fullCfg), stripModel(ungradedCfg),
    "a full grade must not deviate from today's config in phase 1 (不变笨 hard gate)");

  // --- 3. kill switch pins everything to standard ---
  process.env.LILY_ENABLE_CAPABILITY_GRADING = "0";
  try {
    const killed = buildFor("custom-lite", "session_killed");
    assert.equal(killed.mcpOpts.capabilityGrade, "", "kill switch blanks the grade before it reaches MCP assembly");
    const killedCfg = JSON.parse(killed.spawnOptions.opencodeConfig || "{}");
    assert.equal(killedCfg.permission?.task, undefined, "kill switch restores today's permission set for a lite model");
    assert.equal(killed.spawnOptions.env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, undefined,
      "kill switch must not inject the tightened prompt budget");
  } finally {
    delete process.env.LILY_ENABLE_CAPABILITY_GRADING;
  }

  // --- 4. real MCP assembly: lite keeps ONLY the tool broker ---
  const realPool = new SessionRunnerPool();
  const baseline = realPool._opencodeMcpServers(null, {});
  assert(baseline.lily_tool_broker, "baseline MCP assembly must include the tool broker (test would be vacuous otherwise)");
  assert(Object.keys(baseline).length > 1, "baseline must carry more than the broker for the lite filter to mean anything");

  const liteServers = realPool._opencodeMcpServers(null, { capabilityGrade: "lite" });
  assert.deepEqual(Object.keys(liteServers).sort(), ["lily_file_intelligence", "lily_tool_broker"],
    "lite keeps the tool broker (platform contract) AND file intelligence (the Large Input Protocol guardrail)");

  const liteCompatServers = realPool._opencodeMcpServers(null, { capabilityGrade: "lite", toolCompat: true });
  assert.deepEqual(Object.keys(liteCompatServers).sort(), ["lily_fi", "lily_tb"],
    "lite composes with tool-shape compat (short server keys)");

  const standardServers = realPool._opencodeMcpServers(null, { capabilityGrade: "standard" });
  assert.deepEqual(standardServers, baseline, "standard grade must not change MCP assembly at all");
  const fullServers = realPool._opencodeMcpServers(null, { capabilityGrade: "full" });
  assert.deepEqual(fullServers, baseline, "full grade must not change MCP assembly at all (phase 1)");

  // --- 5. recipe application: calibrated guide hint --------------------------
  const guide = "# Lily\n\nIdentity.\n\n## Some Skill\n\nSkill text.";
  const hinted = realPool._appendModelRecipeHints(guide, { LILY_MODEL_RECIPES: '{"toolCallHint":true}' });
  assert.match(hinted, /## Tool Protocol \(model recipe\)/, "toolCallHint recipe appends the calibrated example section");
  assert.match(hinted, /NATIVE structured function call/, "the hint teaches the native-call rule with an example");
  assert.equal(realPool._appendModelRecipeHints(hinted, { LILY_MODEL_RECIPES: '{"toolCallHint":true}' }), hinted,
    "the hint is idempotent");
  assert.equal(realPool._appendModelRecipeHints(guide, {}), guide, "no recipes → guidance untouched");
  assert.equal(realPool._appendModelRecipeHints(guide, { LILY_MODEL_RECIPES: "not json" }), guide,
    "corrupt recipes fail open to the untouched guidance");
  assert.equal(realPool._appendModelRecipeHints(guide, { LILY_MODEL_RECIPES: '{"instructionLanguage":"zh"}' }), guide,
    "language-only recipes do not touch the guide (they steer corrective hints)");

  // The recipe section must survive tight budgets: it is titled "Tool Protocol …"
  // exactly so the truncation guardrail keeps it.
  const { truncateSystemGuidance } = require("../src/main/runtime/opencode-message-parts.js");
  const bigGuide = realPool._appendModelRecipeHints(
    `# Lily\n\nIdentity.\n\n## Skill Alpha\n\n${"alpha ".repeat(600)}`,
    { LILY_MODEL_RECIPES: '{"toolCallHint":true}' },
  );
  const cutGuide = truncateSystemGuidance(bigGuide, 1600);
  assert.match(cutGuide, /Tool Protocol \(model recipe\)/,
    "the calibrated hint outranks skill sections under budget truncation");

  console.log("capability-grading: ok");
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
