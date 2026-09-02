"use strict";

/**
 * Tell the user WHICH model would read their image directly.
 *
 * Auto model selection already prefers a vision-capable model when the turn
 * carries images, and deliberately keeps the reasoning baseline first
 * (model-selection.js: "Vision-to-text remains available for a stronger
 * text-only model"). But a MANUAL selection returns early, before any of that —
 * so a user who pinned a text-only model always goes through the vision bridge
 * and was never told why an image question took ~30s, nor what to change.
 *
 * This deliberately does NOT switch models. A manual pick is an explicit user
 * choice, and a vision-capable model can be weaker at reasoning, so silently
 * rerouting would override the user AND risk a capability downgrade. Naming the
 * real alternatives leaves the decision where it belongs.
 *
 * Fail-open by construction: every input is optional and any catalog problem
 * yields "" — the bridge notice simply omits the advice, which is today's
 * behaviour.
 */

const MAX_SUGGESTIONS = 3;

/** Vision-capable options from the live catalog, minus the active one. */
function listVisionCapableModels({ models, activeModelId = "" } = {}) {
  const list = Array.isArray(models) ? models : [];
  const out = [];
  const seen = new Set();
  for (const model of list) {
    if (!model?.capabilities?.vision) continue;
    const id = String(model.id || "");
    if (!id || id === activeModelId || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: String(model.label || id).trim() || id });
  }
  return out;
}

/** Catalog lookup, isolated so a catalog failure can never break a turn. */
function loadModelCatalog(sessionId = "") {
  try {
    const { listModelSelectionPublic } = require("./model-selection-catalog");
    const state = listModelSelectionPublic(sessionId) || {};
    return {
      models: Array.isArray(state.models) ? state.models : [],
      activeModelId: String(state.selection?.manualModelId || ""),
    };
  } catch {
    return { models: [], activeModelId: "" };
  }
}

/**
 * One clause naming what would read the image directly, or "" when there is
 * nothing useful to say. Never promises a model the user does not have.
 */
function buildVisionFallbackAdvice(input = {}) {
  const catalog = input.models ? input : loadModelCatalog(input.sessionId);
  const candidates = listVisionCapableModels({
    models: catalog.models,
    activeModelId: input.activeModelId || catalog.activeModelId,
  });
  if (!candidates.length) return "";
  const named = candidates.slice(0, MAX_SUGGESTIONS).map((model) => model.label);
  const more = candidates.length > named.length ? ` 等 ${candidates.length} 个` : "";
  return `可直接读图的模型：${named.join("、")}${more}（在设置里切换即可跳过转述）`;
}

module.exports = {
  MAX_SUGGESTIONS,
  buildVisionFallbackAdvice,
  listVisionCapableModels,
};
