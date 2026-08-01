"use strict";

const { dialog, ipcMain } = require("electron");

const {
  summarizeWorldBookDetail,
  summarizeWorldBookEntity,
  summarizeWorldBookRevision,
} = require("./character-worlds/world-book-inspection");
const {
  summarizePersonaDetail,
  summarizePersonaEntity,
} = require("./character-worlds/persona-inspection");
const {
  projectBindingSwitchNotices,
  resolveBindingUpdates,
} = require("./character-worlds/binding-projection");

// Character Worlds IPC boundary (design spec §15/§16, HANDOFF.md §5/§6).
//
// The renderer can never supply owner/account IDs, raw source paths, or
// destination paths as trusted values:
//   - owner scope is derived in the main process for every call
//   - import sources come from a main-process open dialog (payload path fields
//     are ignored by construction)
//   - export destinations come from a main-process save dialog and become an
//     opaque broker reservation before any bytes move
// Errors crossing the bridge are stable codes only — no messages, stacks,
// card bytes beyond the documented preview fields, or local paths.
// The guard/error/policy discipline itself lives in ./ipc-character-guards.js,
// shared with the authoring channels in ./ipc-character-authoring.js.

const {
  failure,
  mapDomainError,
  isTrustedSender,
  boundedPayload,
  validId,
  resolveOwnerScope,
  policyDeniesSelection,
} = require("./ipc-character-guards");

const MAX_EVENTS_LIMIT = 200;
const MAX_FILE_STEM_LENGTH = 80;
const PREVIEW_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const BINDING_MODES = new Set(["native", "character"]);
const DUPLICATE_RESOLUTIONS = new Set(["create_copy"]);
const CARD_DIALOG_FILTERS = [
  { name: "Character Card", extensions: ["json", "png", "apng"] },
];

function validVersion(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function safeFileStem(displayName) {
  const stem = String(displayName || "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
    .trim()
    .slice(0, MAX_FILE_STEM_LENGTH);
  return stem || "character-card";
}

function resolveSessionAuthority(ctx, sessionId) {
  if (!validId(sessionId)) return { error: "INVALID_INPUT" };
  const resolved = ctx?.sessionManager?.resolveTurnOwnerScope?.(sessionId);
  if (!resolved || resolved.ok !== true || typeof resolved.ownerScope !== "string" || !resolved.ownerScope) {
    const code = typeof resolved?.error === "string" && ERROR_CODE_PATTERN.test(resolved.error)
      ? resolved.error
      : "NO_SESSION";
    return { error: code };
  }
  return { sessionId, ownerScope: resolved.ownerScope };
}

function registerCharacterWorldsHandlers(ctx) {
  const service = () => ctx.characterWorldsService || null;
  const repository = () => (
    ctx.characterWorldsRepository || ctx.characterWorldsService?.repository || null
  );

  function guard(event, payload) {
    if (!isTrustedSender(ctx, event)) return failure("UNTRUSTED_SENDER");
    if (boundedPayload(payload) === null) return failure("INVALID_INPUT");
    return null;
  }

  ipcMain.handle("character:list", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    try {
      return { ok: true, characters: repo.listCharacters(owner) };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:get", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!validId(payload?.characterId)) return failure("INVALID_INPUT");
    try {
      const character = repo.getCharacter(owner, payload.characterId);
      if (!character) return failure("CHARACTER_NOT_FOUND");
      return { ok: true, character };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:import-preview", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const policyDenied = policyDeniesSelection(ctx);
    if (policyDenied) return policyDenied;
    const svc = service();
    const owner = resolveOwnerScope(ctx);
    if (!svc || !owner) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    let picked;
    try {
      picked = await dialog.showOpenDialog(ctx.mainWindow, {
        title: "Import Character Card",
        properties: ["openFile"],
        filters: CARD_DIALOG_FILTERS,
      });
    } catch (error) {
      return mapDomainError(error);
    }
    if (picked?.canceled || !Array.isArray(picked?.filePaths) || !picked.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    try {
      const preview = await svc.previewImport({
        ownerScope: owner,
        sourcePath: picked.filePaths[0],
      });
      if (preview?.ok === false && preview?.kind === "ordinaryAttachment") {
        return failure("NOT_A_CHARACTER_CARD", { fallback: "ordinary_attachment" });
      }
      return preview;
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:import-commit", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const policyDenied = policyDeniesSelection(ctx);
    if (policyDenied) return policyDenied;
    const svc = service();
    const owner = resolveOwnerScope(ctx);
    if (!svc || !owner) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!PREVIEW_TOKEN_PATTERN.test(payload?.previewToken)) return failure("INVALID_INPUT");
    const duplicateResolution = payload.duplicateResolution;
    if (duplicateResolution != null && !DUPLICATE_RESOLUTIONS.has(duplicateResolution)) {
      return failure("INVALID_INPUT");
    }
    try {
      const committed = await svc.commitImport({
        ownerScope: owner,
        previewToken: payload.previewToken,
        duplicateResolution: duplicateResolution || undefined,
      });
      return { ok: true, ...committed };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:export", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const svc = service();
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!svc || !owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!validId(payload?.revisionId)) return failure("INVALID_INPUT");
    try {
      const revision = repo.getRevision(owner, payload.revisionId);
      if (!revision) return failure("CHARACTER_REVISION_NOT_FOUND");
      const container = revision.source?.container;
      const extension = container === "apng" ? "apng" : container === "json" ? "json" : "png";
      const picked = await dialog.showSaveDialog(ctx.mainWindow, {
        title: "Export Character Card",
        defaultPath: `${safeFileStem(revision.displayName)}.${extension}`,
        filters: [{ name: "Character Card", extensions: [extension] }],
      });
      if (picked?.canceled || !picked?.filePath) return { ok: false, canceled: true };
      const capability = await svc.destinationWriter.approve(picked.filePath);
      return await svc.exportCharacter({
        ownerScope: owner,
        revisionId: payload.revisionId,
        destinationCapability: capability,
      });
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("session-character:get-binding", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const repo = repository();
    if (!repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return failure(session.error);
    try {
      const binding = repo.getBinding(session.sessionId, session.ownerScope);
      // Update-available hint (Phase 2B, §8): a newer current revision than
      // the binding's pin surfaces as a read-only hint; applying it stays an
      // explicit set-binding. The hint is gated like selection — under a
      // disabled policy the read still works but no affordance crosses.
      const updates = policyDeniesSelection(ctx)
        ? null
        : resolveBindingUpdates(repo, session.ownerScope, binding);
      return { ok: true, binding, updates };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("session-character:set-binding", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    // Deselecting (mode "native", including dropping the persona pin) is
    // always allowed — the policy gates selection/import availability, never
    // the return to native Lily. Persona selection requires mode "character",
    // so it is gated exactly like character selection.
    if (payload?.mode !== "native") {
      const policyDenied = policyDeniesSelection(ctx);
      if (policyDenied) return policyDenied;
    }
    const repo = repository();
    if (!repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return failure(session.error);
    if (!validVersion(payload.expectedBindingVersion)) return failure("INVALID_INPUT");
    if (!BINDING_MODES.has(payload.mode)) return failure("INVALID_INPUT");
    const next = { mode: payload.mode };
    if (payload.mode === "character") {
      if (!validId(payload.characterRevisionId)) return failure("INVALID_INPUT");
      next.characterRevisionId = payload.characterRevisionId;
      if (payload.personaRevisionId != null) {
        if (!validId(payload.personaRevisionId)) return failure("INVALID_INPUT");
        next.personaRevisionId = payload.personaRevisionId;
      }
    } else if (payload.personaRevisionId != null) {
      // A native binding is the Lily baseline: it carries no persona (§7.5).
      return failure("INVALID_INPUT");
    }
    try {
      const binding = repo.setBinding({
        sessionId: session.sessionId,
        ownerScope: session.ownerScope,
        expectedBindingVersion: payload.expectedBindingVersion,
        next,
      });
      return { ok: true, binding };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("session-character:get-events", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const repo = repository();
    if (!repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return failure(session.error);
    const options = {};
    if (payload.afterVersion != null) {
      if (!validVersion(payload.afterVersion)) return failure("INVALID_INPUT");
      options.afterVersion = payload.afterVersion;
    }
    if (payload.limit != null) {
      if (!Number.isInteger(payload.limit) || payload.limit < 1) return failure("INVALID_INPUT");
      options.limit = Math.min(payload.limit, MAX_EVENTS_LIMIT);
    }
    try {
      const events = repo.getBindingEvents(session.sessionId, session.ownerScope, options);
      // Switch notices (Phase 2B, §8): display names are resolved main-side
      // from the pinned revisions; the projection is whitelisted and never
      // carries raw card data. Reads stay open under a disabled policy.
      const notices = projectBindingSwitchNotices(events, (revisionId) => {
        try {
          return repo.getRevision(session.ownerScope, revisionId);
        } catch {
          return null;
        }
      });
      return { ok: true, events, notices };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  // --- read-only world-book inspection (Phase 2A, Task WB-6) -----------------
  // Summaries are whitelisted in character-worlds/world-book-inspection.js:
  // ids, counts, enums, and hashes only — entry content, activation keys,
  // preserved payloads, and decorator raw lines never cross the bridge. Like
  // character list/get these reads stay available under a disabled rollout
  // policy (the policy gates selection/import only). Phase 2A ships NO book
  // mutation channel.

  ipcMain.handle("world-book:list", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    try {
      const entities = repo.listWorldBooks(owner);
      const worldBooks = entities.map((entity) => {
        let revision = null;
        try {
          revision = entity?.currentRevisionId
            ? repo.getWorldBookRevision(owner, entity.currentRevisionId)
            : null;
        } catch {
          revision = null; // an unreadable revision degrades the row, not the list
        }
        return summarizeWorldBookEntity(entity, revision);
      });
      return { ok: true, worldBooks };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("world-book:get", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!validId(payload?.worldBookId)) return failure("INVALID_INPUT");
    try {
      const entity = repo.getWorldBook(owner, payload.worldBookId);
      if (!entity) return failure("WORLD_BOOK_NOT_FOUND");
      let revision = null;
      try {
        revision = entity.currentRevisionId
          ? repo.getWorldBookRevision(owner, entity.currentRevisionId)
          : null;
      } catch {
        revision = null; // missing/corrupt revision degrades to metadata-free detail
      }
      return { ok: true, worldBook: summarizeWorldBookDetail(entity, revision) };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("world-book:get-revision", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!validId(payload?.revisionId)) return failure("INVALID_INPUT");
    try {
      const revision = repo.getWorldBookRevision(owner, payload.revisionId);
      if (!revision) return failure("WORLD_BOOK_REVISION_NOT_FOUND");
      return { ok: true, revision: summarizeWorldBookRevision(revision) };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  // --- read-only persona inspection (Phase 2B, Task P2B-2): whitelisted
  // summaries only (ids, names, counts, hashes) — persona narrative text and
  // any mutation surface stay main-side. Reads ignore the rollout policy.
  const personaRevisionOrNull = (repo, owner, revisionId) => {
    try {
      return revisionId ? repo.getPersonaRevision(owner, revisionId) : null;
    } catch {
      return null; // an unreadable revision degrades the row, not the call
    }
  };
  ipcMain.handle("persona:list", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    try {
      const personas = repo.listPersonas(owner).map((entity) => (
        summarizePersonaEntity(entity, personaRevisionOrNull(repo, owner, entity?.currentRevisionId))
      ));
      return { ok: true, personas };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("persona:get", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!validId(payload?.personaId)) return failure("INVALID_INPUT");
    try {
      const entity = repo.getPersona(owner, payload.personaId);
      if (!entity) return failure("PERSONA_NOT_FOUND");
      const revision = personaRevisionOrNull(repo, owner, entity.currentRevisionId);
      return { ok: true, persona: summarizePersonaDetail(entity, revision) };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  // §15 P3-2: scene:get / scene:update — group-scene reads and mutations from
  // the renderer. scene:update is a validated mutation (session authority +
  // participant/strategy/prompt-mode whitelists); a card can never enable join.
  ipcMain.handle("scene:get", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const repo = repository();
    if (!repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return failure(session.error);
    try {
      const group = require("./character-worlds/group-modes");
      const scene = group.getScene(repo, session.ownerScope, session.sessionId);
      if (!scene) return { ok: true, scene: null };
      const participants = (scene.participantCharacterRevisionIds || [])
        .map((rid) => { try { const r = repo.getRevision(session.ownerScope, rid); return r ? { revisionId: rid, name: r.displayName } : null; } catch { return null; } })
        .filter(Boolean);
      return { ok: true, scene: { ...scene, participants } };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("scene:update", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const repo = repository();
    if (!repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return failure(session.error);
    const participantIds = Array.isArray(payload?.participantCharacterRevisionIds) ? payload.participantCharacterRevisionIds : null;
    if (participantIds && !participantIds.every((id) => validId(id))) return failure("INVALID_INPUT");
    const replyStrategy = ["manual", "natural", "list_order", "pooled", "semantic"].includes(payload?.replyStrategy)
      ? payload.replyStrategy
      : "manual";
    // Join is behaviorally risky; only an explicit user scene control may
    // select it (a card can never enable join — §12).
    const promptMode = payload?.promptMode === "join" ? "join" : "swap";
    try {
      const group = require("./character-worlds/group-modes");
      const scene = group.upsertScene(repo, {
        ownerScope: session.ownerScope,
        sessionId: session.sessionId,
        participantCharacterRevisionIds: participantIds,
        replyStrategy,
        promptMode,
        activeSpeakerRevisionId: validId(payload?.activeSpeakerRevisionId) ? payload.activeSpeakerRevisionId : null,
      });
      return { ok: true, scene: { ...scene, participants: [] } };
    } catch (error) {
      return mapDomainError(error);
    }
  });
}

module.exports = { registerCharacterWorldsHandlers };
