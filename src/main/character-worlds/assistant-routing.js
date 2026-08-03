"use strict";

const {
  buildWebSystemLearningPrompt,
  looksLikeWebSystemLearningIntent,
} = require("../web-system-learning-intent");
const { buildCharacterAuthoringEngineText, inferCharacterAuthoringIntent } = require("./authoring-intent");

function resolveEngineRouting(text, files, explicitKind, adjustment = null) {
  const allowedKind = ["character", "persona", "worldBook"].includes(explicitKind) ? explicitKind : null;
  const characterAuthoring = adjustment?.active
    ? adjustment
    : allowedKind ? { active: true, kind: allowedKind } : inferCharacterAuthoringIntent(text);
  if (characterAuthoring.active) {
    return {
      engineText: buildCharacterAuthoringEngineText(text, characterAuthoring),
      requiredSuccessfulTools: ["lily_character_draft"],
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
  if (!routing?.requiredSuccessfulTools?.includes("lily_character_draft")) return { ok: true };
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
