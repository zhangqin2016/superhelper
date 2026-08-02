"use strict";

const {
  cleanDiagnostic,
  nativeSnapshot,
  normalizeAdmissionSnapshot,
} = require("./runtime-contract");

function safePolicy(policy) {
  try {
    const value = typeof policy === "function" ? policy() : policy;
    return value && typeof value === "object" ? value : { enabled: false, reason: "policy_invalid" };
  } catch {
    return { enabled: false, reason: "policy_error" };
  }
}

class CharacterWorldsRuntime {
  constructor({ repository = null, policy = null, compile = null, planner = null, log = null } = {}) {
    this.repository = repository;
    this.policy = policy;
    this.compile = compile;
    this.planner = planner;
    this.log = typeof log === "function" ? log : () => {};
  }

  admitTurn(input = {}) {
    const ownerScope = input.ownerScope;
    const sessionId = input.sessionId;
    const turnId = input.turnId;
    if (typeof ownerScope !== "string" || !ownerScope) return nativeSnapshot({ ownerScope, sessionId, turnId, reason: "owner_invalid" });
    if (typeof sessionId !== "string" || !sessionId) return nativeSnapshot({ ownerScope, sessionId, turnId, reason: "session_invalid" });
    if (typeof turnId !== "string" || !turnId) return nativeSnapshot({ ownerScope, sessionId, turnId, reason: "turn_invalid" });
    const policy = safePolicy(this.policy);
    if (policy.enabled !== true) {
      return nativeSnapshot({ ownerScope, sessionId, turnId, reason: policy.reason || "remote_disabled" });
    }
    try {
      const binding = input.binding;
      if (!binding || binding.mode !== "character" || typeof binding.characterRevisionId !== "string" || !binding.characterRevisionId) {
        return nativeSnapshot({ ownerScope, sessionId, turnId, reason: "binding_invalid" });
      }
      return normalizeAdmissionSnapshot({
        ownerScope,
        sessionId,
        turnId,
        mode: "character",
        binding: { ...binding, ownerScope },
        scene: input.scene,
        policy,
        checkpoint: input.checkpoint,
      });
    } catch (error) {
      this.log({ event: "character_worlds_admission_fallback", reason: error?.message || "snapshot_invalid" });
      return nativeSnapshot({ ownerScope, sessionId, turnId, reason: "admission_invalid" });
    }
  }

  compileTurn(snapshot, canonicalHistory = [], context = {}) {
    try {
      const normalized = normalizeAdmissionSnapshot(snapshot);
      if (normalized.mode === "native") return { status: "native", snapshot: normalized };
      if (typeof this.compile !== "function") return { status: "native", snapshot: normalized, diagnostic: cleanDiagnostic("compiler_unavailable") };
      return this.compile({ snapshot: normalized, canonicalHistory, context, repository: this.repository });
    } catch (error) {
      this.log({ event: "character_worlds_compile_fallback", reason: error?.message || "compile_failed" });
      return { status: "native", diagnostic: cleanDiagnostic("compile_failed") };
    }
  }

  withSpeakerDecision(snapshot, decision) {
    const normalized = normalizeAdmissionSnapshot({ ...snapshot, plannerDecision: decision });
    return normalized;
  }

  finalizeTurn(snapshot, { store = null, sessionId, completedTurnId, assistantText = "" } = {}) {
    if (!snapshot || snapshot.mode !== "character" || !store?.db) return { advanced: false, reason: "native" };
    try {
      const { CharacterSceneMemoryService } = require("./scene-memory-service");
      const turnId = completedTurnId || snapshot.turnId;
      const text = typeof assistantText === "string" ? assistantText.trim().slice(0, 512) : "";
      const result = new CharacterSceneMemoryService({ store, ownerScope: snapshot.ownerScope })
        .appendTurnMemory({
          sessionId: sessionId || snapshot.sessionId,
          characterRevisionId: snapshot.binding.characterRevisionId,
          turnId,
          finalized: true,
          items: text ? [{ kind: "scene_fact", text, sourceTurnIds: [turnId], confidence: "derived" }] : [],
        });
      return { advanced: true, ...result };
    } catch (error) {
      this.log({ event: "character_worlds_finalize_fallback", reason: error?.message || "finalize_failed" });
      return { advanced: false, reason: "finalize_failed" };
    }
  }

  rewindTo({ store = null, ownerScope, sessionId, characterRevisionId, retainedTurnId } = {}) {
    if (!store?.db || !ownerScope || !sessionId || !characterRevisionId || !retainedTurnId) {
      return { invalidated: 0, reason: "rewind_identity_invalid" };
    }
    try {
      const { CharacterSceneMemoryService } = require("./scene-memory-service");
      return new CharacterSceneMemoryService({ store, ownerScope })
        .rewindTo({ sessionId, characterRevisionId, retainedTurnId });
    } catch (error) {
      this.log({ event: "character_worlds_rewind_fallback", reason: error?.message || "rewind_failed" });
      return { invalidated: 0, reason: "rewind_failed" };
    }
  }

  exportScene(sessions = []) {
    try {
      const portability = require("./workspace-portability");
      const collected = portability.collectCharacterWorldsForExport(this.repository, sessions);
      return portability.packCharacterWorldsSection(collected);
    } catch (error) {
      this.log({ event: "character_worlds_export_fallback", reason: error?.message || "export_failed" });
      return { json: "", bytes: 0, error: "export_failed" };
    }
  }

  async importScene(ownerScope, section) {
    try {
      const portability = require("./workspace-portability");
      return await portability.importCharacterWorldsPack(this.repository, ownerScope, section);
    } catch (error) {
      this.log({ event: "character_worlds_import_fallback", reason: error?.message || "import_failed" });
      return { ok: false, imported: [], idMap: {}, errors: [{ error: "import_failed" }] };
    }
  }

  async planSpeakers(snapshot, canonicalMessage, deps = {}) {
    const normalized = normalizeAdmissionSnapshot(snapshot);
    if (normalized.mode !== "character" || !normalized.scene) return { speakers: [], strategy: "native" };
    if (typeof this.planner !== "function") return { speakers: [], strategy: "native" };
    try {
      return await this.planner({ snapshot: normalized, canonicalMessage, deps, repository: this.repository });
    } catch (error) {
      this.log({ event: "character_worlds_speaker_fallback", reason: error?.message || "planner_failed" });
      return { speakers: [], strategy: "fallback", diagnostic: cleanDiagnostic("speaker_planner_failed") };
    }
  }

  planSpeakersSync(snapshot, canonicalMessage, deps = {}) {
    const normalized = normalizeAdmissionSnapshot(snapshot);
    if (normalized.mode !== "character" || !normalized.scene) return { speakers: [], strategy: "native" };
    if (typeof this.planner !== "function") return { speakers: [], strategy: "native" };
    try {
      const result = this.planner({ snapshot: normalized, canonicalMessage, deps, repository: this.repository });
      if (result && typeof result.then === "function") return { speakers: [], strategy: "async_planner_skipped" };
      return result || { speakers: [], strategy: "fallback" };
    } catch (error) {
      this.log({ event: "character_worlds_speaker_fallback", reason: error?.message || "planner_failed" });
      return { speakers: [], strategy: "fallback", diagnostic: cleanDiagnostic("speaker_planner_failed") };
    }
  }
}

module.exports = { CharacterWorldsRuntime, normalizeAdmissionSnapshot };
