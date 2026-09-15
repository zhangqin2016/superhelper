"use strict";

const {
  buildWebSystemLearningPrompt,
  looksLikeWebSystemLearningIntent,
} = require("../web-system-learning-intent");
const { buildCharacterAuthoringEngineText, inferCharacterAuthoringIntent } = require("./authoring-intent");

const LIBRARY_KINDS = ["character", "persona", "worldBook", "agent"];

function resolveEngineRouting(text, files, explicitKind, adjustment = null) {
  const allowedKind = LIBRARY_KINDS.includes(explicitKind) ? explicitKind : null;
  const characterAuthoring = adjustment?.active
    ? adjustment
    : allowedKind ? { active: true, kind: allowedKind } : inferCharacterAuthoringIntent(text);
  if (characterAuthoring.active) {
    return {
      engineText: buildCharacterAuthoringEngineText(text, characterAuthoring),
      requiredSuccessfulTools: [characterAuthoring.kind === "agent" ? "lily_agent_draft" : "lily_character_draft"],
      webLearningIntent: false,
    };
  }
  const webLearningIntent = looksLikeWebSystemLearningIntent(text, files);
  return {
    engineText: webLearningIntent ? buildWebSystemLearningPrompt(text) : null,
    requiredSuccessfulTools: [],
    webLearningIntent,
  };
}

async function ensureRoutingAvailable(ctx, routing) {
  const required = routing?.requiredSuccessfulTools || [];
  if (required.includes("lily_agent_draft")) {
    // Agents need no remote policy — only the local kill switch. A role card
    // inside the draft additionally needs Character Worlds, which the tool
    // reports per call (CHARACTER_WORLDS_UNAVAILABLE + repair hint).
    const { agentsEnabled } = require("../agents/constants");
    return agentsEnabled()
      ? { ok: true }
      : { ok: false, error: "AGENTS_UNAVAILABLE", detail: "智能体功能已被本机开关关闭（LILY_AGENTS=0），无法创建智能体。" };
  }
  if (!required.includes("lily_character_draft")) return { ok: true };
  const { ensureCharacterAuthoringAvailable } = require("./authoring-availability");
  const { characterWorldsPolicyFor } = require("../ipc-character-guards");
  const availability = await ensureCharacterAuthoringAvailable({
    resolvePolicy: () => characterWorldsPolicyFor(ctx),
    refresh: (options) => require("../ipc-utils").refreshRemoteConfigForSend(options),
  });
  if (availability.ok) return availability;
  return {
    ...availability,
    detail: "角色库服务当前未启用或配置尚未刷新。Lily 已自动刷新服务配置，但仍无法安全保存角色；请检查生产服务的 CHARACTER_WORLDS_ENABLED 配置。",
  };
}

module.exports = { ensureRoutingAvailable, resolveEngineRouting };
