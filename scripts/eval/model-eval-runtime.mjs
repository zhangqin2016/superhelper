import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildCompatibilityProfileRuntimeEnv } = require("../../src/main/model-presets.js");
const { buildSharedBaseConfig } = require("../../src/main/runtime/opencode-config-builder.js");
const { buildAgentBasePersona } = require("../../src/main/skill-manager.js");
const { SessionRunnerPool } = require("../../src/main/session-runner-pool.js");

/**
 * Build the portion of Lily's runtime that the standalone OpenCode CLI can
 * faithfully exercise: production compatibility-profile env mapping, shared
 * provider config, primary persona, lite task shaping, and the runner's model
 * recipe/lite guidance. Session MCP routing and per-turn orchestration require
 * the Electron host and are intentionally outside this live eval.
 */
export function buildEvalPlatformConfig({ lilyEnv = {}, compatibilityProfile = null } = {}) {
  const runtimeEnv = {
    ...lilyEnv,
    ...buildCompatibilityProfileRuntimeEnv(compatibilityProfile),
  };
  const basePersona = buildAgentBasePersona();
  if (!String(basePersona || "").trim()) {
    return {
      ok: false,
      reason: "LILY_BASE_PERSONA_UNAVAILABLE",
      model: null,
      configContent: null,
      runtimeEnv,
    };
  }

  // Reuse the runner's production guidance shaper instead of maintaining an
  // eval-only interpretation of capability recipes or lite support.
  const runnerPool = new SessionRunnerPool();
  const basePrompt = runnerPool._appendModelRecipeHints(basePersona, runtimeEnv);
  const liteGrade = runtimeEnv.LILY_MODEL_CAPABILITY_GRADE === "lite";
  const config = buildSharedBaseConfig({
    lilyEnv: runtimeEnv,
    basePrompt,
    disallowedTools: liteGrade ? ["task"] : [],
  });
  return {
    ...config,
    runtimeEnv,
    basePrompt,
  };
}
