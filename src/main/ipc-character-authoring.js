"use strict";

const { ipcMain } = require("electron");

const {
  failure,
  mapDomainError,
  isTrustedSender,
  boundedPayload,
  validId,
  resolveOwnerScope,
  policyDeniesSelection,
} = require("./ipc-character-guards");

// Character Worlds authoring IPC boundary (Phase 2B, Task P2B-4; design spec
// §13.2/§15/§16). Guarded mutation channels on top of the ONE validated
// authoring domain API (character-worlds/authoring-service.js, P2B-3) — the
// same entry point the agent draft path will use later.
//
// Discipline (shared with ipc-character-worlds.js through the extracted
// ./ipc-character-guards.js helpers):
//   - trusted sender only; payloads/ids bounded (canonical edits can be large
//     but stay far below the storage cap)
//   - owner scope is derived in the main process on every call; renderer
//     owner/account fields are ignored by construction
//   - errors are stable coded results only (mapDomainError)
//   - rollout policy: EVERY authoring mutation follows import availability —
//     including archive, which is a mutation and stays gated (there is no
//     unarchive, so gating it strands nothing). Read-only channels
//     (history / get-revision) stay open under a disabled policy, exactly
//     like list/get.
//   - get-revision returns the owner's own stored canonical: the library
//     editor needs the field values it edits. The selection/inspection
//     surfaces keep using whitelisted summaries (persona-inspection.js,
//     world-book-inspection.js) — this read exists for the authoring UI only.

const MAX_AUTHORING_PAYLOAD_BYTES = 1024 * 1024;
const MAX_HISTORY_LIMIT = 200;

function registerCharacterAuthoringHandlers(ctx) {
  const authoring = () => ctx.characterWorldsService?.authoring || null;
  const repository = () => (
    ctx.characterWorldsRepository || ctx.characterWorldsService?.repository || null
  );

  function guard(event, payload) {
    if (!isTrustedSender(ctx, event)) return failure("UNTRUSTED_SENDER");
    if (boundedPayload(payload, MAX_AUTHORING_PAYLOAD_BYTES) === null) {
      return failure("INVALID_INPUT");
    }
    return null;
  }

  function canonicalOf(payload) {
    const canonical = payload?.canonical;
    if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return null;
    return canonical;
  }

  function historyLimit(payload) {
    if (payload?.limit == null) return { limit: undefined };
    if (!Number.isInteger(payload.limit) || payload.limit < 1) return null;
    return { limit: Math.min(payload.limit, MAX_HISTORY_LIMIT) };
  }

  // One mutation registration: guard -> policy gate -> owner derivation ->
  // field validation -> validated domain call -> coded result. `validate`
  // returns the domain input or null (INVALID_INPUT).
  function mutation(channel, validate, invoke) {
    ipcMain.handle(channel, async (event, payload = {}) => {
      const denied = guard(event, payload);
      if (denied) return denied;
      const policyDenied = policyDeniesSelection(ctx);
      if (policyDenied) return policyDenied;
      const svc = authoring();
      const owner = resolveOwnerScope(ctx);
      if (!svc || !owner) return failure("CHARACTER_WORLDS_UNAVAILABLE");
      const input = validate(payload);
      if (!input) return failure("INVALID_INPUT");
      try {
        return await invoke(svc, { ownerScope: owner, ...input });
      } catch (error) {
        return mapDomainError(error);
      }
    });
  }

  const createCanonical = (payload) => {
    const canonical = canonicalOf(payload);
    return canonical ? { canonical } : null;
  };
  const editInput = (idField) => (payload) => {
    const canonical = canonicalOf(payload);
    if (!canonical) return null;
    if (!validId(payload?.[idField]) || !validId(payload?.expectedBaseRevisionId)) return null;
    return {
      entityId: payload[idField],
      expectedBaseRevisionId: payload.expectedBaseRevisionId,
      canonical,
    };
  };
  const idInput = (idField) => (payload) => (
    validId(payload?.[idField]) ? { entityId: payload[idField] } : null
  );

  mutation("character:create", createCanonical, (svc, input) => svc.createCharacter(input));
  mutation("character:update-revision", editInput("characterId"), (svc, input) => svc.editCharacter(input));
  mutation("character:restore-revision", (payload) => {
    if (!validId(payload?.characterId) || !validId(payload?.revisionId)
      || !validId(payload?.expectedBaseRevisionId)) return null;
    return {
      entityId: payload.characterId,
      revisionId: payload.revisionId,
      expectedBaseRevisionId: payload.expectedBaseRevisionId,
    };
  }, (svc, input) => svc.restoreCharacterRevision(input));
  mutation("character:duplicate", idInput("characterId"), (svc, input) => svc.duplicateCharacter(input));
  mutation("character:archive", idInput("characterId"), (svc, input) => svc.archiveCharacter(input));
  mutation("persona:create", createCanonical, (svc, input) => svc.createPersona(input));
  mutation("persona:update-revision", editInput("personaId"), (svc, input) => svc.editPersona(input));
  mutation("persona:archive", idInput("personaId"), (svc, input) => svc.archivePersona(input));
  mutation("world-book:create", createCanonical, (svc, input) => svc.createWorldBook(input));
  mutation("world-book:archive", idInput("worldBookId"), (svc, input) => svc.archiveWorldBook(input));

  // --- read-only channels: history + revision canonical for the editor ------
  // Reads stay available under a disabled rollout policy (the policy gates
  // selection/import/authoring only) and never throw across the bridge.
  function history(channel, idField, invoke) {
    ipcMain.handle(channel, async (event, payload = {}) => {
      const denied = guard(event, payload);
      if (denied) return denied;
      const svc = authoring();
      const owner = resolveOwnerScope(ctx);
      if (!svc || !owner) return failure("CHARACTER_WORLDS_UNAVAILABLE");
      if (!validId(payload?.[idField])) return failure("INVALID_INPUT");
      const bounded = historyLimit(payload);
      if (!bounded) return failure("INVALID_INPUT");
      try {
        return await invoke(svc, {
          ownerScope: owner,
          entityId: payload[idField],
          limit: bounded.limit,
        });
      } catch (error) {
        return mapDomainError(error);
      }
    });
  }

  history("character:history", "characterId", (svc, input) => svc.characterHistory(input));
  history("persona:history", "personaId", (svc, input) => svc.personaHistory(input));
  history("world-book:history", "worldBookId", (svc, input) => svc.worldBookHistory(input));

  function revisionRead(channel, notFoundCode, fetch) {
    ipcMain.handle(channel, async (event, payload = {}) => {
      const denied = guard(event, payload);
      if (denied) return denied;
      const owner = resolveOwnerScope(ctx);
      const repo = repository();
      if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
      if (!validId(payload?.revisionId)) return failure("INVALID_INPUT");
      try {
        const revision = fetch(repo, owner, payload.revisionId);
        if (!revision) return failure(notFoundCode);
        return { ok: true, revision };
      } catch (error) {
        return mapDomainError(error);
      }
    });
  }

  revisionRead("character:get-revision", "CHARACTER_REVISION_NOT_FOUND",
    (repo, owner, id) => repo.getRevision(owner, id));
  revisionRead("persona:get-revision", "PERSONA_REVISION_NOT_FOUND",
    (repo, owner, id) => repo.getPersonaRevision(owner, id));
}

module.exports = { registerCharacterAuthoringHandlers };
