/**
 * Model preset options — rendered inside the settings panel.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import store from "./state.js";
import { t, tModel, tModelDesc } from "../i18n/index.js";

import { anySessionRunning } from "./session-runtime-store.js";

// Completion alerts moved to the General settings page (they are notification
// preferences, not model config). See settings-panel.js + index.html General.

function isBusy() {
  return anySessionRunning();
}

function apiErrorMessage(error) {
  if (error === "INVALID_BASE_URL") return t("toast.modelApiInvalidBaseUrl");
  if (error === "INVALID_API_KEY") return t("toast.modelApiInvalidKey");
  if (error === "INVALID_LABEL") return t("toast.modelCustomInvalidLabel");
  if (
    error === "INVALID_MODEL"
    || error === "INVALID_MODEL_HAIKU"
    || error === "INVALID_MODEL_SONNET"
    || error === "INVALID_MODEL_OPUS"
    || error === "INVALID_MODEL_SUBAGENT"
  ) {
    return t("toast.modelCustomInvalidModel");
  }
  if (error === "MODEL_AGENT_TOOL_SHAPE_UNSUPPORTED") return t("toast.modelProbeToolShapeUnsupported");
  if (error === "MODEL_TOOL_CALLS_UNAVAILABLE") return t("toast.modelProbeToolCallsUnavailable");
  if (error === "MODEL_REASONING_ONLY") return t("toast.modelProbeReasoningOnly");
  if (error === "MODEL_STREAMING_NO_CONTENT") return t("toast.modelProbeStreamingNoContent");
  if (error === "MODEL_NO_CONTENT") return t("toast.modelProbeNoContent");
  return t("toast.modelApiSaveFailed");
}

function normalizeProtocolValue(value) {
  return value === "anthropic" ? "anthropic" : "openai";
}

function renderModelLibraryList(presets) {
  const list = $("modelLibraryList");
  if (!list) return;

  const availablePresets = Array.isArray(presets) ? presets : [];
  list.replaceChildren();

  if (!availablePresets.length) {
    const empty = document.createElement("p");
    empty.className = "model-custom-empty";
    empty.textContent = t("settings.modelLibraryEmpty");
    list.appendChild(empty);
    return;
  }

  for (const preset of availablePresets) {
    const row = document.createElement("div");
    row.className = "model-custom-row";

    const meta = document.createElement("div");
    meta.className = "model-custom-meta";

    const title = document.createElement("div");
    title.className = "model-library-title";

    const name = document.createElement("span");
    name.className = "model-custom-name";
    name.textContent = tModel(preset);

    const badge = document.createElement("span");
    badge.className = `model-library-badge${preset.custom ? " is-custom" : ""}`;
    badge.textContent = t(preset.custom ? "settings.modelLibraryCustom" : "settings.modelLibraryOfficial");
    title.append(name, badge);

    const model = document.createElement("span");
    model.className = "model-custom-id";
    model.textContent = preset.model || "";

    meta.appendChild(title);
    meta.appendChild(model);

    const descriptionText = tModelDesc(preset);
    if (descriptionText) {
      const description = document.createElement("span");
      description.className = "model-custom-api";
      description.textContent = descriptionText;
      meta.appendChild(description);
    }

    if (preset.custom && (preset.baseUrl || preset.apiKeySet)) {
      const api = document.createElement("span");
      api.className = "model-custom-api";
      if (preset.baseUrl) {
        api.textContent = preset.protocol ? `${preset.baseUrl} · ${preset.protocol}` : preset.baseUrl;
      } else if (preset.apiKeySet) {
        api.textContent = t("settings.modelCustomOwnKey");
      }
      meta.appendChild(api);
    }
    if (preset.custom && preset.tlsSkipVerify) {
      const tls = document.createElement("span");
      tls.className = "model-custom-api";
      tls.textContent = t("settings.modelTlsSkipVerify");
      meta.appendChild(tls);
    }

    row.appendChild(meta);
    if (preset.custom) {
      const actions = document.createElement("div");
      actions.className = "model-custom-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "settings-action-btn settings-action-btn--compact";
      editBtn.textContent = t("settings.modelCustomEdit");
      editBtn.addEventListener("click", () => {
        setCustomEditMode(preset);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "settings-action-btn settings-action-btn--danger settings-action-btn--compact";
      deleteBtn.textContent = t("settings.modelCustomDelete");
      deleteBtn.addEventListener("click", async () => {
        if (isBusy()) {
          showToast(t("toast.modelBusy"), "error");
          return;
        }
        const result = await window.assistantClient.deleteCustomModel(preset.id);
        if (!result.ok) {
          showToast(t("toast.modelCustomDeleteFailed"), "error");
          return;
        }
        if (editingCustomPresetId === preset.id) setCustomEditMode(null);
        showToast(t("toast.modelCustomDeleted"), "success");
        await refreshModelSelect();
      });

      actions.append(editBtn, deleteBtn);
      row.appendChild(actions);
    }
    list.appendChild(row);
  }
}

// Server-published BYOK provider catalog (endpoint + protocol + models, no keys).
// The "add model" flow lets the user pick a provider + model and enter their own
// key — no manual URL/model typing (that lives under the collapsed "advanced").
let catalogProviders = [];
let diagnoseRestoreRunning = false;
let editingCustomPresetId = null;

function customFormPayload() {
  return {
    label: $("modelCustomLabel")?.value?.trim() || "",
    model: $("modelCustomId")?.value?.trim() || "",
    baseUrl: $("modelCustomBaseUrl")?.value?.trim() || "",
    protocol: normalizeProtocolValue($("modelCustomProtocol")?.value),
    apiKey: $("modelCustomApiKey")?.value?.trim() || "",
    tlsSkipVerify: Boolean($("modelCustomTlsSkipVerify")?.checked),
  };
}

function resetCustomForm() {
  for (const id of [
    "modelCustomLabel",
    "modelCustomId",
    "modelCustomBaseUrl",
    "modelCustomProtocol",
    "modelCustomApiKey",
    "modelCustomTlsSkipVerify",
  ]) {
    const el = $(id);
    if (el?.type === "checkbox") el.checked = false;
    else if (id === "modelCustomProtocol" && el) el.value = "openai";
    else if (el) el.value = "";
  }
  $("modelCustomApiKey")?.setAttribute("placeholder", t("settings.modelCustomApiKeyPlaceholder"));
}

function setCustomEditMode(preset = null) {
  editingCustomPresetId = preset?.id || null;
  const addBtn = $("modelCustomAddBtn");
  const cancelBtn = $("modelCustomCancelBtn");
  if (addBtn) addBtn.textContent = t(editingCustomPresetId ? "settings.modelCustomSave" : "settings.modelCustomAdd");
  if (cancelBtn) cancelBtn.hidden = !editingCustomPresetId;
  if (!preset) {
    resetCustomForm();
    return;
  }

  const advanced = $("modelAdvancedBlock");
  if (advanced) advanced.open = true;
  if ($("modelCustomLabel")) $("modelCustomLabel").value = preset.label || "";
  if ($("modelCustomId")) $("modelCustomId").value = preset.model || "";
  if ($("modelCustomBaseUrl")) $("modelCustomBaseUrl").value = preset.baseUrl || "";
  if ($("modelCustomProtocol")) $("modelCustomProtocol").value = normalizeProtocolValue(preset.protocol);
  if ($("modelCustomTlsSkipVerify")) $("modelCustomTlsSkipVerify").checked = Boolean(preset.tlsSkipVerify);
  if ($("modelCustomApiKey")) {
    $("modelCustomApiKey").value = "";
    $("modelCustomApiKey").setAttribute(
      "placeholder",
      preset.apiKeySet ? t("settings.modelCustomApiKeyKeepPlaceholder") : t("settings.modelCustomApiKeyPlaceholder"),
    );
  }
  $("modelCustomLabel")?.focus();
}

function renderCatalogModels(provider) {
  const modelSel = $("modelCatalogModel");
  if (!modelSel) return;
  modelSel.replaceChildren();
  for (const model of provider?.models || []) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelSel.appendChild(option);
  }
}

function renderCatalog(catalog) {
  catalogProviders = Array.isArray(catalog) ? catalog : [];
  const providerSel = $("modelCatalogProvider");
  // Hide the whole "add model" block when the server published no catalog —
  // the user can still add a model via the collapsed "advanced" manual form.
  const block = $("modelCatalogBlock") || providerSel?.closest(".settings-field");
  if (block) block.hidden = catalogProviders.length === 0;
  if (!providerSel) return;
  const prev = providerSel.value;
  providerSel.replaceChildren();
  for (const provider of catalogProviders) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label || provider.id;
    providerSel.appendChild(option);
  }
  if (prev && catalogProviders.some((p) => p.id === prev)) providerSel.value = prev;
  renderCatalogModels(catalogProviders.find((p) => p.id === providerSel.value) || catalogProviders[0]);
}

// Engine picker removed: OpenCode is the only engine, so there's nothing to pick.
// The engine still resolves server/env-side (LILY_ENGINE); it's just not a UI choice.

export async function refreshModelSelect() {
  const data = await window.assistantClient.listModels();
  if (!data?.ok) return;

  renderModelLibraryList(data.presets);
  renderCatalog(data.catalog);
}

function setDiagnoseRestoreStatus(messageKey, kind = "info", params = {}) {
  const status = $("modelDiagnoseRestoreStatus");
  if (!status) return;
  if (!messageKey) {
    status.hidden = true;
    status.textContent = "";
    status.className = "settings-form-status model-diagnose-restore-status";
    return;
  }
  status.hidden = false;
  status.textContent = t(messageKey, params);
  status.className = `settings-form-status model-diagnose-restore-status settings-form-status--${kind}`;
}

function diagnoseRestoreSuccessKey(result) {
  if (result?.modelConfigReady === false) return "settings.modelDiagnoseRestorePending";
  if (result?.diagnostics?.repairedCustomPresetCount) return "settings.modelDiagnoseRestoreFixedPollution";
  if (result?.diagnostics?.wasCustomPreset) return "settings.modelDiagnoseRestoreFixedCustom";
  if (result?.diagnostics?.hadCustomApiGateway) return "settings.modelDiagnoseRestoreFixedGateway";
  return "settings.modelDiagnoseRestoreReady";
}

function setDiagnoseRestoreButtonLabel(btn, key) {
  if (!btn) return;
  const label = t(key);
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

async function diagnoseAndRestoreDefaultModel() {
  if (isBusy()) {
    showToast(t("toast.modelBusy"), "error");
    return;
  }
  if (diagnoseRestoreRunning) return;

  const btn = $("modelDiagnoseRestoreBtn");
  diagnoseRestoreRunning = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("is-running");
    setDiagnoseRestoreButtonLabel(btn, "settings.modelDiagnoseRestoreRunning");
  }
  setDiagnoseRestoreStatus("settings.modelDiagnoseRestoreRunning", "info");

  try {
    const result = await window.assistantClient.diagnoseAndRestoreDefaultModel();
    if (!result?.ok) {
      const message = apiErrorMessage(result?.error);
      setDiagnoseRestoreStatus("settings.modelDiagnoseRestoreFailed", "error");
      showToast(message, "error");
      await refreshModelSelect();
      return;
    }
    await refreshModelSelect();
    const messageKey = diagnoseRestoreSuccessKey(result);
    if (result.modelConfigReady === false) {
      const error = result.modelConfigError || t("modelConfig.error.GENERIC");
      setDiagnoseRestoreStatus(messageKey, "warning", { error });
      showToast(t("toast.modelDiagnoseRestorePending", { error }), "warning");
      return;
    }
    setDiagnoseRestoreStatus(messageKey, "success");
    showToast(t("toast.modelDiagnoseRestoreDone"), "success");
  } finally {
    diagnoseRestoreRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("is-running");
      setDiagnoseRestoreButtonLabel(btn, "settings.modelDiagnoseRestore");
    }
  }
}

export async function initModelSettings() {
  await refreshModelSelect();

  $("modelDiagnoseRestoreBtn")?.addEventListener("click", () => void diagnoseAndRestoreDefaultModel());

  // Catalog "add model": pick provider -> models repopulate.
  $("modelCatalogProvider")?.addEventListener("change", () => {
    renderCatalogModels(catalogProviders.find((p) => p.id === $("modelCatalogProvider").value));
  });

  // Catalog "add model": provider + model + the user's own key -> custom preset
  // using the catalog's endpoint/protocol, then switch to it. No URL/model typing.
  $("modelCatalogAddBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.modelBusy"), "error");
      return;
    }
    const provider = catalogProviders.find((p) => p.id === $("modelCatalogProvider")?.value);
    const model = $("modelCatalogModel")?.value?.trim() || "";
    const apiKey = $("modelCatalogKey")?.value?.trim() || "";
    if (!provider || !model) {
      showToast(t("toast.modelCustomInvalidModel"), "error");
      return;
    }
    if (!apiKey) {
      showToast(t("toast.modelApiInvalidKey"), "error");
      return;
    }
    const catalogBtn = $("modelCatalogAddBtn");
    const catalogPrevLabel = catalogBtn ? catalogBtn.textContent : "";
    if (catalogBtn) {
      catalogBtn.disabled = true;
      catalogBtn.dataset.busy = "1";
      catalogBtn.textContent = t("settings.modelVerifying");
    }
    try {
      const result = await window.assistantClient.saveCustomModel({
        label: provider.label,
        model,
        baseUrl: provider.baseUrl,
        apiKey,
        protocol: provider.protocol,
      });
      if (!result.ok) {
        showToast(apiErrorMessage(result.error), "error");
        return;
      }
      if ($("modelCatalogKey")) $("modelCatalogKey").value = "";
      showToast(
        result.probeDeferred ? t("toast.modelProbeDeferred") : t("toast.modelCustomSaved"),
        result.probeDeferred ? "warning" : "success",
      );
      await refreshModelSelect();
    } finally {
      if (catalogBtn) {
        catalogBtn.disabled = false;
        delete catalogBtn.dataset.busy;
        catalogBtn.textContent = catalogPrevLabel;
      }
    }
  });

  $("modelCustomAddBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.modelBusy"), "error");
      return;
    }
    // OpenCode runs ONE model per session (all tiers map to it), so the custom
    // form no longer collects Haiku/Sonnet/Opus — just the model + API, matching
    // OpenCode Desktop. The backend defaults the (omitted) tiers to the main model.
    const payload = customFormPayload();
    const customBtn = $("modelCustomAddBtn");
    if (customBtn) {
      customBtn.disabled = true;
      customBtn.dataset.busy = "1";
      customBtn.textContent = t("settings.modelVerifying");
    }
    try {
      const result = editingCustomPresetId
        ? await window.assistantClient.updateCustomModel(editingCustomPresetId, payload)
        : await window.assistantClient.saveCustomModel(payload);
      if (!result.ok) {
        showToast(apiErrorMessage(result.error), "error");
        return;
      }

      const wasEditing = Boolean(editingCustomPresetId);
      setCustomEditMode(null);

      showToast(
        result.probeDeferred
          ? t("toast.modelProbeDeferred")
          : t(wasEditing ? "toast.modelCustomUpdated" : "toast.modelCustomSaved"),
        result.probeDeferred ? "warning" : "success",
      );
      await refreshModelSelect();
    } finally {
      if (customBtn) {
        customBtn.disabled = false;
        delete customBtn.dataset.busy;
        customBtn.textContent = t(editingCustomPresetId ? "settings.modelCustomSave" : "settings.modelCustomAdd");
      }
    }
  });
  $("modelCustomCancelBtn")?.addEventListener("click", () => setCustomEditMode(null));
}
