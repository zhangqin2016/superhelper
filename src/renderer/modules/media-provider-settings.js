/**
 * Image/video generation provider settings. Per modality the user picks a source
 * — "Workbench-provided" (only providers the Workbench enabled) or "Use my key"
 * (BYOK; key stored locally and entered inline). A "currently using" line shows
 * the resolved choice. No separate keys list — keys are edited where they're used.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";
import { anySessionRunning } from "./session-runtime-store.js";

// Credential field names are brand-technical — shown verbatim.
const FIELD_LABELS = { apiKey: "API Key", accessKey: "AccessKey", secretKey: "SecretKey", groupId: "GroupId" };

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

function providerSpec(id) {
  return data?.providers?.find((p) => p.id === id) || null;
}
function providerLabel(id) {
  return providerSpec(id)?.label || id;
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

// Human-readable "what will actually be used" — honest about not-yet-usable BYOK.
function currentEffective(choice) {
  if (choice.source === "own") {
    if (!choice.provider) return "—";
    const suffix = data.keysPresent[choice.provider] ? t("settings.mediaOwnSuffix") : t("settings.mediaOwnPending");
    return providerLabel(choice.provider) + suffix;
  }
  return choice.provider ? providerLabel(choice.provider) : t("settings.mediaAuto");
}

// Inline BYOK key editor for the selected own-provider (shared key store). The
// provider name is already shown in the select above, so it isn't repeated here.
function keyEditor(provider, modality) {
  const spec = providerSpec(provider);
  if (!spec) return null;
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
  // Optional per-modality model-id override (prefilled — not a secret). Lets a
  // single-key user target a model their account actually has enabled.
  const modelField = modality === "image" ? "imageModel" : "videoModel";
  const modelGroup = el("div", "media-field");
  modelGroup.appendChild(el("span", "settings-field-label", t(modality === "image" ? "settings.mediaModelImage" : "settings.mediaModelVideo")));
  const modelInput = el("input", "settings-input");
  modelInput.type = "text";
  modelInput.value = data.modelIds?.[provider]?.[modelField] || "";
  modelInput.placeholder = t("settings.mediaModelPlaceholder");
  modelGroup.appendChild(modelInput);
  wrap.appendChild(modelGroup);
  wrap.appendChild(el("p", "media-hint", t("settings.mediaModelHint")));

  wrap.appendChild(el("p", "media-hint", t("settings.mediaKeyDesc")));
  const save = el("button", "settings-action-btn media-save-btn", t("settings.mediaSave"));
  save.type = "button";
  save.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.mediaBusy"), "error");
      return;
    }
    const values = { [modelField]: modelInput.value.trim() };
    for (const [field, input] of Object.entries(inputs)) values[field] = input.value.trim();
    if (applyResult(await window.assistantClient.setMediaProviderKey({ provider, values }))) {
      showToast(t("toast.mediaSwitched", { label: spec.label }), "success");
    }
  });
  wrap.appendChild(save);
  return wrap;
}

function modalitySection(modality, title) {
  const choice = data[modality] || { source: "service", provider: "" };
  const section = el("div", "media-card");
  section.appendChild(el("h4", "media-card-title", title));
  section.appendChild(el("p", "media-current", `${t("settings.mediaCurrent")}：${currentEffective(choice)}`));

  // Source toggle.
  const toggle = el("div", "media-toggle");
  for (const src of ["service", "own"]) {
    const btn = el("button", "media-toggle-btn" + (choice.source === src ? " is-active" : ""),
      t(src === "service" ? "settings.mediaUseOurs" : "settings.mediaUseOwn"));
    btn.type = "button";
    btn.addEventListener("click", () => {
      const list = src === "service" ? data.serviceProviders : data.providers.map((p) => p.id);
      const keep = list.includes(choice.provider) ? choice.provider : "";
      setChoice(modality, src, keep);
    });
    toggle.appendChild(btn);
  }
  section.appendChild(toggle);

  if (choice.source === "service") {
    if (data.serviceProviders.length === 0) {
      section.appendChild(el("p", "media-hint media-hint-warn", t("settings.mediaServiceEmpty")));
    } else {
      const select = el("select", "settings-select");
      const auto = new Option(t("settings.mediaAuto"), "");
      if (!choice.provider) auto.selected = true;
      select.add(auto);
      for (const id of data.serviceProviders) {
        const option = new Option(providerLabel(id), id);
        if (id === choice.provider) option.selected = true;
        select.add(option);
      }
      select.addEventListener("change", () => setChoice(modality, "service", select.value));
      section.appendChild(select);
    }
  } else {
    // own: must pick a concrete provider (no "default"); then edit its key inline.
    const select = el("select", "settings-select");
    const placeholder = new Option(t("settings.mediaPickProvider"), "");
    if (!choice.provider) placeholder.selected = true;
    select.add(placeholder);
    for (const p of data.providers) {
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
  root.appendChild(modalitySection("image", t("settings.mediaImage")));
  root.appendChild(modalitySection("video", t("settings.mediaVideo")));
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
