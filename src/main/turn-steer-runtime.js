"use strict";

const { isActiveTurnPhase } = require("./turn-active-phase");
const { runVisionPreflight, runDocumentPreflight } = require("./send-preflight");

function createTurnSteerMethods({ appendTimelineNotice, log, mergeDisplayFileMetadata }) {
  return {
    // Freeze the active turn before any preflight or engine await. A delayed steer
    // may only commit while that exact state/generation/runner claim is active.
    async _trySteer(session, text, files, opts = {}) {
      const sessionId = session.id;
      const state = this._state(sessionId);
      const runner = this.ctx.runnerPool.get(sessionId);
      if (
        !isActiveTurnPhase(state.phase)
        || state.finalizing
        || !state.turnId
        || state.terminalEmitted
        || state.admittedTurnInput?.turnId !== state.turnId
        || !state.admittedTurnInput?.ownerScope
        || !state.dispatchAttemptId
        || !runner?.isBusy?.()
        || typeof runner.steer !== "function"
      ) return { ok: false };
      const claim = Object.freeze({
        turnId: state.turnId,
        turnGeneration: state.turnGeneration || 0,
        runner,
        dispatchAttemptId: state.dispatchAttemptId,
        ownerScope: state.admittedTurnInput.ownerScope,
        characterWorldsSnapshot: state.characterWorldsSnapshot || null,
        state,
      });
      const claimStillActive = () => {
        const currentState = this.states.get(sessionId);
        return (
          currentState === claim.state
          && currentState?.turnId === claim.turnId
          && (currentState?.turnGeneration || 0) === claim.turnGeneration
          && isActiveTurnPhase(currentState?.phase)
          && currentState?.finalizing !== true
          && currentState?.terminalEmitted !== true
          && currentState?.admittedTurnInput?.turnId === claim.turnId
          && currentState?.admittedTurnInput?.ownerScope === claim.ownerScope
          && currentState?.dispatchAttemptId === claim.dispatchAttemptId
          && this.ctx.runnerPool.get(sessionId) === claim.runner
          && currentState?.characterWorldsSnapshot === claim.characterWorldsSnapshot
        );
      };
      const emitNotice = (notice) => {
        if (claimStillActive()) this._emitEngineNotice(sessionId, notice);
      };
      const allowImageFileParts = Boolean(
        state.enginePayload?.allowImageFileParts ?? require("./model-presets").activePresetSupportsVision(),
      );
      let engineText = text;
      let engineFiles = files;
      if (files?.length) {
        const vision = await runVisionPreflight(text, files, {
          emitNotice,
          nativeVision: allowImageFileParts,
        });
        if (!claimStillActive()) return { ok: false };
        if (vision.visionEvidence) state.evidenceLedger?.recordVisionObservation?.(vision.visionEvidence);
        if (vision.ok) {
          engineText = vision.text;
          engineFiles = vision.files;
        }
        const document = await runDocumentPreflight(engineText, engineFiles, {
          emitNotice,
        });
        if (!claimStillActive()) return { ok: false };
        if (document.documentEvidence) state.evidenceLedger?.recordDocumentExtraction?.(document.documentEvidence);
        if (document.ok) {
          engineText = document.text;
          engineFiles = document.files;
        }
      }
      if (!claimStillActive()) return { ok: false };
      let accepted = false;
      try {
        accepted = await runner.steer({
          text: engineText,
          files: engineFiles,
          allowImageFileParts,
        });
      } catch (err) {
        log.warn("steer dispatch failed: %s", err?.message || err);
        return { ok: false };
      }
      if (!accepted) return { ok: false };
      if (!claimStillActive()) {
        log.warn(
          "accepted steer became orphaned: session=%s turn=%s generation=%d",
          sessionId,
          claim.turnId,
          claim.turnGeneration,
        );
        return {
          ok: true,
          steered: true,
          steerOrphaned: true,
          turnId: claim.turnId,
        };
      }
      const turnId = claim.turnId;
      const steerSeq = (state.steerCount || 0) + 1;
      state.steerCount = steerSeq;
      const displayFiles = mergeDisplayFileMetadata(files, opts.displayFiles);
      try {
        this.transcriptStore.commitUserMessage(sessionId, {
          text,
          files: displayFiles,
          turnId,
          steer: true,
          steerSeq,
        });
      } catch (err) {
        log.warn("steer user message commit failed: %s", err?.message || err);
      }
      appendTimelineNotice(state, {
        code: "turnSteered",
        level: "info",
        detail: String(text || "").trim(),
      }, Date.now());
      this._emit(
        sessionId,
        "user.committed",
        {
          text,
          files: displayFiles && displayFiles.length ? displayFiles : null,
          steer: true,
          steerSeq,
        },
        { turnId },
      );
      this._emit(sessionId, "turn.steered", { text, steerSeq }, { turnId });
      return { ok: true, steered: true, turnId, steerSeq };
    },
  };
}

module.exports = { createTurnSteerMethods };
