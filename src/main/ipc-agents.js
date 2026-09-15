"use strict";

/**
 * 智能体 (Agent) IPC boundary.
 *
 * Same discipline as the Character Worlds channels (ipc-character-guards):
 * trusted sender only, bounded payloads, owner scope derived main-side, stable
 * error codes across the bridge, kill switch honoured. Activation goes through
 * agent-activation.js so every dimension fails open to today's default.
 */

const { dialog, ipcMain } = require("electron");
const fs = require("node:fs");
const {
  failure,
  isTrustedSender,
  boundedPayload,
  validId,
  resolveOwnerScope,
} = require("./ipc-character-guards");
const { agentsEnabled, AGENT_SOURCE_KINDS } = require("./agents/constants");
const { summarizeAgentDefinition, normalizeAgentDefinition } = require("./agents/agent-definition");
const { listOfficialAgents, getOfficialAgent } = require("./agents/official-agent-catalog");
const { listKnowledgePacks, getKnowledgePack } = require("./agents/knowledge-packs");
const { activateAgent, deactivateAgent } = require("./agents/agent-activation");
const { resolveSessionAgentPolicy } = require("./agents/session-agent-policy");

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const AGENT_FILE_KIND = "lily-agent";
const AGENT_FILE_FILTERS = [{ name: "Lily Agent", extensions: ["json"] }];

function mapAgentError(error) {
  const code = typeof error?.code === "string" && ERROR_CODE_PATTERN.test(error.code) ? error.code : "AGENTS_UNAVAILABLE";
  const out = failure(code);
  if (typeof error?.field === "string") out.field = error.field;
  if (error?.current?.bindingVersion != null) out.currentBindingVersion = error.current.bindingVersion;
  if (typeof error?.currentRevisionId === "string") out.currentRevisionId = error.currentRevisionId;
  return out;
}

function safeLocale() {
  try { return require("./locale-settings").getLocale() || "en"; } catch { return "en"; }
}

function isSessionBusy(runnerPool, sessionId) {
  const runner = runnerPool?.get?.(sessionId);
  return Boolean(runner?.isAlive?.() && runner?.isBusy?.());
}

function safeFileStem(name) {
  const stem = String(name || "").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "").trim().slice(0, 80);
  return stem || "lily-agent";
}

function registerAgentHandlers(ctx) {
  const repository = () => {
    if (ctx.agentRepository) return ctx.agentRepository;
    try { return ctx.sessionManager?._store?.()?.agents?.() || null; } catch { return null; }
  };
  const characterRepository = () => ctx.characterWorldsRepository || ctx.characterWorldsService?.repository || null;

  function guard(event, payload) {
    if (!isTrustedSender(ctx, event)) return failure("UNTRUSTED_SENDER");
    if (boundedPayload(payload) === null) return failure("INVALID_INPUT");
    return null;
  }

  function scope(event, payload, { mutation = false } = {}) {
    const denied = guard(event, payload);
    if (denied) return { denied };
    if (mutation && !agentsEnabled()) return { denied: failure("AGENTS_UNAVAILABLE") };
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return { denied: failure("AGENTS_UNAVAILABLE") };
    return { owner, repo };
  }

  function libraryItem(repo, owner, entity) {
    const revision = entity.currentRevisionId ? repo.getRevision(owner, entity.currentRevisionId) : null;
    const summary = revision?.definition ? summarizeAgentDefinition(revision.definition) : null;
    return {
      id: entity.id,
      name: summary?.name || entity.displayName,
      icon: summary?.icon || "",
      description: summary?.description || "",
      official: Boolean(entity.officialId),
      officialId: entity.officialId,
      currentRevisionId: entity.currentRevisionId,
      revisionNumber: revision?.revisionNumber || 0,
      sourceKind: revision?.source?.kind || "",
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      archivedAt: entity.archivedAt,
      inUse: repo.countBindingsForAgent(owner, entity.id),
      summary,
    };
  }

  /** Install (or refresh) an official agent into the owner's library. */
  function ensureOfficialInstalled(repo, owner, officialId) {
    const official = getOfficialAgent(officialId, safeLocale());
    if (!official) return { error: "AGENT_OFFICIAL_UNKNOWN" };
    const existing = repo.findByOfficialId(owner, officialId);
    if (existing) {
      const current = existing.currentRevisionId ? repo.getRevision(owner, existing.currentRevisionId) : null;
      const installedVersion = Number(current?.source?.officialVersion) || 0;
      const installedLocale = String(current?.source?.officialLocale || "");
      if (current && installedVersion >= official.version && installedLocale === official.locale && current.source.kind === AGENT_SOURCE_KINDS.official) {
        if (existing.archivedAt) repo.restoreAgent(owner, existing.id);
        return { entity: repo.getAgent(owner, existing.id), revision: current };
      }
      // Newer official version or locale switch: append a revision; a user
      // edit on top of an official agent (source != official) is preserved as
      // history and superseded only by the explicit official refresh here.
      const revised = repo.createRevision({
        ownerScope: owner, agentId: existing.id, expectedBaseRevisionId: existing.currentRevisionId,
        definition: official.definition, source: official.source,
      });
      if (existing.archivedAt) repo.restoreAgent(owner, existing.id);
      return { entity: repo.getAgent(owner, existing.id), revision: revised.revision };
    }
    const created = repo.createAgent({ ownerScope: owner, definition: official.definition, source: official.source, officialId });
    return created;
  }

  function refreshSessionRuntime(sessionId) {
    const result = require("./agents/session-runtime-refresh").refreshSessionRuntime(ctx, sessionId);
    if (result?.ok === false) console.warn("[agents] runtime refresh failed open:", result.reason);
  }

  // The conversation itself records every binding change (renderer contract in
  // agents/agent-binding-notice.js); a toast alone left no trace.
  function noteBinding(scoped, sessionId, kind, entity, revision, receipt, bindingVersion) {
    const item = entity ? libraryItem(scoped.repo, scoped.owner, entity) : null;
    require("./agents/agent-binding-notice").commitAgentBindingNotice(ctx, sessionId, {
      kind, agent: { id: entity?.id || "", name: item?.name || entity?.displayName || "", icon: item?.icon || "" },
      definition: revision?.definition || null, receipt, bindingVersion, locale: safeLocale(),
      roleName: revision?.definition?.role ? item?.name || "" : "",
    });
  }

  // -- library --------------------------------------------------------------

  ipcMain.handle("agents:list", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    if (!agentsEnabled()) return { ok: true, disabled: true, agents: [], official: [], knowledgePacks: [] };
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("AGENTS_UNAVAILABLE");
    try {
      const includeArchived = payload?.includeArchived === true;
      const agents = repo.listAgents(owner, { includeArchived }).map((entity) => libraryItem(repo, owner, entity));
      const installedOfficial = new Map(agents.filter((item) => item.officialId).map((item) => [item.officialId, item]));
      const official = listOfficialAgents(safeLocale()).map((item) => {
        const installed = installedOfficial.get(item.id) || null;
        const revision = installed?.currentRevisionId ? repo.getRevision(owner, installed.currentRevisionId) : null;
        const installedVersion = Number(revision?.source?.officialVersion) || 0;
        return {
          ...item,
          installedAgentId: installed?.id || null,
          currentRevisionId: installed?.currentRevisionId || null,
          installedVersion,
          updateAvailable: Boolean(revision && (installedVersion < item.version || String(revision.source?.officialLocale || "") !== item.locale)),
        };
      });
      // Distributed (server-published) agents: cache-based, targeting from
      // the signed config; installed ones map to their local entity.
      let distributed = [];
      let defaultAgentId = "";
      try {
        const distribution = require("./agents/agent-distribution");
        const listed = distribution.listDistributedAgents();
        defaultAgentId = listed.defaultAgentId;
        const byPackage = new Map(agents.filter((item) => item.sourceKind === AGENT_SOURCE_KINDS.distributed).map((item) => {
          const revision = repo.getRevision(owner, item.currentRevisionId);
          return [String(revision?.source?.packageId || ""), item];
        }));
        distributed = listed.agents.map((entry) => ({
          packageId: entry.packageId,
          agentId: entry.agentId,
          version: entry.version,
          scope: entry.scope,
          publisher: entry.publisher,
          featured: entry.featured,
          isDefault: entry.agentId === defaultAgentId,
          installedAgentId: byPackage.get(entry.packageId)?.id || null,
          summary: summarizeAgentDefinition(entry.definition),
        }));
      } catch { /* distribution is optional */ }
      return { ok: true, agents, official, distributed, defaultAgentId, knowledgePacks: listKnowledgePacks() };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  /** Fetch the server registry and install/refresh distributed agents. */
  ipcMain.handle("agents:refresh-distributed", async (event, payload = {}) => {
    const resolved = scope(event, payload, { mutation: true });
    if (resolved.denied) return resolved.denied;
    try {
      const distribution = require("./agents/agent-distribution");
      const fetched = await distribution.fetchAgentRegistry();
      const listed = distribution.listDistributedAgents();
      const installed = distribution.reconcileDistributedAgents(resolved.repo, characterRepository(), resolved.owner, listed.agents);
      return { ok: true, fetched: fetched.ok, error: fetched.ok ? undefined : fetched.error, installed: [...installed.values()], defaultAgentId: listed.defaultAgentId };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  ipcMain.handle("agents:get", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    if (!validId(payload?.agentId)) return failure("INVALID_INPUT");
    try {
      const entity = resolved.repo.getAgent(resolved.owner, payload.agentId);
      if (!entity) return failure("AGENT_NOT_FOUND");
      const item = libraryItem(resolved.repo, resolved.owner, entity);
      const history = resolved.repo.listRevisions(resolved.owner, entity.id, { limit: 50 }).map((revision) => ({
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        sourceKind: revision.source?.kind || "",
        createdAt: revision.createdAt,
        name: revision.displayName,
      }));
      return { ok: true, agent: item, history };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  ipcMain.handle("agents:create", async (event, payload = {}) => {
    const resolved = scope(event, payload, { mutation: true });
    if (resolved.denied) return resolved.denied;
    try {
      const created = resolved.repo.createAgent({
        ownerScope: resolved.owner,
        definition: payload?.definition,
        source: { kind: AGENT_SOURCE_KINDS.created },
      });
      return { ok: true, agent: libraryItem(resolved.repo, resolved.owner, created.entity) };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  ipcMain.handle("agents:revise", async (event, payload = {}) => {
    const resolved = scope(event, payload, { mutation: true });
    if (resolved.denied) return resolved.denied;
    if (!validId(payload?.agentId) || !validId(payload?.expectedBaseRevisionId)) return failure("INVALID_INPUT");
    try {
      const revised = resolved.repo.createRevision({
        ownerScope: resolved.owner,
        agentId: payload.agentId,
        expectedBaseRevisionId: payload.expectedBaseRevisionId,
        definition: payload?.definition,
        source: { kind: AGENT_SOURCE_KINDS.edited },
      });
      return { ok: true, agent: libraryItem(resolved.repo, resolved.owner, revised.entity), unchanged: Boolean(revised.unchanged) };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  ipcMain.handle("agents:archive", async (event, payload = {}) => {
    const resolved = scope(event, payload, { mutation: true });
    if (resolved.denied) return resolved.denied;
    if (!validId(payload?.agentId)) return failure("INVALID_INPUT");
    try {
      const entity = payload?.action === "restore"
        ? resolved.repo.restoreAgent(resolved.owner, payload.agentId)
        : resolved.repo.archiveAgent(resolved.owner, payload.agentId);
      if (!entity) return failure("AGENT_NOT_FOUND");
      return { ok: true, agent: libraryItem(resolved.repo, resolved.owner, entity) };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  ipcMain.handle("agents:install-official", async (event, payload = {}) => {
    const resolved = scope(event, payload, { mutation: true });
    if (resolved.denied) return resolved.denied;
    if (!validId(payload?.officialId)) return failure("INVALID_INPUT");
    try {
      const result = ensureOfficialInstalled(resolved.repo, resolved.owner, payload.officialId);
      if (result.error) return failure(result.error);
      return { ok: true, agent: libraryItem(resolved.repo, resolved.owner, result.entity) };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  // -- session binding ------------------------------------------------------

  ipcMain.handle("agents:get-session", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    if (!validId(payload?.sessionId)) return failure("INVALID_INPUT");
    try {
      const authority = ctx.sessionManager?.resolveTurnOwnerScope?.(payload.sessionId);
      if (!authority?.ok) return failure(authority?.error || "NO_SESSION");
      const binding = resolved.repo.getBinding(payload.sessionId, authority.ownerScope);
      let agent = null;
      let updateAvailable = false;
      if (binding.agentId) {
        const entity = resolved.repo.getAgent(authority.ownerScope, binding.agentId);
        if (entity) {
          agent = libraryItem(resolved.repo, authority.ownerScope, entity);
          updateAvailable = Boolean(entity.currentRevisionId && entity.currentRevisionId !== binding.agentRevisionId);
        }
      }
      const policy = resolveSessionAgentPolicy(ctx, payload.sessionId);
      return {
        ok: true,
        enabled: agentsEnabled(),
        binding: {
          bindingVersion: binding.bindingVersion,
          agentId: binding.agentId,
          agentRevisionId: binding.agentRevisionId,
          displayName: binding.displayName,
          receipt: binding.receipt,
          updatedAt: binding.updatedAt,
        },
        agent,
        updateAvailable,
        active: policy.active,
      };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  ipcMain.handle("agents:activate", async (event, payload = {}) => {
    const resolved = scope(event, payload, { mutation: true });
    if (resolved.denied) return resolved.denied;
    if (!validId(payload?.sessionId)) return failure("INVALID_INPUT");
    if (payload.agentId != null && !validId(payload.agentId)) return failure("INVALID_INPUT");
    if (payload.officialId != null && !validId(payload.officialId)) return failure("INVALID_INPUT");
    if (!payload.agentId && !payload.officialId) return failure("INVALID_INPUT");
    if (payload.expectedBindingVersion != null && (!Number.isInteger(payload.expectedBindingVersion) || payload.expectedBindingVersion < 0)) {
      return failure("INVALID_INPUT");
    }
    if (isSessionBusy(ctx.runnerPool, payload.sessionId)) return failure("BUSY");
    try {
      let agentId = payload.agentId || null;
      if (!agentId) {
        const installed = ensureOfficialInstalled(resolved.repo, resolved.owner, payload.officialId);
        if (installed.error) return failure(installed.error);
        agentId = installed.entity.id;
      }
      const revision = resolved.repo.getCurrentRevision(resolved.owner, agentId);
      if (!revision) return failure("AGENT_NOT_FOUND");
      const result = await activateAgent({
        ctx,
        sessionId: payload.sessionId,
        agentRevisionId: revision.id,
        expectedBindingVersion: payload.expectedBindingVersion,
      });
      refreshSessionRuntime(payload.sessionId);
      noteBinding(resolved, payload.sessionId, "activated", resolved.repo.getAgent(resolved.owner, agentId), revision, result.receipt, result.binding.bindingVersion);
      return {
        ok: true,
        binding: {
          bindingVersion: result.binding.bindingVersion,
          agentId: result.binding.agentId,
          agentRevisionId: result.binding.agentRevisionId,
          displayName: result.binding.displayName,
        },
        receipt: result.receipt,
        agent: libraryItem(resolved.repo, resolved.owner, resolved.repo.getAgent(resolved.owner, agentId)),
      };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  ipcMain.handle("agents:deactivate", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    if (!validId(payload?.sessionId)) return failure("INVALID_INPUT");
    if (payload.expectedBindingVersion != null && (!Number.isInteger(payload.expectedBindingVersion) || payload.expectedBindingVersion < 0)) {
      return failure("INVALID_INPUT");
    }
    if (isSessionBusy(ctx.runnerPool, payload.sessionId)) return failure("BUSY");
    try {
      const before = resolveSessionAgentPolicy(ctx, payload.sessionId);
      const result = await deactivateAgent({ ctx, sessionId: payload.sessionId, expectedBindingVersion: payload.expectedBindingVersion });
      refreshSessionRuntime(payload.sessionId);
      if (before.active) noteBinding(resolved, payload.sessionId, "deactivated", resolved.repo.getAgent(resolved.owner, before.agentId), null, null, result.binding.bindingVersion);
      return { ok: true, binding: { bindingVersion: result.binding.bindingVersion, agentId: null, agentRevisionId: null }, restored: result.restored };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  // -- knowledge ------------------------------------------------------------

  ipcMain.handle("agents:knowledge-packs", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    return {
      ok: true,
      packs: listKnowledgePacks().map((pack) => ({ ...pack, status: getKnowledgePack(pack.id)?.status?.() || null })),
    };
  });

  // -- portability (P0: single-agent JSON file) -----------------------------

  ipcMain.handle("agents:export", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    if (!validId(payload?.agentId)) return failure("INVALID_INPUT");
    try {
      const revision = resolved.repo.getCurrentRevision(resolved.owner, payload.agentId);
      if (!revision) return failure("AGENT_NOT_FOUND");
      const definition = JSON.parse(JSON.stringify(revision.definition));
      let roleCard = null;
      // A locally authored role travels INSIDE the file so the importer can
      // recreate it; official roles stay references.
      if (definition.role && !definition.role.officialCharacterId) {
        const repo = characterRepository();
        const revisionId = definition.role.characterRevisionId
          || repo?.getCharacter?.(resolved.owner, definition.role.characterEntityId)?.currentRevisionId;
        const card = revisionId ? repo?.getRevision?.(resolved.owner, revisionId) : null;
        if (card?.canonical) roleCard = { canonical: card.canonical };
        definition.role = null;
      }
      const file = { kind: AGENT_FILE_KIND, schemaVersion: 1, exportedAt: new Date().toISOString(), definition, ...(roleCard ? { roleCard } : {}) };
      const picked = await dialog.showSaveDialog(ctx.mainWindow, {
        defaultPath: `${safeFileStem(definition.name)}.lily-agent.json`,
        filters: AGENT_FILE_FILTERS,
      });
      if (picked.canceled || !picked.filePath) return { ok: false, error: "CANCELED" };
      fs.writeFileSync(picked.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      return { ok: true, fileName: require("node:path").basename(picked.filePath) };
    } catch (error) {
      return mapAgentError(error);
    }
  });

  ipcMain.handle("agents:import", async (event, payload = {}) => {
    const resolved = scope(event, payload, { mutation: true });
    if (resolved.denied) return resolved.denied;
    try {
      const picked = await dialog.showOpenDialog(ctx.mainWindow, { properties: ["openFile"], filters: AGENT_FILE_FILTERS });
      const sourcePath = picked.canceled ? "" : picked.filePaths?.[0] || "";
      if (!sourcePath) return { ok: false, error: "CANCELED" };
      const stat = fs.statSync(sourcePath);
      if (stat.size > MAX_IMPORT_BYTES) return failure("AGENT_FILE_TOO_LARGE");
      const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      if (parsed?.kind !== AGENT_FILE_KIND || !parsed.definition) return failure("AGENT_FILE_INVALID");
      const result = importAgentFile({ repo: resolved.repo, owner: resolved.owner, characterRepo: characterRepository(), file: parsed, importedFrom: require("node:path").basename(sourcePath) });
      return { ok: true, agent: libraryItem(resolved.repo, resolved.owner, result.entity), roleImported: result.roleImported };
    } catch (error) {
      return mapAgentError(error);
    }
  });
}

/**
 * Import a `lily-agent` file: validate the definition, recreate an embedded
 * role card through the character repository (same hostile-import pipeline),
 * and store the agent with `imported` provenance. Pure over injected repos.
 */
function importAgentFile({ repo, owner, characterRepo, file, importedFrom = "" }) {
  const definition = normalizeAgentDefinition(file.definition);
  let roleImported = false;
  if (!definition.role && file.roleCard?.canonical && characterRepo?.createCharacter) {
    const created = characterRepo.createCharacter({
      ownerScope: owner,
      canonical: file.roleCard.canonical,
      source: { kind: "imported", format: "lily", container: "json", importedFrom: String(importedFrom || "agent-file") },
    });
    definition.role = { characterEntityId: created.entity.id };
    roleImported = true;
  }
  const entity = repo.createAgent({
    ownerScope: owner,
    definition,
    source: { kind: AGENT_SOURCE_KINDS.imported, importedFrom: String(importedFrom || "") },
  });
  return { entity: entity.entity, revision: entity.revision, roleImported };
}

module.exports = { registerAgentHandlers, importAgentFile, AGENT_FILE_KIND };
