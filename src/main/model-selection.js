"use strict";

const VALID_MODES = new Set(["auto", "manual"]);
const idOf = value => typeof value === "string" ? value.trim().slice(0, 256) : "";
const nonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function clone(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeOption(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const modelID = String(raw.modelID || raw.model || "").trim();
  if (!id || !modelID || raw.available === false || raw.enabled === false) return null;
  return {
    id,
    label: String(raw.label || modelID).trim() || modelID,
    description: String(raw.description || "").trim(),
    modelID,
    providerID: String(raw.providerID || "").trim(),
    capabilities: {
      vision: Boolean(raw.capabilities?.vision),
      toolCall: raw.capabilities?.toolCall !== false,
      filePartMimes: Array.isArray(raw.capabilities?.filePartMimes) ? raw.capabilities.filePartMimes.filter(mime => typeof mime === "string").slice(0, 16) : [],
    },
    routing: { quality: nonnegative(raw.routing?.quality), cost: nonnegative(raw.routing?.cost) },
    limits: { contextTokens: nonnegative(raw.limits?.contextTokens), outputTokens: nonnegative(raw.limits?.outputTokens) },
    managed: raw.managed !== false,
  };
}

function normalizeOptions(options) {
  const seen = new Set();
  return (Array.isArray(options) ? options : [])
    .map(normalizeOption)
    .filter((option) => {
      if (!option || seen.has(option.id)) return false;
      seen.add(option.id);
      return true;
    });
}

function normalizeSelection(raw, options, fallbackId = "") {
  const available = normalizeOptions(options);
  const validIds = new Set(available.map((option) => option.id));
  const mode = VALID_MODES.has(String(raw?.mode || "")) ? String(raw.mode) : "auto";
  const autoPoolMode = raw?.autoPoolMode === "recommended" ? "recommended"
    : raw?.autoPoolMode === "custom" || raw?.autoModelIds?.length ? "custom" : "recommended";
  const autoModelIds = (Array.isArray(raw?.autoModelIds) ? raw.autoModelIds : [])
    .slice(0, 128).map(idOf)
    .filter((id, index, list) => validIds.has(id) && list.indexOf(id) === index);
  const manualModelId = idOf(raw?.manualModelId) || (validIds.has(fallbackId) ? fallbackId : "");
  return {
    mode,
    autoPoolMode,
    autoModelIds: autoPoolMode === "recommended" ? available.map((option) => option.id) : autoModelIds,
    manualModelId,
  };
}

function estimateWorkload(text, files = []) {
  const contentLength = String(text || "").length;
  const fileCount = Array.isArray(files) ? files.length : 0;
  const hasImages = (Array.isArray(files) ? files : []).some((file) => {
    const value = `${file?.mime || ""} ${file?.type || ""} ${file?.path || ""}`.toLowerCase();
    return value.includes("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(value);
  });
  return {
    contentLength,
    fileCount,
    hasImages,
    complex: contentLength > 6000 || fileCount >= 4,
  };
}

/**
 * Pick a model for one turn from a snapshot of the user's selection. This is
 * deliberately capability-first and deterministic: models are supplied by
 * the signed service catalog, while the router only chooses among those the
 * user allowed. It never invents model IDs or treats a role/skill as a model.
 */
function routeTurn({ selection, options, fallbackId = "", pinnedModelId = "", requirements = {}, text = "", files = [] } = {}) {
  const available = normalizeOptions(options);
  const normalized = normalizeSelection(selection, available, fallbackId);
  const workload = estimateWorkload(text, files);
  const allowed = available.filter((option) => normalized.autoModelIds.includes(option.id));
  let pool = allowed;
  if (!available.length) {
    return {
      ok: false,
      error: "NO_MODEL_AVAILABLE",
      selection: normalized,
      workload,
      model: null,
    };
  }

  const supportsTools = model => !requirements.tools || model.capabilities.toolCall;
  if (normalized.mode === "manual" || pinnedModelId) {
    const selected = available.find((option) => option.id === (pinnedModelId || normalized.manualModelId));
    if (!selected || !supportsTools(selected)) {
      return {
        ok: false,
        error: "INVALID_MODEL_SELECTION",
        selection: normalized,
        workload,
        model: null,
      };
    }
    return {
      ok: true,
      mode: normalized.mode,
      reason: pinnedModelId ? "inherited_turn" : "user_selected",
      selection: normalized,
      workload,
      model: clone(selected, selected),
    };
  }

  pool = pool.filter(model => supportsTools(model) && (!requirements.nativeVision || model.capabilities.vision));
  const baseline = pool.find(model => model.id === fallbackId);
  // Preserve the reasoning baseline BEFORE preferring a modality or a cheaper
  // model. Vision-to-text remains available for a stronger text-only model.
  if (baseline && pool.every(model => model.routing.quality !== null)) {
    pool = pool.filter(model => model.routing.quality >= baseline.routing.quality);
  } else if (baseline) {
    pool = [baseline];
  }
  const fits = (model, tokens) => !tokens || model.limits.contextTokens === null || model.limits.contextTokens >= tokens;
  const fitting = pool.filter(model => fits(model, requirements.contextTokens));
  // The main runtime can compact history and stage bulk input. Prefer a fitting
  // window, but do not cut off those existing maintenance paths when none fits.
  pool = fitting.length || !requirements.allowContextMaintenance ? fitting : pool;
  const vision = workload.hasImages ? pool.filter(model => model.capabilities.vision) : [];
  if (vision.length) pool = vision;
  let reason = vision.length ? "vision_capability" : "baseline_no_ranking";
  let selected = pool.find(model => model.id === fallbackId) || [...pool].sort((a, b) => a.id.localeCompare(b.id))[0];
  // Missing service ratings are not evidence of low quality. Keep the existing
  // model in that case; never interpret menu order or a model name as a rating.
  if (pool.length && pool.every(model => model.routing.quality !== null)) {
    const floor = baseline?.routing.quality ?? 0;
    const eligible = pool.filter(model => model.routing.quality >= floor);
    const byQuality = (a, b) => b.routing.quality - a.routing.quality || a.id.localeCompare(b.id);
    if (workload.complex || !eligible.every(model => model.routing.cost !== null)) {
      selected = eligible.sort(byQuality)[0];
      reason = "quality_priority";
    } else {
      selected = eligible.sort((a, b) => a.routing.cost - b.routing.cost || byQuality(a, b))[0];
      reason = "cost_with_quality_floor";
    }
    if (vision.length) reason = "vision_capability";
  }
  if (!selected) {
    return { ok: false, error: "NO_ELIGIBLE_MODEL", selection: normalized, workload, model: null };
  }
  return {
    ok: true,
    mode: "auto",
    reason,
    selection: normalized,
    workload,
    model: clone(selected, selected),
  };
}

module.exports = {
  normalizeOption,
  normalizeOptions,
  normalizeSelection,
  estimateWorkload,
  routeTurn,
};
