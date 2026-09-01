#!/usr/bin/env node
// Capability grading (能力分档 → 差异化放权) — capability-gate assertions:
//   1. presets: destructive lite behavior requires confirmed probe evidence;
//      legacy/unconfirmed lite degrades to absence = standard.
//   2. runner-pool lite: MCP shrinks to the broker + file-intelligence guardrail,
//      subagents are denied (task: deny), and the system-guide budget tightens
//      to min(probed, 8000).
//   3. standard/full/ungraded/kill-switch: byte-identical to today's config —
//      the "no probed evidence → never deviate" hard gate.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
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
// These lazy/stubbed runner checks need an existing path, not a real engine.
// process.execPath exists on every host; /bin/true is absent on macOS.
process.env.OPENCODE_BIN = process.execPath;
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = os.homedir();
process.env.LILY_DOCUMENTS_DIR = tmp;
delete process.env.LILY_ENABLE_CAPABILITY_GRADING;
delete process.env.LILY_MODEL;
delete process.env.LILY_API_BASE_URL;
delete process.env.LILY_API_KEY;

const baseProfile = {
  probeVersion: 6,
  conformance: { chatCompletions: true, streaming: true, toolCalls: true, contentSource: "plain" },
  prompt: { systemMaxChars: 24576 },
};
const presetEntry = (id, capability, profileOverrides = {}) => ({
  id,
  label: id,
  model: `provider/${id}`,
  baseUrl: "https://example.invalid/v1",
  apiKey: "sk-test",
  protocol: "openai",
  compatibilityProfile: { ...baseProfile, ...profileOverrides, ...(capability ? { capability } : {}) },
});
fs.writeFileSync(path.join(tmp, "model-settings.json"), JSON.stringify({
  activePresetId: "custom-lite",
  customPresets: [
    presetEntry("custom-lite", {
      grade: "lite",
      confidence: "confirmed",
      signals: { instructionFidelity: false, toolChoiceAuto: false },
    }),
    presetEntry("custom-legacy-lite", {
      grade: "lite",
      signals: { instructionFidelity: false, toolChoiceAuto: false },
    }, { probeVersion: 5 }),
    presetEntry("custom-unconfirmed-lite", {
      grade: "lite",
      confidence: "unconfirmed",
      signals: { instructionFidelity: false, toolChoiceAuto: false },
    }),
    presetEntry("custom-versionless-confirmed-lite", {
      grade: "lite",
      confidence: "confirmed",
      signals: { instructionFidelity: false, toolChoiceAuto: false },
    }, { probeVersion: undefined }),
    presetEntry("custom-nonnumeric-confirmed-lite", {
      grade: "lite",
      confidence: "confirmed",
      signals: { instructionFidelity: false, toolChoiceAuto: false },
    }, { probeVersion: "not-a-number" }),
    presetEntry("custom-v5-confirmed-lite", {
      grade: "lite",
      confidence: "confirmed",
      signals: { instructionFidelity: false, toolChoiceAuto: false },
    }, { probeVersion: 5 }),
    presetEntry("custom-full", { grade: "full", signals: { instructionFidelity: true, toolChoiceAuto: true } }),
    presetEntry("custom-standard", { grade: "standard", signals: { instructionFidelity: false, toolChoiceAuto: true } }),
    presetEntry("custom-versionless-full", { grade: "full", signals: { instructionFidelity: true, toolChoiceAuto: true } }, { probeVersion: undefined }),
    presetEntry("custom-versionless-standard", { grade: "standard", signals: { instructionFidelity: false, toolChoiceAuto: true } }, { probeVersion: undefined }),
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

  const incompleteReasoning = await probeAgainst(capabilityMockServer({
    autoToolCalls: false,
    autoNoCallReasoningOnly: true,
    autoNoCallFinishReason: "length",
  }), "provider/incomplete-reasoning-auto-tool");
  assert.equal(incompleteReasoning.ok, true, "incomplete reasoning probe must not block a conformant endpoint");
  assert.deepEqual(
    incompleteReasoning.profile.capability,
    { grade: "standard", signals: { instructionFidelity: true, toolChoiceAuto: false } },
    "reasoning-only length completions are incomplete, not confirmed lite evidence",
  );

  const hiddenReasoningOnly = await probeAgainst(capabilityMockServer({
    autoToolCalls: false,
    autoNoCallReasoningOnly: true,
    autoNoCallFinishReason: "stop",
  }), "provider/hidden-reasoning-auto-tool");
  assert.equal(hiddenReasoningOnly.ok, true, "reasoning-only stop probe must not block a conformant endpoint");
  assert.deepEqual(
    hiddenReasoningOnly.profile.capability,
    { grade: "standard", signals: { instructionFidelity: true, toolChoiceAuto: false } },
    "hidden reasoning without visible content is not confirmed no-call evidence even when finish_reason is stop",
  );

  // A transient persona/config refresh failure must keep a proven runner
  // usable, while cold start still fails loud rather than launching OpenCode's
  // coding default or an empty config. These calls mirror refresh's lazy shape.
  {
    const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
    const configBuilder = require("../src/main/runtime/opencode-config-builder.js");
    const ipcUtils = require("../src/main/ipc-utils.js");
    const originalEnsureProcess = OpencodeAgentSession.prototype.ensureProcess;
    const originalBuildSharedBaseConfig = configBuilder.buildSharedBaseConfig;
    const originalRefreshRemoteConfigForSend = ipcUtils.refreshRemoteConfigForSend;
    let ensureProcessCalls = 0;
    OpencodeAgentSession.prototype.ensureProcess = function countedEnsureProcess(...args) {
      ensureProcessCalls += 1;
      return originalEnsureProcess.apply(this, args);
    };
    const preparePool = (pool) => {
      pool._opencodeMcpServers = () => ({});
      pool._opencodePlugins = () => [];
      pool._opencodeGuideContent = () => "# Lily";
      return pool;
    };
    try {
      const coldPersonaPool = preparePool(new SessionRunnerPool());
      coldPersonaPool._opencodeBasePersona = () => "";
      assert.throws(
        () => coldPersonaPool.ensure("session_cold_empty_persona", process.cwd(), {}, { lazy: true }),
        (err) => err?.message === "LILY_BASE_PERSONA_UNAVAILABLE",
      );
      assert.equal(coldPersonaPool.has("session_cold_empty_persona"), false,
        "cold empty-persona failure leaves the runner map empty");
      assert.equal(ensureProcessCalls, 0, "cold empty-persona failure never reaches ensureProcess");

      configBuilder.buildSharedBaseConfig = () => ({
        ok: false,
        reason: "COLD_INVALID_CONFIG",
        model: null,
        configContent: null,
      });
      const coldConfigPool = preparePool(new SessionRunnerPool());
      coldConfigPool._opencodeBasePersona = () => "# Lily base persona";
      assert.throws(
        () => coldConfigPool.ensure("session_cold_invalid_config", process.cwd(), {}, { lazy: true }),
        (err) => err?.message === "OPENCODE_CONFIG_INVALID:COLD_INVALID_CONFIG",
      );
      assert.equal(coldConfigPool.has("session_cold_invalid_config"), false,
        "cold invalid-config failure leaves the runner map empty");
      assert.equal(ensureProcessCalls, 0, "cold invalid-config failure never reaches ensureProcess");

      configBuilder.buildSharedBaseConfig = originalBuildSharedBaseConfig;
      const healthyPool = preparePool(new SessionRunnerPool());
      healthyPool._opencodeBasePersona = () => "# Lily healthy persona";
      const refreshExtra = { activeSkillIds: [], resumeSessionId: null };
      const healthyRunner = healthyPool.ensure(
        "session_last_known_good",
        process.cwd(),
        refreshExtra,
        { lazy: true },
      );
      assert.ok(healthyRunner.spawnOptions?.opencodeConfig,
        "test precondition: healthy runner carries a nonempty OpenCode config");
      assert.ok(healthyRunner.spawnOptions?.modelConfigFingerprint,
        "test precondition: healthy runner carries a model-config fingerprint");
      ipcUtils.refreshRemoteConfigForSend = async () => ({ ok: true });
      const callsAfterInitialEnsure = ensureProcessCalls;
      const successfulRefresh = await healthyRunner.spawnOptions.refreshManagedModelConfig();
      assert.deepEqual(successfulRefresh, { ok: true },
        "a valid managed refresh still rebuilds config successfully");
      assert.equal(ensureProcessCalls, callsAfterInitialEnsure + 1,
        "a valid managed refresh reaches ensureProcess with fresh config");

      const healthySpawnOptions = healthyRunner.spawnOptions;
      const healthyConfig = healthySpawnOptions.opencodeConfig;
      const healthyFingerprint = healthySpawnOptions.modelConfigFingerprint;
      const storedRefreshManagedModelConfig = healthySpawnOptions.refreshManagedModelConfig;
      const callsAfterHealthyEnsure = ensureProcessCalls;

      healthyPool._opencodeBasePersona = () => "";
      const personaFallback = healthyPool.ensure(
        "session_last_known_good",
        process.cwd(),
        refreshExtra,
        { lazy: true },
      );
      assert.equal(personaFallback, healthyRunner,
        "transient empty persona returns the same last-known-good runner");
      assert.equal(healthyRunner.spawnOptions, healthySpawnOptions,
        "empty-persona fallback must not replace or mutate spawnOptions");
      assert.equal(healthyRunner.spawnOptions.opencodeConfig, healthyConfig,
        "empty-persona fallback keeps the last-known-good config byte-identical");
      assert.equal(healthyRunner.spawnOptions.modelConfigFingerprint, healthyFingerprint,
        "empty-persona fallback keeps the last-known-good fingerprint");
      assert.equal(ensureProcessCalls, callsAfterHealthyEnsure,
        "empty-persona fallback does not call ensureProcess again");

      const personaRefreshFailure = await storedRefreshManagedModelConfig();
      assert.equal(personaRefreshFailure.ok, false,
        "managed refresh must report failure when a fresh persona cannot be built");
      assert.equal(personaRefreshFailure.error, "LILY_BASE_PERSONA_UNAVAILABLE",
        "managed refresh surfaces the fresh-persona failure code");
      assert.equal(healthyRunner.spawnOptions, healthySpawnOptions,
        "failed managed persona refresh preserves last-known-good spawnOptions");
      assert.equal(ensureProcessCalls, callsAfterHealthyEnsure,
        "failed managed persona refresh does not call ensureProcess");

      healthyPool._opencodeBasePersona = () => "# Lily recovered persona";
      configBuilder.buildSharedBaseConfig = () => ({
        ok: false,
        reason: "TRANSIENT_INVALID_CONFIG",
        model: null,
        configContent: null,
      });
      const configFallback = healthyPool.ensure(
        "session_last_known_good",
        process.cwd(),
        refreshExtra,
        { lazy: true },
      );
      assert.equal(configFallback, healthyRunner,
        "transient invalid config returns the same last-known-good runner");
      assert.equal(healthyRunner.spawnOptions, healthySpawnOptions,
        "invalid-config fallback must not replace or mutate spawnOptions");
      assert.equal(healthyRunner.spawnOptions.opencodeConfig, healthyConfig,
        "invalid-config fallback keeps the last-known-good config byte-identical");
      assert.equal(healthyRunner.spawnOptions.modelConfigFingerprint, healthyFingerprint,
        "invalid-config fallback keeps the last-known-good fingerprint");
      assert.equal(ensureProcessCalls, callsAfterHealthyEnsure,
        "invalid-config fallback does not call ensureProcess again");

      const configRefreshFailure = await storedRefreshManagedModelConfig();
      assert.equal(configRefreshFailure.ok, false,
        "managed refresh must report failure when fresh shared config is invalid");
      assert.equal(configRefreshFailure.error, "OPENCODE_CONFIG_INVALID:TRANSIENT_INVALID_CONFIG",
        "managed refresh surfaces the fresh-config failure reason");
      assert.equal(healthyRunner.spawnOptions, healthySpawnOptions,
        "failed managed config refresh preserves last-known-good spawnOptions");
      assert.equal(healthyRunner.spawnOptions.opencodeConfig, healthyConfig,
        "failed managed config refresh preserves last-known-good config bytes");
      assert.equal(healthyRunner.spawnOptions.modelConfigFingerprint, healthyFingerprint,
        "failed managed config refresh preserves last-known-good fingerprint");
      assert.equal(ensureProcessCalls, callsAfterHealthyEnsure,
        "failed managed config refresh does not call ensureProcess");

      // A later real send is non-lazy. Even while persona/config refresh is
      // still broken, it must re-enter ensureProcess with the exact cached
      // options so a dead last-known-good runner can restart.
      healthyPool._opencodeBasePersona = () => "# Lily cached-fallback persona";
      let cachedRestartCalls = 0;
      healthyRunner._ensureStarted = async () => {
        cachedRestartCalls += 1;
        return null;
      };
      const nonLazyFallback = healthyPool.ensure(
        "session_last_known_good",
        process.cwd(),
        refreshExtra,
        { lazy: false },
      );
      assert.equal(nonLazyFallback, healthyRunner,
        "non-lazy fallback keeps the same last-known-good runner");
      assert.equal(healthyRunner.spawnOptions, healthySpawnOptions,
        "non-lazy fallback restarts from the exact cached spawnOptions object");
      assert.equal(cachedRestartCalls, 1,
        "non-lazy fallback actually restarts a dead cached runner");
      assert.equal(ensureProcessCalls, callsAfterHealthyEnsure + 1,
        "non-lazy fallback re-enters ensureProcess exactly once");
    } finally {
      OpencodeAgentSession.prototype.ensureProcess = originalEnsureProcess;
      configBuilder.buildSharedBaseConfig = originalBuildSharedBaseConfig;
      ipcUtils.refreshRemoteConfigForSend = originalRefreshRemoteConfigForSend;
    }
  }

  // --- 1. presets: capability grade normalization + env delivery ---
  const normalizedConfirmed = modelPresets.updateCustomPreset("custom-lite", {
    label: "custom-lite",
    model: "provider/custom-lite",
    baseUrl: "https://example.invalid/v1",
    protocol: "openai",
  });
  assert.equal(normalizedConfirmed.ok, true, `confirmed lite should normalize: ${JSON.stringify(normalizedConfirmed)}`);
  const persistedConfirmed = JSON.parse(fs.readFileSync(path.join(tmp, "model-settings.json"), "utf8"))
    .customPresets.find((preset) => preset.id === "custom-lite");
  assert.equal(persistedConfirmed.compatibilityProfile.capability.confidence, "confirmed",
    "known capability confidence must survive normalization and persistence");

  modelPresets.setActivePreset("custom-lite");
  assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_CAPABILITY_GRADE, "lite",
    "a confirmed lite grade must reach the runtime env");
  assert.equal(modelPresets.getUserApiEnv().LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "24576",
    "the probed prompt budget still rides the env untouched");

  modelPresets.setActivePreset("custom-legacy-lite");
  const legacyLiteEnv = modelPresets.getUserApiEnv();
  assert.equal(legacyLiteEnv.LILY_MODEL_CAPABILITY_GRADE, undefined,
    "a legacy lite profile must not emit a destructive grade without confirmed evidence");
  assert.equal(legacyLiteEnv.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, undefined,
    "a v5 prompt sample length is stale evidence and must not trim the strong-default guide");
  assert.equal(modelPresets.getActivePresetEnv().LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, undefined,
    "the public custom-preset env must also suppress stale v5 prompt ceilings");

  modelPresets.setActivePreset("custom-unconfirmed-lite");
  const unconfirmedLiteEnv = modelPresets.getUserApiEnv();
  assert.equal(unconfirmedLiteEnv.LILY_MODEL_CAPABILITY_GRADE, undefined,
    "an unconfirmed lite profile must not emit a destructive grade");
  assert.equal(unconfirmedLiteEnv.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "24576",
    "a v6 observed prompt ceiling remains independent of lite confidence");

  for (const presetId of [
    "custom-versionless-confirmed-lite",
    "custom-nonnumeric-confirmed-lite",
    "custom-v5-confirmed-lite",
  ]) {
    modelPresets.setActivePreset(presetId);
    const staleEvidenceEnv = modelPresets.getUserApiEnv();
    assert.equal(staleEvidenceEnv.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, undefined,
      `${presetId} must not emit an unversioned/stale prompt ceiling`);
    assert.equal(staleEvidenceEnv.LILY_MODEL_CAPABILITY_GRADE, undefined,
      `${presetId} must not emit destructive lite without finite v6+ evidence`);
    assert.equal(modelPresets.getActivePresetEnv().LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, undefined,
      `${presetId} must suppress stale prompt evidence in the public preset env too`);
    assert.equal(modelPresets.getActivePresetEnv().LILY_MODEL_CAPABILITY_GRADE, undefined,
      `${presetId} must suppress stale lite evidence in the public preset env too`);
  }

  modelPresets.setActivePreset("custom-versionless-full");
  assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_CAPABILITY_GRADE, "full",
    "full remains non-destructive and unchanged when probeVersion is absent");
  modelPresets.setActivePreset("custom-versionless-standard");
  assert.equal(modelPresets.getUserApiEnv().LILY_MODEL_CAPABILITY_GRADE, "standard",
    "standard remains non-destructive and unchanged when probeVersion is absent");

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
    pool._opencodeGuideContent = () => "# Lily\n\nKeep the full strong-default guide.";
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
  assert.equal(full.spawnOptions.env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "24576",
    "full preserves its probed budget without tightening it to the lite budget");

  const standard = buildFor("custom-standard", "session_standard");
  assert.equal(standard.mcpOpts.capabilityGrade, "standard", "standard grade reaches MCP assembly without changing it");
  const standardCfg = JSON.parse(standard.spawnOptions.opencodeConfig || "{}");
  assert.equal(standardCfg.permission?.task, undefined, "standard keeps today's permission set — no task rule at all");
  assert.equal(standard.spawnOptions.env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "24576",
    "standard preserves its probed budget without tightening it to the lite budget");

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
  const strongDefaultBytes = JSON.stringify(stripModel(ungradedCfg));
  assert.equal(JSON.stringify(stripModel(fullCfg)), strongDefaultBytes,
    "a full grade must stay byte-identical to today's config in phase 1 (不变笨 hard gate)");
  assert.equal(JSON.stringify(stripModel(standardCfg)), strongDefaultBytes,
    "a standard grade must stay byte-identical to today's config in phase 1");

  for (const [presetId, sessionId] of [
    ["custom-legacy-lite", "session_legacy_lite"],
    ["custom-unconfirmed-lite", "session_unconfirmed_lite"],
  ]) {
    const safe = buildFor(presetId, sessionId);
    const safeCfg = JSON.parse(safe.spawnOptions.opencodeConfig || "{}");
    assert.equal(safe.mcpOpts.capabilityGrade, "",
      `${presetId} must keep the full MCP assembly instead of applying lite filtering`);
    assert.equal(safeCfg.permission?.task, undefined,
      `${presetId} must keep task/subagents available`);
    assert.notEqual(safe.spawnOptions.env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "8000",
      `${presetId} must not apply the destructive lite guide trim`);
    assert.equal(safe.spawnOptions.guidance, ungraded.spawnOptions.guidance,
      `${presetId} must keep the strong-default guide byte-identical`);
    assert.equal(JSON.stringify(stripModel(safeCfg)), strongDefaultBytes,
      `${presetId} must keep the strong-default config byte-identical`);
  }

  // --- 3. kill switch pins everything to standard ---
  process.env.LILY_ENABLE_CAPABILITY_GRADING = "0";
  try {
    const killed = buildFor("custom-lite", "session_killed");
    assert.equal(killed.mcpOpts.capabilityGrade, "", "kill switch blanks the grade before it reaches MCP assembly");
    const killedCfg = JSON.parse(killed.spawnOptions.opencodeConfig || "{}");
    assert.equal(killedCfg.permission?.task, undefined, "kill switch restores today's permission set for a lite model");
    assert.equal(killed.spawnOptions.env.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS, "24576",
      "kill switch preserves the probed budget without the lite tightening");
    assert.equal(killed.spawnOptions.guidance, ungraded.spawnOptions.guidance,
      "kill switch restores the strong-default guide without the lite execution protocol");
  } finally {
    delete process.env.LILY_ENABLE_CAPABILITY_GRADING;
  }

  // --- 4. real MCP assembly: lite support is additive, never capability-destructive ---
  const realPool = new SessionRunnerPool();
  const baseline = realPool._opencodeMcpServers(null, {});
  assert(baseline.lily_tool_broker, "baseline MCP assembly must include the tool broker (test would be vacuous otherwise)");
  assert(Object.keys(baseline).length > 1, "baseline must carry more than the broker for the lite filter to mean anything");

  const previousGlobalBrokerContext = process.env.LILY_TOOL_BROKER_CONTEXT;
  process.env.LILY_TOOL_BROKER_CONTEXT = JSON.stringify({
    sessionId: "stale_global_session",
    activeSkillIds: ["lily-mail-assistant"],
  });
  let firstSharedBrokerServers;
  let secondSharedBrokerServers;
  try {
    firstSharedBrokerServers = realPool._opencodeMcpServers(["lily-runtime-packs"], {
      sessionId: "session_broker_context_one",
    });
    secondSharedBrokerServers = realPool._opencodeMcpServers(["lily-runtime-packs"], {
      sessionId: "session_broker_context_two",
    });
  } finally {
    if (previousGlobalBrokerContext === undefined) delete process.env.LILY_TOOL_BROKER_CONTEXT;
    else process.env.LILY_TOOL_BROKER_CONTEXT = previousGlobalBrokerContext;
  }
  assert.deepEqual(
    JSON.parse(firstSharedBrokerServers.lily_tool_broker.env.LILY_TOOL_BROKER_CONTEXT),
    { platformOnly: true, activeSkillIds: [], characterWorlds: { enabled: false }, runtime: { browserAvailable: false } },
    "the app-wide serve gets explicit platform-only broker context, never one conversation's identity",
  );
  assert.equal(
    JSON.stringify(firstSharedBrokerServers),
    JSON.stringify(secondSharedBrokerServers),
    "two Lily session ids produce byte-identical shared MCP config instead of one serve signature per conversation",
  );
  modelPresets.setActivePreset("custom-nograde");
  const sharedConfigPool = new SessionRunnerPool();
  sharedConfigPool._opencodePlugins = () => [];
  sharedConfigPool._opencodeGuideContent = () => "# Lily";
  const sharedRunnerOne = sharedConfigPool.ensure("shared_config_one", process.cwd(), {
    activeSkillIds: ["lily-runtime-packs"],
  }, { lazy: true });
  const sharedRunnerTwo = sharedConfigPool.ensure("shared_config_two", process.cwd(), {
    activeSkillIds: ["lily-runtime-packs"],
  }, { lazy: true });
  assert.equal(sharedRunnerOne.spawnOptions.opencodeConfig, sharedRunnerTwo.spawnOptions.opencodeConfig,
    "two Lily sessions with the same scope produce byte-identical full shared OpenCode config");

  const liteServers = realPool._opencodeMcpServers(null, { capabilityGrade: "lite" });
  assert.deepEqual(liteServers, baseline,
    "lite guidance must not remove executable MCP capabilities such as Playwright, mail, process jobs, or learned systems");

  const liteCompatServers = realPool._opencodeMcpServers(null, { capabilityGrade: "lite", toolCompat: true });
  assert.equal(liteCompatServers.lily_tb !== undefined, true,
    "lite still composes with tool-shape compat (short broker key)");
  assert.equal(liteCompatServers.lily_fi !== undefined, true,
    "lite still composes with tool-shape compat (short file-intelligence key)");
  assert.equal(Object.keys(liteCompatServers).length, Object.keys(baseline).length,
    "tool-shape compatibility must rename servers without dropping capabilities");

  const standardServers = realPool._opencodeMcpServers(null, { capabilityGrade: "standard" });
  assert.deepEqual(standardServers, baseline, "standard grade must not change MCP assembly at all");
  const fullServers = realPool._opencodeMcpServers(null, { capabilityGrade: "full" });
  assert.deepEqual(fullServers, baseline, "full grade must not change MCP assembly at all (phase 1)");

  // --- 5. startup guards: never fall through to OpenCode's coding persona ---
  const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
  const configBuilder = require("../src/main/runtime/opencode-config-builder.js");
  const originalEnsureProcess = OpencodeAgentSession.prototype.ensureProcess;
  const originalBuildSharedBaseConfig = configBuilder.buildSharedBaseConfig;
  let ensureProcessCalls = 0;
  OpencodeAgentSession.prototype.ensureProcess = function blockedEnsureProcess() {
    ensureProcessCalls += 1;
  };
  try {
    const emptyPersonaPool = new SessionRunnerPool();
    emptyPersonaPool._opencodeBasePersona = () => "";
    emptyPersonaPool._opencodeMcpServers = () => ({});
    emptyPersonaPool._opencodePlugins = () => [];
    emptyPersonaPool._opencodeGuideContent = () => "# Lily";
    assert.throws(
      () => emptyPersonaPool.ensure("session_empty_persona", process.cwd(), {}, { lazy: true }),
      (err) => err?.message === "LILY_BASE_PERSONA_UNAVAILABLE",
      "an empty Lily base persona must fail loud before OpenCode can use its coding-CLI default",
    );
    assert.equal(emptyPersonaPool.has("session_empty_persona"), false,
      "the empty-persona guard must not insert a newly-created runner");
    assert.equal(ensureProcessCalls, 0, "the empty-persona guard must run before runner startup");

    configBuilder.buildSharedBaseConfig = () => ({
      ok: false,
      reason: "BROKEN_SHARED_CONFIG",
      model: null,
      configContent: null,
    });
    const invalidConfigPool = new SessionRunnerPool();
    invalidConfigPool._opencodeBasePersona = () => "# Lily base persona";
    invalidConfigPool._opencodeMcpServers = () => ({});
    invalidConfigPool._opencodePlugins = () => [];
    invalidConfigPool._opencodeGuideContent = () => "# Lily";
    assert.throws(
      () => invalidConfigPool.ensure("session_invalid_config", process.cwd(), {}, { lazy: true }),
      (err) => err?.message === "OPENCODE_CONFIG_INVALID:BROKEN_SHARED_CONFIG",
      "an invalid shared config must fail loud with its reason",
    );
    assert.equal(invalidConfigPool.has("session_invalid_config"), false,
      "the invalid-config guard must not insert a newly-created runner");
    assert.equal(ensureProcessCalls, 0,
      "an invalid config must never reach ensureProcess with opencodeConfig:\"\"");
  } finally {
    OpencodeAgentSession.prototype.ensureProcess = originalEnsureProcess;
    configBuilder.buildSharedBaseConfig = originalBuildSharedBaseConfig;
  }

  // --- 6. recipe application: calibrated guide hint --------------------------
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

  // Confirmed lite models get a compact additive execution loop. Grades other
  // than lite must keep the strong-default guide byte-for-byte unchanged.
  const liteGuide = realPool._appendModelRecipeHints(guide, {
    LILY_MODEL_CAPABILITY_GRADE: "lite",
    LILY_MODEL_RECIPES: "{}",
  });
  assert.match(liteGuide, /## Execution Protocol \(lite support\)/,
    "confirmed lite runtime grade appends the execution protocol");
  assert.match(liteGuide, /one verified step at a time/i,
    "lite protocol makes progress one verifiable step at a time");
  assert.match(liteGuide, /Call one tool, read its result/i,
    "lite protocol closes the loop around each tool result");
  assert.match(liteGuide, /lily_tool_broker.*before claiming a task is unavailable/i,
    "lite protocol discovers platform capability before declaring it unavailable");
  assert.match(liteGuide, /until the requested deliverable is verified/i,
    "lite protocol continues through delivery verification");
  assert.equal(realPool._appendModelRecipeHints(liteGuide, {
    LILY_MODEL_CAPABILITY_GRADE: "lite",
    LILY_MODEL_RECIPES: "{}",
  }), liteGuide, "lite execution protocol is idempotent");
  assert.equal(realPool._appendModelRecipeHints(guide, {
    LILY_MODEL_CAPABILITY_GRADE: "full",
    LILY_MODEL_RECIPES: "{}",
  }), guide, "full keeps the strong-default guide byte-identical");
  assert.equal(realPool._appendModelRecipeHints(guide, {
    LILY_MODEL_CAPABILITY_GRADE: "standard",
    LILY_MODEL_RECIPES: "{}",
  }), guide, "standard keeps the strong-default guide byte-identical");

  // Probed output ceiling: LOW ceilings get a concrete chunking threshold;
  // ample ceilings inject nothing (strong models pay zero).
  const ceilingHinted = realPool._appendModelRecipeHints(guide, { LILY_MODEL_RECIPES: '{"outputTokenCeiling":4096}' });
  assert.match(ceilingHinted, /about 4096 tokens/, "low output ceiling injects the measured number");
  assert.match(ceilingHinted, /~273 lines/, "the ceiling translates to a concrete line estimate");
  assert.match(ceilingHinted, /APPEND the rest with edit/, "the hint teaches the chunked-write recovery path");
  assert.equal(realPool._appendModelRecipeHints(guide, { LILY_MODEL_RECIPES: '{"outputTokenCeiling":32768}' }), guide,
    "ample ceilings inject nothing — strong models keep today's guide byte-identical");
  const combined = realPool._appendModelRecipeHints(guide, { LILY_MODEL_RECIPES: '{"toolCallHint":true,"outputTokenCeiling":2048}' });
  assert.match(combined, /NATIVE structured function call/, "combined recipes merge into one section");
  assert.match(combined, /about 2048 tokens/, "both hints coexist");

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

  const crowdedLiteGuide = realPool._appendModelRecipeHints(
    `# Lily\n\nIdentity.\n\n## Skill A\n\n${"alpha ".repeat(50)}\n\n## Skill B\n\n${"beta ".repeat(65)}`,
    { LILY_MODEL_CAPABILITY_GRADE: "lite", LILY_MODEL_RECIPES: "{}" },
  );
  const cutLiteGuide = truncateSystemGuidance(crowdedLiteGuide, 1000);
  assert.match(cutLiteGuide, /Work one verified step at a time/,
    "lite execution protocol outranks ordinary skill sections under its tight guide budget");

  // Real 4k weak-model budget: the generated English identity/core guide plus
  // both runtime guardrails and the lite protocol must fit without falling back
  // to a blind head cut that drops the protocols.
  const { buildAgentGuideContent } = require("../src/main/skill-manager.js");
  const { appendLargeInputProtocolGuidance } = require("../src/main/large-input-protocol.js");
  const { appendProcessJobProtocolGuidance } = require("../src/main/process-job-protocol.js");
  const realLiteGuide = realPool._appendModelRecipeHints(
    appendProcessJobProtocolGuidance(
      appendLargeInputProtocolGuidance(buildAgentGuideContent([], "en")),
    ),
    { LILY_MODEL_CAPABILITY_GRADE: "lite", LILY_MODEL_RECIPES: "{}" },
  );
  const realCutLiteGuide = truncateSystemGuidance(realLiteGuide, 4000);
  assert.ok(realCutLiteGuide.length <= 4000,
    `real lite guide must obey the measured 4k cap, got ${realCutLiteGuide.length}`);
  assert.match(realCutLiteGuide, /## Large Input Protocol/,
    "real 4k guide keeps the large-input guardrail");
  assert.match(realCutLiteGuide, /do not read or attach the entire input blindly/i,
    "real 4k guide keeps actionable large-input guidance");
  assert.match(realCutLiteGuide, /## Process Job Protocol/,
    "real 4k guide keeps the process-job guardrail");
  assert.match(realCutLiteGuide, /agent runtime remains the engine of record/i,
    "real 4k guide keeps actionable process-job guidance");
  assert.match(realCutLiteGuide, /## Execution Protocol \(lite support\)/,
    "real 4k guide keeps the lite execution guardrail");
  assert.match(realCutLiteGuide, /Work one verified step at a time/,
    "real 4k guide keeps actionable lite protocol content, not only an omitted-title notice");

  console.log("capability-grading: ok");
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function capabilityMockServer({
  autoToolCalls = true,
  autoNoCallReasoningOnly = false,
  autoNoCallFinishReason = "stop",
} = {}) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const autoChoice = parsed.tool_choice === "auto";
      const userText = (parsed.messages || [])
        .filter((message) => message?.role === "user")
        .map((message) => String(message.content || ""))
        .join(" ");
      const wantsToolCall = hasTools && (!autoChoice || autoToolCalls);
      const autoNoCall = hasTools && autoChoice && !wantsToolCall;
      const content = userText.includes("PONG") ? "PONG" : "pong";
      const noCallShape = autoNoCall && autoNoCallReasoningOnly
        ? { reasoning: "Still reasoning when the output limit stopped this response." }
        : { content };
      const finishReason = wantsToolCall ? "tool_calls" : autoNoCall ? autoNoCallFinishReason : "stop";
      const toolCall = { id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send({
          id: "chatcmpl-incomplete-reasoning",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{
            index: 0,
            delta: wantsToolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : noCallShape,
            finish_reason: null,
          }],
        });
        send({
          id: "chatcmpl-incomplete-reasoning",
          object: "chat.completion.chunk",
          model: parsed.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-incomplete-reasoning",
        object: "chat.completion",
        model: parsed.model,
        choices: [{
          index: 0,
          message: wantsToolCall
            ? { role: "assistant", content: null, tool_calls: [toolCall] }
            : { role: "assistant", content: null, ...noCallShape },
          finish_reason: finishReason,
        }],
      }));
    });
  });
}

async function probeAgainst(server, model) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await require("../src/main/model-compatibility-probe.js").probeCustomModelProfile({
      protocol: "openai",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk-test-probe",
      model,
      timeoutMs: 5_000,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
