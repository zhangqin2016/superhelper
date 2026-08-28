"use strict";

import { $ } from "./dom.js";
import store from "./state.js";
import { showToast } from "./toast.js";
import { t, onLocaleChange } from "../i18n/index.js";

const defaultSelection = () => ({ mode: "auto", autoPoolMode: "recommended", autoModelIds: [], manualModelId: "" });
let state = { models: [], selection: defaultSelection(), loaded: false };
let confirmed = null;
let initialized = false;
let generation = 0;
let loading = null;
let saving = null;
let scope = "";
let saveError = false;

function copySelection(selection = state.selection) {
  return {
    mode: selection?.mode === "manual" ? "manual" : "auto",
    autoPoolMode: selection?.autoPoolMode === "custom" || (!selection?.autoPoolMode && selection?.autoModelIds?.length) ? "custom" : "recommended",
    autoModelIds: Array.isArray(selection?.autoModelIds) ? [...selection.autoModelIds] : [],
    manualModelId: String(selection?.manualModelId || ""),
  };
}

function updateButton() {
  const btn = $("modelSelectionBtn");
  if (!btn) return;
  const manual = state.models.find(model => model.id === state.selection.manualModelId);
  $("modelSelectionLabel").textContent = state.selection.mode === "manual"
    ? manual?.label || t("composer.modelUnavailable") : t("composer.modelAuto");
  btn.classList.toggle("is-manual", state.selection.mode === "manual");
  btn.title = state.selection.mode === "manual"
    ? t("composer.modelManualTitle", { model: manual?.label || t("composer.modelUnavailable") })
    : t("composer.modelAutoTitle");
  btn.setAttribute("aria-label", btn.title);
}

function modelOption(model, mode) {
  const row = document.createElement("label");
  row.className = "model-selection-option";
  row.title = `${model.label} (${model.modelID})`;
  const input = document.createElement("input");
  input.type = mode === "manual" ? "radio" : "checkbox";
  input.name = mode === "manual" ? "model-selection-manual" : "model-selection-auto";
  input.value = model.id;
  input.disabled = Boolean(saving);
  input.checked = mode === "manual" ? state.selection.manualModelId === model.id : state.selection.autoModelIds.includes(model.id);
  input.addEventListener("change", () => {
    if (saving) return;
    if (mode === "manual") {
      state.selection.mode = "manual";
      state.selection.manualModelId = model.id;
    } else {
      const ids = new Set(state.selection.autoModelIds);
      if (input.checked) ids.add(model.id);
      else ids.delete(model.id);
      if (!ids.size) {
        input.checked = true;
        showToast(t("composer.modelKeepOne"), "warning");
        return;
      }
      state.selection.autoPoolMode = "custom";
      state.selection.autoModelIds = [...ids];
    }
    void saveSelection();
  });
  const copy = document.createElement("span");
  copy.className = "model-selection-option-copy";
  const name = document.createElement("strong");
  name.textContent = model.label;
  const detail = document.createElement("small");
  detail.textContent = model.modelID;
  copy.append(name, detail);
  row.append(input, copy);
  return row;
}

function renderPopover() {
  const root = $("modelSelectionPopover");
  if (!root) return;
  const focused = document.activeElement;
  const focusKey = focused?.matches(".model-selection-list input") ? { value: focused.value, name: focused.name } : null;
  const manualMode = state.selection.mode === "manual";
  for (const [id, checked] of [["modelSelectionModeAuto", !manualMode], ["modelSelectionModeManual", manualMode]]) {
    const input = $(id);
    input.checked = checked;
    input.disabled = Boolean(saving) || !state.models.length;
  }
  for (const [id, mode] of [["modelSelectionAutoList", "auto"], ["modelSelectionManualList", "manual"]]) {
    const list = $(id);
    list.replaceChildren(...state.models.map(model => modelOption(model, mode)));
    list.hidden = (mode === "manual") !== manualMode;
  }
  const empty = $("modelSelectionEmpty");
  const emptyPool = !manualMode && !state.selection.autoModelIds.length;
  empty.hidden = Boolean(state.models.length) && !emptyPool;
  empty.textContent = t(emptyPool && state.models.length ? "composer.modelPoolEmpty" : "composer.modelNoModels");
  const reset = $("modelSelectionReset");
  if (reset) reset.disabled = Boolean(saving) || !state.models.length;
  const status = $("modelSelectionStatus");
  if (status) status.textContent = t(saving ? "composer.modelSaving" : saveError ? "composer.modelSaveFailed" : "composer.modelSelectionSaved");
  if (focusKey && !saving) {
    [...root.querySelectorAll("input")].find(input => input.value === focusKey.value && input.name === focusKey.name)?.focus();
  }
  updateButton();
}

async function loadModels(force = false) {
  if (saving) await saving;
  if (loading) return loading;
  if (state.loaded && !force) return true;
  const ticket = generation;
  const sessionId = scope;
  const pending = (async () => {
    try {
      const result = await window.assistantClient.listModelSelection(sessionId || null);
      if (!result?.ok) throw new Error("model catalog unavailable");
      if (ticket !== generation || sessionId !== scope) return false;
      state.models = Array.isArray(result.models) ? result.models : [];
      state.selection = copySelection(result.selection);
      state.loaded = true;
      saveError = false;
      confirmed = copySelection();
      renderPopover();
      return true;
    } catch {
      if (ticket === generation && sessionId === scope) {
        state.loaded = false;
        renderPopover();
      }
      return false;
    }
  })();
  loading = pending;
  try { return await pending; } finally { if (loading === pending) loading = null; }
}

function saveSelection() {
  if (saving) return saving;
  const selection = copySelection();
  const sessionId = scope;
  const ticket = ++generation;
  saveError = false;
  const pending = (async () => {
    try {
      const result = await window.assistantClient.setModelSelection(selection, sessionId || null);
      if (!result?.ok) throw new Error(result?.error || "save failed");
      if (ticket !== generation || sessionId !== scope) return;
      state.selection = copySelection(result.selection);
      confirmed = copySelection();
      if (Array.isArray(result.models)) state.models = result.models;
    } catch {
      if (ticket === generation && sessionId === scope) {
        state.selection = copySelection(confirmed || defaultSelection());
        saveError = true;
        showToast(t("composer.modelSaveFailed"), "error");
      }
    }
  })();
  saving = pending;
  renderPopover();
  void pending.finally(() => {
    if (saving === pending) saving = null;
    if (ticket === generation && sessionId === scope) renderPopover();
  });
  return pending;
}

function closePopover(restoreFocus = false) {
  $("modelSelectionPopover")?.setAttribute("hidden", "");
  $("modelSelectionBtn")?.setAttribute("aria-expanded", "false");
  if (restoreFocus) $("modelSelectionBtn")?.focus();
}

function positionPopover() {
  const root = $("modelSelectionPopover");
  if (!root || root.hidden) return;
  const rect = $("modelSelectionBtn").getBoundingClientRect();
  root.style.maxHeight = `${Math.max(100, Math.min(480, innerHeight - 24))}px`;
  const width = root.getBoundingClientRect().width;
  root.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
  const height = root.getBoundingClientRect().height;
  root.style.top = `${Math.max(12, Math.min(rect.top - height - 8, innerHeight - height - 12))}px`;
}

function openPopover() {
  const root = $("modelSelectionPopover");
  root.hidden = false;
  $("modelSelectionBtn").setAttribute("aria-expanded", "true");
  renderPopover();
  positionPopover();
  void loadModels(true).then(() => {
    if (!root.hidden) {
      positionPopover();
      root.querySelector(".model-selection-modes input:checked")?.focus();
    }
  });
}

export async function getModelSelectionSnapshot(sessionId = scope) {
  if (saving) await saving;
  if (sessionId !== scope) {
    try {
      const result = await window.assistantClient.listModelSelection(sessionId || null);
      return result?.ok ? copySelection(result.selection) : null;
    } catch {
      return null;
    }
  }
  const loaded = await loadModels();
  if (sessionId !== scope) return getModelSelectionSnapshot(sessionId);
  // On either foreground or background load failure, main resolves the current
  // persisted preference. Never send stale confirmed state or invent an Auto pool.
  if (!loaded) return null;
  return copySelection();
}

export function initModelPicker() {
  const btn = $("modelSelectionBtn");
  if (initialized || !btn) return;
  initialized = true;
  scope = store.get("activeSessionId") || "";
  btn.removeAttribute("data-i18n-title");
  btn.addEventListener("click", () => {
    if ($("modelSelectionPopover").hidden) openPopover();
    else closePopover();
  });
  $("modelSelectionClose")?.addEventListener("click", () => closePopover(true));
  for (const [id, mode] of [["modelSelectionModeAuto", "auto"], ["modelSelectionModeManual", "manual"]]) {
    $(id).addEventListener("change", () => {
      state.selection.mode = mode;
      if (!state.models.some(model => model.id === state.selection.manualModelId)) state.selection.manualModelId = state.models[0]?.id || "";
      void saveSelection();
    });
  }
  $("modelSelectionReset")?.addEventListener("click", () => {
    state.selection = { ...state.selection, mode: "auto", autoPoolMode: "recommended", autoModelIds: state.models.map(model => model.id) };
    void saveSelection();
  });
  document.addEventListener("click", event => {
    if (!$("modelSelectionPopover").hidden && !$("modelSelectionPopover").contains(event.target) && !btn.contains(event.target)) closePopover();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("modelSelectionPopover").hidden) {
      event.preventDefault();
      closePopover(true);
    }
  });
  window.addEventListener("resize", positionPopover);
  onLocaleChange(renderPopover);
  store.on("activeSessionId", sessionId => {
    if ((sessionId || "") === scope) return;
    scope = sessionId || "";
    generation += 1;
    loading = null;
    confirmed = null;
    state = { models: [], selection: defaultSelection(), loaded: false };
    closePopover();
    renderPopover();
    void loadModels();
  });
  void loadModels();
}
