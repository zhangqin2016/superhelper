"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { userDataPath } = require("./config");
const { normalizeOption, normalizeSelection, routeTurn } = require("./model-selection");
const { canonicalModelId, connectionProviderId, legacyAliases, migrateSelection } = require("./model-identity");

function readStore() {
  let file;
  // Headless callers can use the existing engine without a desktop profile.
  // Once a profile exists, corrupt or unreadable preferences must fail loudly.
  try { file = userDataPath("model-selection.json"); } catch { return null; }
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function readStoredSelection(sessionId = "") {
  const stored = readStore();
  if (stored?.schemaVersion !== 1) return stored;
  return (sessionId && Object.hasOwn(stored.sessions || {}, sessionId) ? stored.sessions[sessionId] : null) || stored.defaultSelection;
}

function writeStoredSelection(selection, sessionId) {
  const stored = readStore();
  const data = stored?.schemaVersion === 1 ? stored : { schemaVersion: 1, defaultSelection: stored, sessions: {} };
  if (sessionId) data.sessions = { ...data.sessions, [sessionId]: selection };
  else data.defaultSelection = selection;
  const file = userDataPath("model-selection.json");
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* rename consumed the temporary file */ }
  }
}

function catalogState() {
  const api = require("./model-presets");
  const remote = require("./remote-config");
  const { normalizeToLilyEnv } = require("./agent-env");
  const { resolveOpencodeModelConfig } = require("./runtime/opencode-model-config");
  const publicState = api.listPresetsPublic();
  const activeId = publicState.activePresetId;
  const active = publicState.presets.find(preset => preset.id === activeId);
  const activeEnv = require("./spawn-env").resolveLilyEnv();
  const remoteCatalog = remote.getRemoteModelCatalogSync();
  const status = active?.custom ? "ready" : (remote.getRemoteModelCatalogStateSync?.().status || (remoteCatalog ? "ready" : "unavailable"));
  const rawPresets = remoteCatalog?.presets || [];
  const aliases = legacyAliases(rawPresets, remote.getRemoteModelIdentityAliasesSync?.());
  const baseEnv = normalizeToLilyEnv({
    ...require("./agent-settings").loadSettingsEnv(), ...remote.getRemoteRuntimeEnvSync(),
  });
  // Connections and probe results are private to each published preset. Only
  // platform capabilities (vision/media/etc.) belong in the shared base.
  for (const key of ["LILY_MODEL", "LILY_MODEL_HAIKU", "LILY_MODEL_SONNET", "LILY_MODEL_OPUS", "LILY_SUBAGENT_MODEL",
    "LILY_API_BASE_URL", "LILY_API_KEY", "LILY_GATEWAY_PROVIDER", "LILY_OPENCODE_MODEL", "LILY_OPENCODE_API_KEY",
    "LILY_OPENCODE_BASE_URL", "LILY_OPENCODE_PROTOCOL", "LILY_OPENCODE_PROVIDER_ID", "LILY_OPENCODE_PROVIDER_NPM",
    "LILY_CONTEXT_WINDOW_TOKENS", "LILY_MAX_OUTPUT_TOKENS", "LILY_CONTEXT_TOKEN_BUDGET",
    "LILY_MODEL_CAPABILITY_GRADE", "LILY_MODEL_RECIPES", "LILY_OPENCODE_BODY_OVERLAY_JSON",
    "LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS", "LILY_OPENCODE_TOOL_COMPAT", "LILY_TLS_SKIP_VERIFY"]) delete baseEnv[key];
  const models = [];
  const runtimeModels = [];
  for (const preset of publicState.presets) {
    if (!preset.model || (active?.custom ? preset.id !== activeId : preset.custom)) continue;
    const raw = rawPresets.find(item => item.id === preset.id);
    if (!preset.custom && status === "ready" && (!raw || raw.enabled === false)) continue;
    if (preset.id !== activeId && !raw?.env) continue;
    const env = preset.id === activeId ? { ...activeEnv } : { ...baseEnv, ...normalizeToLilyEnv(raw.env) };
    const id = canonicalModelId(preset.id, preset.model);
    env.LILY_OPENCODE_PROVIDER_ID = connectionProviderId(id, env);
    const config = resolveOpencodeModelConfig(env);
    if (!config.ok) continue;
    const option = normalizeOption({
      id, label: preset.label, description: preset.description,
      ...config.model, managed: !preset.custom,
      capabilities: raw?.capabilities || preset.capabilities,
      routing: raw?.routing,
      limits: { contextTokens: Number(env.LILY_CONTEXT_WINDOW_TOKENS) || null, outputTokens: Number(env.LILY_MAX_OUTPUT_TOKENS) || null },
      enabled: raw?.enabled,
    });
    if (!option) continue;
    models.push(option);
    runtimeModels.push({ modelID: option.modelID, providerID: option.providerID, env });
  }
  return { models, runtimeModels, activeId: canonicalModelId(activeId, active?.model), status, aliases };
}

function listModelSelectionPublic(sessionId = "") {
  const { models, activeId, aliases, status } = catalogState();
  return {
    models, catalogStatus: status, selection: normalizeSelection(migrateSelection(readStoredSelection(sessionId), aliases), models, activeId),
    recommendedModelIds: models.map(model => model.id), fallbackModelId: activeId,
  };
}

function setModelSelectionPreference(input = {}, sessionId = "") {
  try {
    const state = listModelSelectionPublic(sessionId);
    const selection = normalizeSelection(input, state.models, state.fallbackModelId);
    const validation = routeTurn({ selection, options: state.models, fallbackId: state.fallbackModelId });
    if (!validation.ok) return { ok: false, error: validation.error };
    writeStoredSelection(selection, sessionId);
    return { ok: true, ...state, selection };
  } catch {
    return { ok: false, error: "MODEL_SELECTION_SAVE_FAILED" };
  }
}

function resolveTurnModel(input = {}) {
  let selection;
  try { selection = input.selection || readStoredSelection(input.sessionId); }
  catch { return { ok: false, error: "MODEL_SELECTION_READ_FAILED", model: null }; }
  try {
    const state = catalogState();
    if (state.status === "stale") return { ok: false, error: "MODEL_CATALOG_STALE", model: null };
    selection = migrateSelection(selection, state.aliases);
    const route = routeTurn({
      ...input, selection,
      pinnedModelId: state.aliases[input.pinnedModelId]?.id || input.pinnedModelId,
      options: state.models, fallbackId: state.activeId,
    });
    if (route.ok && route.model) {
      const runtime = state.runtimeModels.find(item => item.modelID === route.model.modelID && item.providerID === route.model.providerID);
      if (!runtime) return { ok: false, error: "MODEL_SNAPSHOT_UNAVAILABLE", model: null };
      const model = Object.freeze({ ...route.model, capabilities: Object.freeze(route.model.capabilities), limits: Object.freeze(route.model.limits), routing: Object.freeze(route.model.routing) });
      return { ...route, model, execution: Object.freeze({ model, env: Object.freeze({ ...runtime.env }) }) };
    }
    if (route.error !== "NO_MODEL_AVAILABLE" || state.status === "ready") return route;
    if (route.selection.mode === "manual" || route.selection.autoPoolMode === "custom" || input.pinnedModelId) return route;
    return { ...route, ok: true, reason: "catalog_unavailable", model: null };
  } catch {
    if (input.pinnedModelId || selection?.mode === "manual" || selection?.autoPoolMode === "custom" || (!selection?.autoPoolMode && selection?.autoModelIds?.length)) {
      return { ok: false, error: "MODEL_CATALOG_UNAVAILABLE", model: null };
    }
    return { ok: true, mode: "auto", reason: "legacy_active_model", selection: selection || null, model: null };
  }
}

function listRuntimeModelIds() {
  try { return catalogState().runtimeModels; }
  catch { return []; }
}

function matchesLegacyModelReceipt(receipt, model) {
  if (!model || receipt.identityVersion >= 2) return false;
  try {
    const identity = catalogState().aliases[receipt.selectionId];
    if (!identity || identity.id !== model.id || identity.modelID !== receipt.modelId || identity.providerID !== model.providerID) return false;
    const legacyHashed = `lily-model-${crypto.createHash("sha256").update(receipt.selectionId).digest("hex").slice(0, 16)}`;
    return receipt.providerId === identity.legacyProviderID || receipt.providerId === legacyHashed;
  } catch { return false; }
}

module.exports = { listModelSelectionPublic, setModelSelectionPreference, resolveTurnModel, listRuntimeModelIds, matchesLegacyModelReceipt };
