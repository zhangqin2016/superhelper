"use strict";

const {
  getOfficialCharacter,
  listOfficialCharacters,
} = require("./character-worlds/official-character-catalog");
const { getLocale } = require("./locale-settings");

function safeLocale() {
  try { return getLocale() || "en"; } catch { return "en"; }
}

function officialSource(official) {
  return {
    kind: "official",
    format: "lily",
    container: "json",
    officialId: official.id,
    officialVersion: official.version,
    officialLocale: official.locale,
  };
}

function installedOfficialRevisions(repo, owner) {
  const revisions = new Map();
  for (const entity of repo.listCharacters(owner)) {
    const revision = entity.currentRevisionId ? repo.getRevision(owner, entity.currentRevisionId) : null;
    const officialId = revision?.source?.kind === "official"
      ? String(revision.source.officialId || "")
      : "";
    if (officialId && !revisions.has(officialId)) revisions.set(officialId, revision);
  }
  return revisions;
}

/** Register the safe-summary and first-use installation surface for official characters. */
function registerOfficialCharacterHandlers({ ipcMain, ctx, guard, failure, mapDomainError, policyDeniesSelection, resolveOwnerScope, repository }) {
  ipcMain.handle("character:list-official", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    try {
      const installed = installedOfficialRevisions(repo, owner);
      const characters = listOfficialCharacters(safeLocale()).map((official) => {
        const revision = installed.get(official.id);
        const installedVersion = Number(revision?.source?.officialVersion) || 0;
        const installedLocale = String(revision?.source?.officialLocale || "");
        return {
          ...official,
          installedCharacterId: revision?.characterId || null,
          currentRevisionId: revision?.id || null,
          installedVersion,
          installedLocale,
          updateAvailable: Boolean(revision && (
            installedVersion < official.version || installedLocale !== official.locale
          )),
        };
      });
      return { ok: true, characters };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:install-official", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    const official = getOfficialCharacter(payload?.officialId, safeLocale());
    if (!owner || !repo || !official) return failure("INVALID_INPUT");
    try {
      const existing = installedOfficialRevisions(repo, owner).get(official.id) || null;
      const installedVersion = Number(existing?.source?.officialVersion) || 0;
      const installedLocale = String(existing?.source?.officialLocale || "");
      if (existing && installedVersion >= official.version && installedLocale === official.locale) {
        return {
          ok: true,
          characterId: existing.characterId,
          revisionId: existing.id,
          displayName: existing.canonical.name,
          official: true,
          version: official.version,
        };
      }
      const source = officialSource(official);
      const created = existing
        ? {
          entity: { id: existing.characterId },
          revision: repo.createRevision({
            ownerScope: owner,
            entityId: existing.characterId,
            baseRevisionId: existing.id,
            canonical: official.canonical,
            source,
          }),
        }
        : repo.createCharacter({ ownerScope: owner, canonical: official.canonical, source });
      return {
        ok: true,
        characterId: created.entity.id,
        revisionId: created.revision.id,
        displayName: created.revision.canonical.name,
        official: true,
        version: official.version,
      };
    } catch (error) {
      return mapDomainError(error);
    }
  });
}

module.exports = { installedOfficialRevisions, officialSource, registerOfficialCharacterHandlers };
