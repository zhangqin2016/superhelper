"use strict";

const { createCharacterWorldsRuntime, loadScene } = require("./turn-runtime-adapter");
const { compileTurnWorldCharacterContext } = require("./turn-world-book");

function baseInput(state, runner, diagnostic) {
  return {
    userText: String(state.enginePayload?.text || state.currentPayload?.rawText || ""),
    taskContract: state.pendingTaskContract || state.taskContract || null,
    model: runner?.spawnOptions?.model || null,
    onDiagnostic: diagnostic,
  };
}

function sceneMemory(sessionManager, ownerScope, sessionId, characterRevisionId) {
  try {
    const { CharacterSceneMemoryService, sceneMemorySection } = require("./scene-memory-service");
    const memory = new CharacterSceneMemoryService({
      store: sessionManager?._store?.(), ownerScope,
    }).listMemory({ sessionId, characterRevisionId });
    return sceneMemorySection(memory);
  } catch {
    return null;
  }
}

function compileTurnContext({ orchestrator, session, state, runner, log }) {
  state.characterWorldsPolicyReason = null;
  state.pendingWorldBookCheckpoint = null;
  try {
    const snapshot = state.characterWorldsSnapshot;
    if (snapshot?.snapshotStatus !== "ready") {
      state.characterWorldsPolicyReason = "snapshot_not_ready";
      return null;
    }
    const hasCharacter = snapshot.mode === "character" && Boolean(snapshot.characterRevisionId);
    const hasPersona = Boolean(snapshot.personaRevisionId);
    const hasBooks = Array.isArray(snapshot.worldBookBindings) && snapshot.worldBookBindings.length > 0;
    if (!hasCharacter && !hasPersona && !hasBooks) return null;
    const sessionManager = orchestrator.ctx.sessionManager;
    const owner = sessionManager?.resolveTurnOwnerScope?.(session.id);
    if (!owner?.ok || !owner.ownerScope) {
      state.characterWorldsPolicyReason = "identity_missing";
      return null;
    }
    const repository = orchestrator.ctx.characterWorldsRepository
      || sessionManager?._store?.()?.characterWorlds?.()
      || null;
    if (!repository) {
      state.characterWorldsPolicyReason = "activation_invalid";
      return null;
    }
    const store = sessionManager?._store?.() || null;

    if (!hasCharacter) {
      const policy = orchestrator._characterWorldsPolicy();
      if (policy?.enabled !== true) {
        state.characterWorldsPolicyReason = policy?.reason || "remote_disabled";
        return null;
      }
      const result = compileTurnWorldCharacterContext({
        repository, store, ownerScope: owner.ownerScope, sessionId: session.id,
        turnId: state.turnId, snapshot, revision: null,
        baseInput: baseInput(state, runner, (code) => (
          log.warn("character worlds composition failed open: %s", code)
        )),
        log,
      });
      state.pendingWorldBookCheckpoint = result.pendingCheckpoint;
      return result.compiled?.status === "compiled" ? result.compiled : null;
    }
    if (typeof repository.getRevision !== "function") {
      state.characterWorldsPolicyReason = "revision_missing";
      return null;
    }
    let scene = loadScene(repository, owner.ownerScope, session.id, snapshot.characterRevisionId);
    const runtime = orchestrator.characterWorldsRuntime
      || (orchestrator.characterWorldsRuntime = createCharacterWorldsRuntime(orchestrator, log));
    const admitted = runtime.admitTurn({
      ownerScope: owner.ownerScope,
      sessionId: session.id,
      turnId: state.turnId || snapshot.turnId || "turn:legacy-runtime",
      binding: {
        mode: "character",
        characterRevisionId: snapshot.characterRevisionId,
        personaRevisionId: snapshot.personaRevisionId,
        compatibilityProfile: snapshot.compatibilityProfile,
      },
      scene,
    });
    state.characterWorldsRuntimeSnapshot = admitted;
    if (admitted.mode !== "character") {
      state.characterWorldsPolicyReason = admitted.diagnostic?.reason || "remote_disabled";
      log.warn("character context compile skipped by policy: %s", state.characterWorldsPolicyReason);
      return null;
    }
    const revision = repository.getRevision(owner.ownerScope, snapshot.characterRevisionId);
    if (!revision) {
      state.characterWorldsPolicyReason = "revision_missing";
      return null;
    }
    const speakerDecision = runtime.planSpeakersSync(admitted, baseInput(state, runner).userText);
    state.characterWorldsSpeakerDecision = speakerDecision;
    state.characterWorldsRuntimeSnapshot = runtime.withSpeakerDecision(admitted, speakerDecision);
    if (speakerDecision.speakers?.[0] && scene) {
      scene = { ...scene, activeSpeakerRevisionId: speakerDecision.speakers[0] };
    }
    const result = runtime.compileTurn(state.characterWorldsRuntimeSnapshot, [], {
      ownerScope: owner.ownerScope,
      sessionId: session.id,
      turnId: state.turnId,
      repository,
      store,
      legacySnapshot: snapshot,
      revision,
      scene,
      sceneMemory: sceneMemory(
        sessionManager, owner.ownerScope, session.id, snapshot.characterRevisionId,
      ),
      baseInput: baseInput(state, runner, (code) => {
        state.characterWorldsPolicyReason = String(code || "activation_invalid");
        log.warn("character context compile failed open: %s", code);
      }),
    });
    state.pendingWorldBookCheckpoint = result.pendingCheckpoint;
    return result.compiled || (result.status === "compiled" ? result : null);
  } catch (err) {
    state.characterWorldsPolicyReason = "activation_invalid";
    log.warn("character context compilation failed open: %s", err?.message || String(err));
    return null;
  }
}

module.exports = { compileTurnContext };
