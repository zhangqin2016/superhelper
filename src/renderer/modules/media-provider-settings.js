/**
 * Media generation provider settings. Per modality the user picks Workbench-
 * provided service credentials or their own provider key stored locally.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";
import { anySessionRunning } from "./session-runtime-store.js";

const FIELD_LABELS = { apiKey: "API Key", accessKey: "AccessKey", secretKey: "SecretKey", groupId: "GroupId" };
const MODALITIES = [
  { id: "image", titleKey: "settings.mediaImage", modelField: "imageModel", modelLabelKey: "settings.mediaModelImage" },
  { id: "video", titleKey: "settings.mediaVideo", modelField: "videoModel", modelLabelKey: "settings.mediaModelVideo" },
  { id: "speech", titleKey: "settings.mediaSpeech", modelField: "speechModel", modelLabelKey: "settings.mediaModelSpeech" },
];

let data = null;

function isBusy() {
  return anySessionRunning();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function modalityMeta(modality) {
  return MODALITIES.find((item) => item.id === modality) || MODALITIES[0];
}

function providerSpec(id) {
  return data?.providers?.find((p) => p.id === id) || null;
}

function providerLabel(id) {
  return providerSpec(id)?.label || id;
}

function providerSupports(provider, modality) {
  if (Array.isArray(provider.modalities)) return provider.modalities.includes(modality);
  return modality === "speech" ? provider.id === "dashscope" : true;
}

function providersForModality(modality) {
  return (data?.providers || []).filter((provider) => providerSupports(provider, modality));
}

function ownProvidersForModality(modality) {
  return providersForModality(modality).filter((provider) => provider.byok !== false);
}

function serviceProvidersFor(modality) {
  const byModality = data?.serviceProvidersByModality?.[modality];
  if (Array.isArray(byModality)) return byModality;
  return (data?.serviceProviders || []).filter((id) => providersForModality(modality).some((p) => p.id === id));
}

function applyResult(result) {
  if (!result?.ok) {
    showToast(t("toast.mediaSwitchFailed"), "error");
    return false;
  }
  data = result;
  render();
  return true;
}

async function setChoice(modality, source, provider) {
  if (isBusy()) {
    showToast(t("toast.mediaBusy"), "error");
    return;
  }
  applyResult(await window.assistantClient.setMediaChoice({ modality, source, provider }));
}

function currentEffective(choice) {
  if (choice.source === "own") {
    if (!choice.provider) return "-";
    const suffix = data.keysPresent[choice.provider] ? t("settings.mediaOwnSuffix") : t("settings.mediaOwnPending");
    return providerLabel(choice.provider) + suffix;
  }
  return choice.provider ? providerLabel(choice.provider) : t("settings.mediaAuto");
}

function keyEditor(provider, modality) {
  const spec = providerSpec(provider);
  if (!spec) return null;
  const meta = modalityMeta(modality);
  const wrap = el("div", "media-key-editor");

  if (data.keysPresent[provider]) {
    wrap.appendChild(el("div", "media-key-status is-on", t("settings.mediaKeyOn")));
  }
  if (provider === "volcengine") {
    wrap.appendChild(el("p", "media-hint", t("settings.mediaVolcHint")));
  }

  const inputs = {};
  for (const field of spec.fields) {
    const group = el("div", "media-field");
    group.appendChild(el("span", "settings-field-label", FIELD_LABELS[field] || field));
    const input = el("input", "settings-input");
    input.type = field === "groupId" ? "text" : "password";
    input.autocomplete = "off";
    inputs[field] = input;
    group.appendChild(input);
    wrap.appendChild(group);
  }

  const modelGroup = el("div", "media-field");
  modelGroup.appendChild(el("span", "settings-field-label", t(meta.modelLabelKey)));
  const modelInput = el("input", "settings-input");
  modelInput.type = "text";
  modelInput.value = data.modelIds?.[provider]?.[meta.modelField] || "";
  modelInput.placeholder = t("settings.mediaModelPlaceholder");
  modelGroup.appendChild(modelInput);
  wrap.appendChild(modelGroup);
  wrap.appendChild(el("p", "media-hint", t("settings.mediaModelHint")));
  wrap.appendChild(el("p", "media-hint", t("settings.mediaKeyDesc")));

  const actions = el("div", "settings-actions settings-form-actions media-key-actions");
  const save = el("button", "settings-action-btn settings-action-btn--primary media-save-btn", t("settings.mediaSave"));
  save.type = "button";
  save.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.mediaBusy"), "error");
      return;
    }
    const values = { [meta.modelField]: modelInput.value.trim() };
    for (const [field, input] of Object.entries(inputs)) values[field] = input.value.trim();
    if (applyResult(await window.assistantClient.setMediaProviderKey({ provider, values }))) {
      showToast(t("toast.mediaSwitched", { label: spec.label }), "success");
    }
  });
  actions.appendChild(save);
  wrap.appendChild(actions);
  return wrap;
}

function modalitySection(modality) {
  const meta = modalityMeta(modality);
  const choice = data[modality] || { source: "service", provider: "" };
  const serviceProviders = serviceProvidersFor(modality);
  const ownProviders = ownProvidersForModality(modality);
  const section = el("div", "media-card");
  section.appendChild(el("h4", "media-card-title", t(meta.titleKey)));
  section.appendChild(el("p", "media-current", `${t("settings.mediaCurrent")}: ${currentEffective(choice)}`));

  const toggle = el("div", "media-toggle");
  for (const src of ["service", "own"]) {
    const btn = el("button", "media-toggle-btn" + (choice.source === src ? " is-active" : ""),
      t(src === "service" ? "settings.mediaUseOurs" : "settings.mediaUseOwn"));
    btn.type = "button";
    btn.addEventListener("click", () => {
      const list = src === "service" ? serviceProviders : ownProviders.map((p) => p.id);
      const keep = list.includes(choice.provider) ? choice.provider : "";
      setChoice(modality, src, keep);
    });
    toggle.appendChild(btn);
  }
  section.appendChild(toggle);

  if (choice.source === "service") {
    if (serviceProviders.length === 0) {
      section.appendChild(el("p", "media-hint media-hint-warn", t("settings.mediaServiceEmpty")));
    } else {
      const select = el("select", "settings-select");
      const auto = new Option(t("settings.mediaAuto"), "");
      if (!choice.provider) auto.selected = true;
      select.add(auto);
      for (const id of serviceProviders) {
        const option = new Option(providerLabel(id), id);
        if (id === choice.provider) option.selected = true;
        select.add(option);
      }
      select.addEventListener("change", () => setChoice(modality, "service", select.value));
      section.appendChild(select);
    }
  } else {
    const select = el("select", "settings-select");
    const placeholder = new Option(t("settings.mediaPickProvider"), "");
    if (!choice.provider) placeholder.selected = true;
    select.add(placeholder);
    for (const p of ownProviders) {
      const option = new Option(p.label, p.id);
      if (p.id === choice.provider) option.selected = true;
      select.add(option);
    }
    select.addEventListener("change", () => setChoice(modality, "own", select.value));
    section.appendChild(select);
    if (choice.provider) {
      if (!data.keysPresent[choice.provider]) {
        section.appendChild(el("p", "media-hint media-hint-warn", t("settings.mediaKeyMissing")));
      }
      const editor = keyEditor(choice.provider, modality);
      if (editor) section.appendChild(editor);
    }
  }
  return section;
}

function render() {
  const root = $("mediaProviderSettings");
  if (!root || !data) return;
  root.replaceChildren();
  for (const modality of MODALITIES) root.appendChild(modalitySection(modality.id));
}

export async function refreshMediaProviderSettings() {
  if (!$("mediaProviderSettings")) return;
  const result = await window.assistantClient.listMediaProviders();
  if (result?.ok) {
    data = result;
    render();
  }
}

export async function initMediaProviderSettings() {
  await refreshMediaProviderSettings();
}
