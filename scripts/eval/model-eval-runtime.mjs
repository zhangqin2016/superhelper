import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildCompatibilityProfileRuntimeEnv } = require("../../src/main/model-presets.js");
const { buildSharedBaseConfig } = require("../../src/main/runtime/opencode-config-builder.js");
const { buildAgentBasePersona, buildAgentGuideContent } = require("../../src/main/skill-manager.js");
const { buildAutonomyGuidance } = require("../../src/main/agent-autonomy-guidance.js");
const { SessionRunnerPool } = require("../../src/main/session-runner-pool.js");

/**
 * Build the portion of Lily's runtime that the standalone OpenCode CLI can
 * faithfully exercise: production compatibility-profile env mapping, shared
 * provider config, primary persona, lite task shaping, and the runner's model
 * recipe/lite guidance. Session MCP routing and per-turn orchestration require
 * the Electron host and are intentionally outside this live eval.
 */
/**
 * The full per-turn guide, for evals that measure the guide itself.
 *
 * Production puts this text on `body.system` every turn (see
 * session-runner-pool). The standalone CLI cannot set `body.system`, so it
 * rides the agent prompt instead: a different channel, the same text in the
 * same role. Callers that do NOT ask for it get exactly the previous behaviour,
 * so existing model-eval baselines keep their meaning.
 */
export function buildEvalPlatformConfig({
  lilyEnv = {},
  compatibilityProfile = null,
  agentGuide = null,
  permissionMode = "",
} = {}) {
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
  let basePrompt = runnerPool._appendModelRecipeHints(basePersona, runtimeEnv);
  if (agentGuide && Array.isArray(agentGuide.skills)) {
    const guideText = buildAgentGuideContent(agentGuide.skills, agentGuide.locale || "zh-CN");
    if (!String(guideText || "").trim()) {
      return { ok: false, reason: "LILY_AGENT_GUIDE_UNAVAILABLE", model: null, configContent: null, runtimeEnv };
    }
    basePrompt = `${basePrompt}\n\n${guideText}`;
  }
  // The runner appends this per prompt for full-autonomy sessions; an eval that
  // measures autonomy behaviour has to carry it too.
  const autonomy = buildAutonomyGuidance(permissionMode, agentGuide?.locale || "zh-CN");
  if (autonomy) basePrompt = `${basePrompt}\n\n${autonomy}`;
  const liteGrade = runtimeEnv.LILY_MODEL_CAPABILITY_GRADE === "lite";
  let config = buildSharedBaseConfig({
    lilyEnv: runtimeEnv,
    basePrompt,
    disallowedTools: liteGrade ? ["task"] : [],
  });
  if (agentGuide) {
    // Production leaves external_directory on "ask" because a human answers it,
    // and reading a skill guide is exactly what the guide tells the model to do.
    // Non-interactively "ask" becomes auto-reject, which killed the turn partway
    // and made cases flap between a text answer and an empty one — the harness
    // measuring itself. edit/write/bash stay gated, so an eval still cannot
    // mutate anything.
    const parsed = JSON.parse(config.configContent);
    parsed.permission = { ...(parsed.permission || {}), external_directory: "allow" };
    config = { ...config, configContent: JSON.stringify(parsed, null, 2) };
  }

  return {
    ...config,
    runtimeEnv,
    basePrompt,
    guideBytes: Buffer.byteLength(basePrompt, "utf8"),
  };
}
