"use strict";

const {
  emptyConversationConfig,
  normalizeConversationConfig,
} = require("./conversation-config");
const {
  fallbackSnapshot,
  readySnapshot,
} = require("./turn-binding-snapshot");
const { readyCompositionSnapshot } = require("./composition-snapshot");

const FEATURE_DISABLED = "FEATURE_DISABLED";

/**
 * The product currently has one conversation context: the pinned character
 * card. Legacy persona and world-book data remains readable for migrations,
 * but this projection is the only shape allowed into a live turn.
 */
function projectCharacterCardConfig(value = {}) {
  const characterRevisionId = value?.characterRevisionId || null;
  return normalizeConversationConfig({
    characterRevisionId,
    greetingIndex: characterRevisionId ? value?.greetingIndex : null,
    sceneId: characterRevisionId ? value?.sceneId : null,
    groupId: characterRevisionId ? value?.groupId : null,
  });
}

function projectCharacterCardBinding(binding = {}) {
  const config = projectCharacterCardConfig(binding);
  return {
    ...binding,
    mode: config.characterRevisionId ? "character" : "native",
    characterRevisionId: config.characterRevisionId,
    personaRevisionId: null,
    compatibilityProfile: config.characterRevisionId
      ? (typeof binding.compatibilityProfile === "string" ? binding.compatibilityProfile : null)
      : null,
    greetingIndex: config.greetingIndex,
  };
}

function projectCharacterCardSnapshot(snapshot = {}) {
  const config = projectCharacterCardConfig({
    characterRevisionId: snapshot?.characterRevisionId,
    greetingIndex: snapshot?.greetingIndex,
    sceneId: snapshot?.sceneId,
    groupId: snapshot?.groupId,
  });
  if (!config.characterRevisionId) return fallbackSnapshot();
  const legacy = readySnapshot({
    bindingVersion: Number.isInteger(snapshot?.bindingVersion) && snapshot.bindingVersion >= 1
      ? snapshot.bindingVersion
      : 1,
    characterRevisionId: config.characterRevisionId,
    compatibilityProfile: snapshot?.compatibilityProfile,
  });
  return readyCompositionSnapshot({
    mode: "character",
    bindingVersion: Number.isInteger(snapshot?.bindingVersion) && snapshot.bindingVersion >= 1
      ? snapshot.bindingVersion
      : 1,
    previewVersion: Number.isInteger(snapshot?.previewVersion) && snapshot.previewVersion >= 0
      ? snapshot.previewVersion
      : 0,
    characterRevisionId: config.characterRevisionId,
    personaRevisionId: null,
    worldBookBindings: [],
    compatibilityProfile: snapshot?.compatibilityProfile,
    greetingIndex: config.greetingIndex,
    sceneId: config.sceneId,
    groupId: config.groupId,
  }) || legacy || fallbackSnapshot();
}

function emptyCharacterCardConfig() {
  return projectCharacterCardConfig(emptyConversationConfig());
}

module.exports = {
  FEATURE_DISABLED,
  emptyCharacterCardConfig,
  projectCharacterCardBinding,
  projectCharacterCardConfig,
  projectCharacterCardSnapshot,
};
