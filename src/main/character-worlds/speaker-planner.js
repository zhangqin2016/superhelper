"use strict";

const { pickSpeaker } = require("./group-modes");

function boundedRoster(scene) {
  return (scene?.participants || []).slice(0, 32).map((revision) => ({
    id: revision.id,
    name: revision.canonical?.name || revision.displayName || revision.id,
    talkativeness: Number(revision.canonical?.talkativeness || revision.canonical?.talkativenessProbability || 0),
  }));
}

function planSceneSpeaker({ scene, snapshot, canonicalMessage = "" } = {}) {
  if (!scene || !snapshot) return { speakers: [], strategy: "native" };
  const picked = pickSpeaker({
    scene,
    strategy: scene.replyStrategy,
    latestCanonicalText: String(canonicalMessage).slice(0, 4096),
    spokenSinceUser: scene.lastSpeakerRevisionIds,
    roster: boundedRoster(scene),
    seedIdentity: `${snapshot.ownerScope}|${snapshot.sessionId}|${snapshot.turnId}`,
  });
  return {
    speakers: picked.characterRevisionId ? [picked.characterRevisionId] : [],
    strategy: picked.strategy,
    roster: boundedRoster(scene).map(({ id, name }) => ({ id, name })),
  };
}

module.exports = { boundedRoster, planSceneSpeaker };
