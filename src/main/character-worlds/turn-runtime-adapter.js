"use strict";

const { CharacterWorldsRuntime } = require("./runtime");
const { compileTurnWorldCharacterContext } = require("./turn-world-book");
const { planSceneSpeaker } = require("./speaker-planner");

function loadScene(repository, ownerScope, sessionId, characterRevisionId) {
  try {
    const group = require("./group-modes");
    const stored = group.getScene(repository, ownerScope, sessionId);
    if (!stored || !stored.participantCharacterRevisionIds.includes(characterRevisionId)) return null;
    return {
      ...stored,
      participants: stored.participantCharacterRevisionIds
        .map((revisionId) => repository.getRevision(ownerScope, revisionId))
        .filter(Boolean),
    };
  } catch {
    return null;
  }
}

function createCharacterWorldsRuntime(orchestrator, log) {
  return new CharacterWorldsRuntime({
    repository: orchestrator.ctx?.characterWorldsRepository || null,
    policy: () => orchestrator._characterWorldsPolicy(),
    planner: ({ snapshot, canonicalMessage }) => planSceneSpeaker({
      scene: snapshot.scene, snapshot, canonicalMessage,
    }),
    compile: ({ snapshot, context, repository }) => compileTurnWorldCharacterContext({
      repository: context?.repository || repository,
      store: context?.store || null,
      ownerScope: context?.ownerScope || snapshot.ownerScope,
      sessionId: context?.sessionId || snapshot.sessionId,
      turnId: context?.turnId || snapshot.turnId,
      snapshot: context?.legacySnapshot || snapshot,
      revision: context?.revision || null,
      scene: context?.scene || null,
      baseInput: {
        ...(context?.baseInput || {}),
        ...(context?.sceneMemory ? { sceneMemory: context.sceneMemory } : {}),
      },
      log,
    }),
    log: (event) => log.warn("character worlds runtime fallback: %s", JSON.stringify(event)),
  });
}

module.exports = { createCharacterWorldsRuntime, loadScene };
