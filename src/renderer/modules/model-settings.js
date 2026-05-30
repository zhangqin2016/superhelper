/**
 * Model preset options — rendered inside the settings panel.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import store from "./state.js";
import { t, tModel, tModelDesc } from "../i18n/index.js";

function isBusy() {
  return (store.get("runningSessionIds") || []).length > 0;
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

function formatPresetTiers(preset) {
  const main = preset.model || "";
  const haiku = preset.modelHaiku || main;
  const sonnet = preset.modelSonnet || main;
  const opus = preset.modelOpus || main;
  if (haiku === sonnet && sonnet === opus && opus === main) return "";
  return t("settings.modelTierSummary", { haiku, sonnet, opus });
}

function updateApiCustomFields(mode, gateway) {
  const panel = $("modelApiCustomFields");
  const hint = $("modelApiKeyHint");
  if (panel) panel.hidden = mode !== "custom";
  if (hint) {
    if (mode === "custom" && gateway?.apiKeySet && gateway?.apiKeyHint) {
      hint.hidden = false;
      hint.textContent = t("settings.modelApiKeyHint", { hint: gateway.apiKeyHint });
    } else {
      hint.hidden = true;
      hint.textContent = "";
    }
  }
}

function renderApiGateway(gateway) {
  const modeSelect = $("modelApiModeSelect");
  const baseUrlInput = $("modelApiBaseUrl");
  const keyInput = $("modelApiKey");
  if (!modeSelect || !gateway) return;

  const mode = gateway.mode === "custom" ? "custom" : "builtin";
  modeSelect.value = mode;

  if (baseUrlInput) {
    baseUrlInput.value = gateway.baseUrl || "";
    if (!baseUrlInput.value && gateway.defaultBaseUrl) {
      baseUrlInput.placeholder = gateway.defaultBaseUrl;
    }
  }
  if (keyInput) keyInput.value = "";

  updateApiCustomFields(mode, gateway);
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

    const tierText = formatPresetTiers(preset);
    if (tierText) {
      const tiers = document.createElement("span");
      tiers.className = "model-custom-tiers";
      tiers.textContent = tierText;
      meta.appendChild(tiers);
    }

    if (preset.baseUrl || preset.apiKeySet) {
      const api = document.createElement("span");
      api.className = "model-custom-api";
      if (preset.baseUrl) {
        api.textContent = preset.baseUrl;
      } else if (preset.apiKeySet) {
        api.textContent = t("settings.modelCustomOwnKey");
      }
      meta.appendChild(api);
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
}

async function saveApiGateway(mode) {
  if (isBusy()) {
    showToast(t("toast.modelBusy"), "error");
    return;
  }

  const payload = {
    mode,
    baseUrl: $("modelApiBaseUrl")?.value?.trim() || "",
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

  $("modelApiModeSelect")?.addEventListener("change", () => {
    const mode = $("modelApiModeSelect")?.value || "builtin";
    updateApiCustomFields(mode, {
      apiKeySet: Boolean($("modelApiKeyHint")?.textContent),
      apiKeyHint: "",
    });
  });

  $("modelApiSaveBtn")?.addEventListener("click", () => saveApiGateway("custom"));
  $("modelApiResetBtn")?.addEventListener("click", () => saveApiGateway("builtin"));

  $("modelCustomAddBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.modelBusy"), "error");
      return;
    }
    const result = await window.assistantClient.saveCustomModel({
      label: $("modelCustomLabel")?.value?.trim() || "",
      model: $("modelCustomId")?.value?.trim() || "",
      modelHaiku: $("modelCustomHaiku")?.value?.trim() || "",
      modelSonnet: $("modelCustomSonnet")?.value?.trim() || "",
      modelOpus: $("modelCustomOpus")?.value?.trim() || "",
      baseUrl: $("modelCustomBaseUrl")?.value?.trim() || "",
      apiKey: $("modelCustomApiKey")?.value?.trim() || "",
    });
    if (!result.ok) {
      showToast(apiErrorMessage(result.error), "error");
      return;
    }

    for (const id of [
      "modelCustomLabel",
      "modelCustomId",
      "modelCustomHaiku",
      "modelCustomSonnet",
      "modelCustomOpus",
      "modelCustomBaseUrl",
      "modelCustomApiKey",
    ]) {
      const el = $(id);
      if (el) el.value = "";
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
