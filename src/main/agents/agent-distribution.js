"use strict";

/**
 * Distributed 智能体 — the client half of "admin/enterprise publishes an agent,
 * clients receive it, the user picks it" (docs/agent-management-design.md §3.4 P2).
 *
 * Mirrors skill-manager's registry sync:
 *   GET {apiBaseUrl}/api/agents/registry?channel=stable
 *     Authorization: Bearer <account token>   (optional; anonymous → global only)
 *   → { ok, agents:[{ packageId, agentId, version, channel, scope, publisher,
 *        featured, definition, roleCard?, minAppVersion, updatedAt }] }
 *
 * Targeting rides the signed effective config: `effectiveConfig.agents =
 * { available: [agentIds], default: agentId }` (resolved server-side per
 * scope, media-style). Absent block ⇒ every published agent the registry
 * returned is available and there is no default — today's behaviour.
 *
 * Everything here is fail-open: no service, no network, no account, a
 * malformed registry, or the kill switch all leave the library exactly as it
 * was (last verified cache, or nothing). Distributed agents are installed into
 * the owner's library as `distributed` revisions keyed by package id, so they
 * activate through the very same path as any other agent.
 */

const fs = require("node:fs");
const jsonFile = require("../json-file");
const path = require("node:path");
const { agentsEnabled, AGENT_SOURCE_KINDS } = require("./constants");
const { normalizeAgentDefinition } = require("./agent-definition");

const REGISTRY_CACHE_FILE = "agents-registry.json";
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const MAX_REGISTRY_AGENTS = 200;
const FETCH_TIMEOUT_MS = 15_000;

function cachePath() {
  try { return require("../config").userDataPath(REGISTRY_CACHE_FILE); } catch { return ""; }
}

function readCache() {
  const file = cachePath();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && Array.isArray(parsed.agents) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(state) {
  const file = cachePath();
  if (!file) return false;
  try {
    jsonFile.writeJson(file, state, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function registryUrl(deps) {
  try {
    const remote = deps.remoteConfig.getRemoteEffectiveConfigSync?.();
    const configured = String(remote?.tools?.agentRegistryUrl || "").trim();
    const service = deps.serviceClient.getServiceSettings?.();
    if (configured) {
      if (/^https?:\/\//i.test(configured)) return configured;
      if (configured.startsWith("/") && service?.apiBaseUrl) return `${service.apiBaseUrl}${configured}`;
    }
    if (service?.apiBaseUrl) return `${service.apiBaseUrl}/api/agents/registry?channel=stable`;
  } catch { /* no service */ }
  return "";
}

/** Bound + validate one registry entry; null when unusable. */
function normalizeRegistryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const agentId = String(raw.agentId || "").trim();
  const packageId = String(raw.packageId || "").trim();
  const version = String(raw.version || "").trim();
  if (!agentId || !packageId || !version) return null;
  let definition;
  try {
    definition = normalizeAgentDefinition(raw.definition);
  } catch {
    return null;
  }
  // Distributed roles must be official references or embedded cards; a
  // publisher's local ids mean nothing on this machine.
  if (definition.role && !definition.role.officialCharacterId) definition.role = null;
  const roleCard = raw.roleCard && typeof raw.roleCard === "object" && raw.roleCard.canonical && typeof raw.roleCard.canonical === "object"
    ? { canonical: raw.roleCard.canonical }
    : null;
  const scope = raw.scope && typeof raw.scope === "object" ? raw.scope : {};
  return {
    packageId,
    agentId,
    version,
    channel: String(raw.channel || "stable"),
    scope: { type: scope.type === "organization" ? "organization" : "global", organizationId: scope.organizationId ? String(scope.organizationId) : null },
    publisher: String(raw.publisher || "").slice(0, 200),
    featured: raw.featured === true,
    minAppVersion: String(raw.minAppVersion || ""),
    updatedAt: String(raw.updatedAt || ""),
    definition,
    roleCard,
  };
}

function defaultDeps() {
  return {
    fetch: (url, init) => require("../proxy-aware-fetch")(url, init),
    serviceClient: require("../service-client"),
    remoteConfig: require("../remote-config"),
    accountManager: require("../account-manager"),
    log: (...args) => console.warn("[agents:distribution]", ...args),
  };
}

/** Fetch the registry (authenticated when logged in) and cache it. */
async function fetchAgentRegistry(overrides = {}) {
  if (!agentsEnabled()) return { ok: false, error: "AGENTS_UNAVAILABLE" };
  const deps = { ...defaultDeps(), ...overrides };
  const url = registryUrl(deps);
  if (!url) return { ok: false, error: "NO_SERVICE_URL" };
  const headers = { Accept: "application/json" };
  try {
    const status = deps.accountManager.accountStatus?.();
    if (status?.loggedIn) {
      const token = await deps.accountManager.accessTokenForService?.({});
      if (token?.ok && token.accessToken) headers.Authorization = `Bearer ${token.accessToken}`;
    }
  } catch { /* anonymous */ }
  let json = null;
  try {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
    let response;
    try {
      response = await deps.fetch(url, { headers, signal: controller?.signal });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) return { ok: false, error: "SERVICE_REQUEST_FAILED", status: response.status };
    if (Buffer.byteLength(text, "utf8") > MAX_REGISTRY_BYTES) return { ok: false, error: "REGISTRY_TOO_LARGE" };
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: "SERVICE_REQUEST_FAILED", detail: error?.message || String(error) };
  }
  if (!json || json.ok === false || !Array.isArray(json.agents)) return { ok: false, error: "REGISTRY_INVALID" };
  const agents = json.agents.slice(0, MAX_REGISTRY_AGENTS).map(normalizeRegistryEntry).filter(Boolean);
  const state = { schemaVersion: 1, fetchedAt: new Date().toISOString(), url, agents };
  writeCache(state);
  return { ok: true, ...state };
}

/** The `agents` targeting block from the signed effective config, or null. */
function readAgentTargeting(remoteConfig = require("../remote-config")) {
  try {
    const block = remoteConfig.getRemoteEffectiveConfigSync?.()?.agents;
    if (!block || typeof block !== "object" || Array.isArray(block)) return null;
    const available = Array.isArray(block.available) ? block.available.map((id) => String(id || "").trim()).filter(Boolean) : null;
    const fallback = typeof block.default === "string" ? block.default.trim() : "";
    return { available, default: fallback && (!available || available.includes(fallback)) ? fallback : "" };
  } catch {
    return null;
  }
}

/** Registry entries this device may use (cache-based, sync). */
function listDistributedAgents({ remoteConfig, cache } = {}) {
  if (!agentsEnabled()) return { agents: [], defaultAgentId: "", fetchedAt: "" };
  const state = cache || readCache();
  const targeting = readAgentTargeting(remoteConfig || require("../remote-config"));
  const allowed = targeting?.available ? new Set(targeting.available) : null;
  const agents = (state?.agents || []).filter((entry) => !allowed || allowed.has(entry.agentId));
  const defaultAgentId = targeting?.default && agents.some((entry) => entry.agentId === targeting.default) ? targeting.default : "";
  return { agents, defaultAgentId, fetchedAt: state?.fetchedAt || "" };
}

/**
 * Install/refresh distributed agents into the owner's library as
 * `distributed` revisions (keyed by package id in the source envelope).
 * Returns the map agentId → local entity id.
 */
function reconcileDistributedAgents(agentRepo, characterRepo, ownerScope, entries) {
  const installed = new Map();
  const byPackage = new Map();
  for (const entity of agentRepo.listAgents(ownerScope, { includeArchived: true })) {
    const revision = entity.currentRevisionId ? agentRepo.getRevision(ownerScope, entity.currentRevisionId) : null;
    if (revision?.source?.kind === AGENT_SOURCE_KINDS.distributed && revision.source.packageId) {
      byPackage.set(String(revision.source.packageId), { entity, revision });
    }
  }
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      const definition = JSON.parse(JSON.stringify(entry.definition));
      if (entry.roleCard && characterRepo && !definition.role) {
        const created = characterRepo.createCharacter({
          ownerScope,
          canonical: entry.roleCard.canonical,
          source: { kind: "imported", format: "lily", container: "json", importedFrom: `distributed:${entry.packageId}` },
        });
        definition.role = { characterEntityId: created.entity.id };
      }
      const source = {
        kind: AGENT_SOURCE_KINDS.distributed,
        packageId: entry.packageId,
        packageVersion: entry.version,
        channel: entry.channel,
        publisher: entry.publisher,
      };
      const existing = byPackage.get(entry.packageId);
      if (existing) {
        if (existing.revision.source.packageVersion !== entry.version) {
          agentRepo.createRevision({ ownerScope, agentId: existing.entity.id, expectedBaseRevisionId: existing.entity.currentRevisionId, definition, source });
        }
        if (existing.entity.archivedAt) agentRepo.restoreAgent(ownerScope, existing.entity.id);
        installed.set(entry.agentId, existing.entity.id);
      } else {
        const created = agentRepo.createAgent({ ownerScope, definition, source });
        installed.set(entry.agentId, created.entity.id);
      }
    } catch (error) {
      console.warn("[agents:distribution] reconcile skipped", entry?.packageId, error?.code || error?.message || error);
    }
  }
  return installed;
}

/**
 * Apply the distributed default agent to a freshly created session (hot
 * dimensions only, no skill installs). Fail-open: any problem leaves the
 * session native.
 */
async function applyDefaultAgentToNewSession(ctx, sessionId, overrides = {}) {
  try {
    if (!agentsEnabled()) return { applied: false, reason: "disabled" };
    const listed = typeof overrides.listDistributedAgents === "function"
      ? overrides.listDistributedAgents()
      : listDistributedAgents();
    const { defaultAgentId, agents } = listed;
    if (!defaultAgentId) return { applied: false, reason: "no_default" };
    const entry = agents.find((item) => item.agentId === defaultAgentId);
    const repo = ctx.agentRepository || ctx.sessionManager?._store?.()?.agents?.();
    const owner = ctx.sessionManager?.resolveTurnOwnerScope?.(sessionId);
    if (!entry || !repo || !owner?.ok) return { applied: false, reason: "unavailable" };
    const installed = reconcileDistributedAgents(repo, ctx.characterWorldsRepository || null, owner.ownerScope, [entry]);
    const agentId = installed.get(defaultAgentId);
    const revision = agentId ? repo.getCurrentRevision(owner.ownerScope, agentId) : null;
    if (!revision) return { applied: false, reason: "not_installed" };
    const { activateAgent } = require("./agent-activation");
    const result = await activateAgent({
      ctx, sessionId, agentRevisionId: revision.id,
      deps: {
        ...(overrides.activationDeps || {}),
        skillManager: {
          ...(overrides.activationDeps?.skillManager || require("../skill-manager")),
          installFromRegistry: async () => ({ ok: false, error: "SKIPPED_ON_DEFAULT" }),
        },
      },
    });
    return { applied: true, agentId, receipt: result.receipt };
  } catch (error) {
    console.warn("[agents:distribution] default agent not applied:", error?.code || error?.message || error);
    return { applied: false, reason: "error" };
  }
}

module.exports = {
  REGISTRY_CACHE_FILE,
  normalizeRegistryEntry,
  fetchAgentRegistry,
  readAgentTargeting,
  listDistributedAgents,
  reconcileDistributedAgents,
  applyDefaultAgentToNewSession,
  readCache,
};
