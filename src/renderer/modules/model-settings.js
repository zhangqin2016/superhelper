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
  return t("toast.modelApiSaveFailed");
}

function updateApiCustomFields(gateway) {
  const hint = $("modelApiKeyHint");
  if (hint) {
    if (gateway?.apiKeySet && gateway?.apiKeyHint) {
      hint.hidden = false;
      hint.textContent = t("settings.modelApiKeyHint", { hint: gateway.apiKeyHint });
    } else {
      hint.hidden = true;
      hint.textContent = "";
    }
  }
}

function normalizeProtocolValue(value) {
  return value === "anthropic" ? "anthropic" : "openai";
}

function renderApiGateway(gateway) {
  const baseUrlInput = $("modelApiBaseUrl");
  const protocolSelect = $("modelApiProtocol");
  const keyInput = $("modelApiKey");
  if (!gateway) return;

  if (baseUrlInput) {
    baseUrlInput.value = gateway.baseUrl || "";
    if (!baseUrlInput.value && gateway.defaultBaseUrl) {
      baseUrlInput.placeholder = gateway.defaultBaseUrl;
    }
  }
  if (protocolSelect) protocolSelect.value = normalizeProtocolValue(gateway.protocol);
  if (keyInput) keyInput.value = "";

  updateApiCustomFields(gateway);
}

function renderCustomList(presets, activePresetId) {
  const list = $("modelCustomList");
  if (!list) return;

  const customPresets = (presets || []).filter((p) => p.custom);
  list.replaceChildren();

  if (!customPresets.length) {
    const empty = document.createElement("p");
    empty.className = "model-custom-empty";
    empty.textContent = t("settings.modelCustomEmpty");
    list.appendChild(empty);
    return;
  }

  for (const preset of customPresets) {
    const row = document.createElement("div");
    row.className = "model-custom-row";

    const meta = document.createElement("div");
    meta.className = "model-custom-meta";

    const name = document.createElement("span");
    name.className = "model-custom-name";
    name.textContent = tModel(preset);

    const model = document.createElement("span");
    model.className = "model-custom-id";
    model.textContent = preset.model || "";

    meta.appendChild(name);
    meta.appendChild(model);

    if (preset.baseUrl || preset.apiKeySet) {
      const api = document.createElement("span");
      api.className = "model-custom-api";
      if (preset.baseUrl) {
        api.textContent = preset.protocol ? `${preset.baseUrl} · ${preset.protocol}` : preset.baseUrl;
      } else if (preset.apiKeySet) {
        api.textContent = t("settings.modelCustomOwnKey");
      }
      meta.appendChild(api);
    }
    if (preset.tlsSkipVerify) {
      const tls = document.createElement("span");
      tls.className = "model-custom-api";
      tls.textContent = t("settings.modelTlsSkipVerify");
      meta.appendChild(tls);
    }

    const actions = document.createElement("div");
    actions.className = "model-custom-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "settings-action-btn";
    useBtn.textContent = t("settings.modelCustomUse");
    useBtn.disabled = preset.id === activePresetId;
    useBtn.addEventListener("click", async () => {
      if (isBusy()) {
        showToast(t("toast.modelBusy"), "error");
        return;
      }
      const result = await window.assistantClient.setActiveModel(preset.id);
      if (!result.ok) {
        showToast(t("toast.modelSwitchFailed"), "error");
        await refreshModelSelect();
        return;
      }
      const active = (result.presets || []).find((p) => p.id === result.activePresetId);
      showToast(t("toast.modelSwitched", { label: tModel(active) || preset.label }), "success");
      await refreshModelSelect();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "settings-action-btn settings-action-btn--danger";
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
      showToast(t("toast.modelCustomDeleted"), "success");
      await refreshModelSelect();
    });

    actions.appendChild(useBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(meta);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

// Server-published BYOK provider catalog (endpoint + protocol + models, no keys).
// The "add model" flow lets the user pick a provider + model and enter their own
// key — no manual URL/model typing (that lives under the collapsed "advanced").
let catalogProviders = [];

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
  const select = $("modelPresetSelect");
  if (!select) return;

  const data = await window.assistantClient.listModels();
  if (!data?.ok) return;

  select.replaceChildren();
  for (const preset of data.presets || []) {
    const option = document.createElement("option");
    option.value = preset.id;
    const label = tModel(preset);
    option.textContent = preset.model ? `${label} · ${preset.model}` : label;
    const desc = tModelDesc(preset);
    if (desc) option.title = desc;
    if (preset.id === data.activePresetId) option.selected = true;
    select.appendChild(option);
  }

  renderApiGateway(data.apiGateway);
  renderCustomList(data.presets, data.activePresetId);
  renderCatalog(data.catalog);
}

async function saveApiGateway(mode) {
  if (isBusy()) {
    showToast(t("toast.modelBusy"), "error");
    return;
  }

  const payload = {
    mode,
    baseUrl: $("modelApiBaseUrl")?.value?.trim() || "",
    protocol: normalizeProtocolValue($("modelApiProtocol")?.value),
    apiKey: $("modelApiKey")?.value?.trim() || "",
  };
  const result = await window.assistantClient.setModelApiGateway(payload);
  if (!result.ok) {
    showToast(apiErrorMessage(result.error), "error");
    await refreshModelSelect();
    return;
  }

  if ($("modelApiKey")) $("modelApiKey").value = "";
  showToast(
    mode === "custom" ? t("toast.modelApiSaved") : t("toast.modelApiReset"),
    "success",
  );
  await refreshModelSelect();
}

export async function initModelSettings() {
  await refreshModelSelect();

  $("modelPresetSelect")?.addEventListener("change", async () => {
    if (isBusy()) {
      showToast(t("toast.modelBusy"), "error");
      await refreshModelSelect();
      return;
    }
    const presetId = $("modelPresetSelect").value;
    const result = await window.assistantClient.setActiveModel(presetId);
    if (!result.ok) {
      showToast(t("toast.modelSwitchFailed"), "error");
      await refreshModelSelect();
      return;
    }
    const active = (result.presets || []).find((p) => p.id === result.activePresetId);
    showToast(t("toast.modelSwitched", { label: tModel(active) || t("settings.model") }), "success");
    await refreshModelSelect();
  });

  $("modelApiSaveBtn")?.addEventListener("click", () => saveApiGateway("custom"));
  $("modelApiResetBtn")?.addEventListener("click", () => saveApiGateway("builtin"));

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
    showToast(t("toast.modelCustomSaved"), "success");
    await refreshModelSelect();
    if (result.preset?.id) {
      const switchResult = await window.assistantClient.setActiveModel(result.preset.id);
      if (switchResult.ok) {
        await refreshModelSelect();
        showToast(t("toast.modelSwitched", { label: tModel(result.preset) || result.preset.label }), "success");
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
    const result = await window.assistantClient.saveCustomModel({
      label: $("modelCustomLabel")?.value?.trim() || "",
      model: $("modelCustomId")?.value?.trim() || "",
      baseUrl: $("modelCustomBaseUrl")?.value?.trim() || "",
      protocol: normalizeProtocolValue($("modelCustomProtocol")?.value),
      apiKey: $("modelCustomApiKey")?.value?.trim() || "",
      tlsSkipVerify: Boolean($("modelCustomTlsSkipVerify")?.checked),
    });
    if (!result.ok) {
      showToast(apiErrorMessage(result.error), "error");
      return;
    }

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

    showToast(t("toast.modelCustomSaved"), "success");
    await refreshModelSelect();

    if (result.preset?.id) {
      const switchResult = await window.assistantClient.setActiveModel(result.preset.id);
      if (switchResult.ok) {
        await refreshModelSelect();
        showToast(
          t("toast.modelSwitched", { label: tModel(result.preset) || result.preset.label }),
          "success",
        );
      }
    }
  });
}
