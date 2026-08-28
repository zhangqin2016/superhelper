"use strict";

const { createHash } = require("node:crypto");
const digest = value => createHash("sha256").update(value).digest("hex");

function canonicalModelId(id, modelID) {
  const prefix = String(id || "").match(/^(lily-managed:[^:]+:(?:gateway|direct))(?:--.*)?$/)?.[1];
  return prefix && modelID ? `${prefix}--model-${digest(String(modelID)).slice(0, 32)}` : id;
}

function connectionProviderId(id, env) {
  return `lily-model-${digest(JSON.stringify([
    id, env.LILY_OPENCODE_PROTOCOL || "", env.LILY_OPENCODE_PROVIDER_ID || "",
    env.LILY_OPENCODE_BASE_URL || env.LILY_API_BASE_URL || "",
  ])).slice(0, 32)}`;
}

function legacyAliases(presets, existing = {}) {
  const next = { ...existing }, batch = {};
  for (const preset of presets || []) {
    const env = require("./agent-env").normalizeToLilyEnv(preset.env || {});
    const modelID = env.LILY_MODEL || "";
    const id = canonicalModelId(preset.id, modelID);
    if (!id || !modelID) continue;
    const identity = { id, modelID, providerID: connectionProviderId(id, env),
      legacyProviderID: env.LILY_OPENCODE_PROVIDER_ID || (env.LILY_OPENCODE_PROTOCOL === "openai" ? "lily" : "anthropic") };
    if (Object.hasOwn(batch, preset.id) && JSON.stringify(batch[preset.id]) !== JSON.stringify(identity)) batch[preset.id] = null;
    else if (!Object.hasOwn(batch, preset.id)) batch[preset.id] = identity;
  }
  // The first observed meaning wins. A new default must never rewrite an old
  // bare ID; collisions within one catalog cannot be migrated safely.
  for (const [id, identity] of Object.entries(batch)) if (!Object.hasOwn(next, id)) next[id] = identity;
  return next;
}

function migrateSelection(selection, aliases) {
  if (!selection) return selection;
  const migrate = id => aliases[id]?.id || id;
  return { ...selection, manualModelId: migrate(selection.manualModelId),
    autoModelIds: Array.isArray(selection.autoModelIds) ? selection.autoModelIds.map(migrate) : selection.autoModelIds };
}

function resolveActivePresetId(selectedId, catalog, presets, aliases = {}) {
  const previous = aliases[selectedId];
  if (previous && previous.id !== selectedId) {
    const migrated = presets.find(preset => !preset.custom && canonicalModelId(preset.id, preset.model) === previous.id);
    if (migrated) return migrated.id;
  }
  if (selectedId && presets.some(preset => preset.id === selectedId)) return selectedId;
  const fallback = catalog.activePresetId || catalog.presets[0]?.id || "standard";
  return presets.some(preset => preset.id === fallback) ? fallback : presets[0]?.id || "";
}

module.exports = { canonicalModelId, connectionProviderId, legacyAliases, migrateSelection, resolveActivePresetId };
