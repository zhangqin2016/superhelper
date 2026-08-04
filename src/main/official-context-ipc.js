"use strict";

const { getLocale } = require("./locale-settings");
const {
  getOfficialPersona,
  listOfficialPersonas,
  getOfficialWorldBook,
  listOfficialWorldBooks,
} = require("./character-worlds/official-context-catalog");

function safeLocale() {
  try { return getLocale() || "en"; } catch { return "en"; }
}

function registerOfficialContextHandlers({ ipcMain, ctx, guard, failure, mapDomainError, policyDeniesSelection, resolveOwnerScope, repository }) {
  ipcMain.handle("persona:list-official", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const owner = resolveOwnerScope(ctx);
    if (!owner || !repository()) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const repo = repository();
    const installed = new Map();
    for (const entity of repo.listPersonas(owner)) {
      const revision = entity.currentRevisionId ? repo.getPersonaRevision(owner, entity.currentRevisionId) : null;
      const officialId = revision?.source?.kind === "official" ? String(revision.source.officialId || "") : "";
      if (officialId) installed.set(officialId, { entity, revision });
    }
    const personas = listOfficialPersonas(safeLocale()).map((persona) => {
      const current = installed.get(persona.id);
      return {
        ...persona,
        installedPersonaId: current?.entity.id || null,
        currentRevisionId: current?.revision.id || null,
        installedVersion: Number(current?.revision?.source?.officialVersion) || 0,
        updateAvailable: Boolean(current && Number(current.revision?.source?.officialVersion) < persona.version),
      };
    });
    return { ok: true, personas };
  });

  ipcMain.handle("persona:get-official", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const owner = resolveOwnerScope(ctx);
    if (!owner || !repository() || typeof payload?.officialId !== "string") return failure("INVALID_INPUT");
    const persona = getOfficialPersona(payload.officialId.trim(), safeLocale());
    return persona ? { ok: true, persona } : failure("PERSONA_NOT_FOUND");
  });

  ipcMain.handle("persona:install-official", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    const persona = getOfficialPersona(payload?.officialId, safeLocale());
    if (!owner || !repo || !persona) return failure("INVALID_INPUT");
    try {
      const source = {
        kind: "official", format: "lily", container: "json",
        officialId: persona.id, officialVersion: persona.version, officialLocale: persona.locale,
      };
      const existing = repo.listPersonas(owner)
        .map((entity) => ({
          entity,
          revision: entity.currentRevisionId ? repo.getPersonaRevision(owner, entity.currentRevisionId) : null,
        }))
        .find((entry) => entry.revision?.source?.kind === "official"
          && String(entry.revision.source.officialId || "") === persona.id);
      if (existing && Number(existing.revision.source.officialVersion) >= persona.version
        && existing.revision.source.officialLocale === persona.locale) {
        return {
          ok: true,
          personaId: existing.entity.id,
          revisionId: existing.revision.id,
          displayName: existing.revision.canonical.name,
          official: true,
          version: persona.version,
        };
      }
      const created = existing
        ? {
          entity: existing.entity,
          revision: repo.createPersonaRevision({
            ownerScope: owner,
            entityId: existing.entity.id,
            baseRevisionId: existing.revision.id,
            canonical: persona.canonical,
            source,
          }),
        }
        : repo.createPersona({ ownerScope: owner, canonical: persona.canonical, source });
      return {
        ok: true,
        personaId: created.entity.id,
        revisionId: created.revision.id,
        displayName: created.revision.canonical.name,
        official: true,
        version: persona.version,
      };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("world-book:list-official", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const owner = resolveOwnerScope(ctx);
    if (!owner || !repository()) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const installed = new Map();
    for (const entity of repository().listWorldBooks(owner)) {
      const revision = entity.currentRevisionId ? repository().getWorldBookRevision(owner, entity.currentRevisionId) : null;
      const officialId = revision?.source?.kind === "official" ? String(revision.source.officialId || "") : "";
      if (officialId) installed.set(officialId, { entity, revision });
    }
    const worldBooks = listOfficialWorldBooks(safeLocale()).map((book) => {
      const current = installed.get(book.id);
      return {
        ...book,
        installedWorldBookId: current?.entity.id || null,
        currentRevisionId: current?.revision.id || null,
        installedVersion: Number(current?.revision?.source?.officialVersion) || 0,
        updateAvailable: Boolean(current && Number(current.revision?.source?.officialVersion) < book.version),
      };
    });
    return { ok: true, worldBooks };
  });

  ipcMain.handle("world-book:get-official", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const owner = resolveOwnerScope(ctx);
    if (!owner || !repository() || typeof payload?.officialId !== "string") return failure("INVALID_INPUT");
    const book = getOfficialWorldBook(payload.officialId.trim(), safeLocale());
    return book ? { ok: true, worldBook: book } : failure("WORLD_BOOK_NOT_FOUND");
  });

  ipcMain.handle("world-book:install-official", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    const book = getOfficialWorldBook(payload?.officialId, safeLocale());
    if (!owner || !repo || !book) return failure("INVALID_INPUT");
    try {
      const source = {
        kind: "official", format: "lily", container: "json",
        officialId: book.id, officialVersion: book.version, officialLocale: book.locale,
      };
      const existing = repo.listWorldBooks(owner)
        .map((entity) => ({
          entity,
          revision: entity.currentRevisionId ? repo.getWorldBookRevision(owner, entity.currentRevisionId) : null,
        }))
        .find((entry) => entry.revision?.source?.kind === "official"
          && String(entry.revision.source.officialId || "") === book.id);
      if (existing && Number(existing.revision.source.officialVersion) >= book.version
        && existing.revision.source.officialLocale === book.locale) {
        return {
          ok: true,
          worldBookId: existing.entity.id,
          revisionId: existing.revision.id,
          displayName: existing.revision.canonical.name,
          official: true,
          version: book.version,
        };
      }
      const created = existing
        ? {
          entity: existing.entity,
          revision: repo.createWorldBookRevision({
            ownerScope: owner,
            entityId: existing.entity.id,
            baseRevisionId: existing.revision.id,
            canonical: book.canonical,
            source,
          }),
        }
        : repo.createWorldBook({ ownerScope: owner, canonical: book.canonical, source });
      return {
        ok: true,
        worldBookId: created.entity.id,
        revisionId: created.revision.id,
        displayName: created.revision.canonical.name,
        official: true,
        version: book.version,
      };
    } catch (error) {
      return mapDomainError(error);
    }
  });
}

module.exports = { registerOfficialContextHandlers };
