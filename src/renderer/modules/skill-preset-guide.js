/**
 * First-run guide for recommended skill starter packs.
 */

import { showToast } from "./toast.js";
import { t, skillErrorMessage } from "../i18n/index.js";
import { openSettingsPage } from "./settings-panel.js";
import { handlePresetApplyResult, refreshSkillsList } from "./skill-settings.js";
import { anySessionRunning } from "./session-runtime-store.js";
import {
  installMissingRuntimePacks,
  loadRuntimePackPreflight,
  runtimePackDisplayText,
} from "./runtime-pack-preflight-ui.js";

let guideOpen = false;

function removeGuide() {
  document.querySelector(".skill-preset-guide-panel")?.remove();
  guideOpen = false;
}

function renderGuideModal() {
  if (guideOpen) return null;

  const overlay = document.createElement("section");
  overlay.className = "modal-panel skill-preset-guide-panel";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "skillPresetGuideTitle");

  overlay.innerHTML = `
    <div class="modal-card skill-preset-guide-card">
      <header class="modal-header">
        <div>
          <h2 id="skillPresetGuideTitle" class="skill-preset-guide-title"></h2>
          <p class="skill-preset-guide-lead"></p>
        </div>
      </header>
      <ul class="skill-preset-guide-list"></ul>
      <div class="skill-preset-guide-dependencies" hidden>
        <div class="skill-preset-guide-dependencies-title"></div>
        <ul class="skill-preset-guide-dependencies-list"></ul>
      </div>
      <p class="skill-preset-guide-footnote"></p>
      <div class="skill-preset-guide-actions">
        <button type="button" class="send-btn skill-preset-guide-apply"></button>
        <button type="button" class="topbar-btn skill-preset-guide-browse"></button>
        <button type="button" class="topbar-btn skill-preset-guide-later"></button>
      </div>
    </div>
  `;

  overlay.querySelector(".skill-preset-guide-title").textContent = t("skills.guide.title");
  overlay.querySelector(".skill-preset-guide-lead").textContent = t("skills.guide.lead");

  const list = overlay.querySelector(".skill-preset-guide-list");
  for (let i = 1; i <= 4; i += 1) {
    const item = document.createElement("li");
    item.textContent = t(`skills.guide.point${i}`);
    list.append(item);
  }

  overlay.querySelector(".skill-preset-guide-footnote").textContent = t("skills.guide.footnote");
  overlay.querySelector(".skill-preset-guide-apply").textContent = t("skills.guide.apply");
  overlay.querySelector(".skill-preset-guide-browse").textContent = t("skills.guide.browse");
  overlay.querySelector(".skill-preset-guide-later").textContent = t("skills.guide.later");

  return overlay;
}

function renderGuideDependencies(overlay, missingPacks = []) {
  const panel = overlay.querySelector(".skill-preset-guide-dependencies");
  const title = overlay.querySelector(".skill-preset-guide-dependencies-title");
  const list = overlay.querySelector(".skill-preset-guide-dependencies-list");
  const applyBtn = overlay.querySelector(".skill-preset-guide-apply");
  if (!panel || !title || !list || !applyBtn) return;

  list.replaceChildren();
  if (!missingPacks.length) {
    panel.hidden = true;
    applyBtn.textContent = t("skills.guide.apply");
    return;
  }

  title.textContent = t("skills.guide.dependenciesTitle");
  for (const pack of missingPacks) {
    const item = document.createElement("li");
    item.textContent = runtimePackDisplayText(pack);
    list.append(item);
  }
  panel.hidden = false;
  applyBtn.textContent = t("skills.guide.applyWithDependencies");
}

async function hydrateGuideDependencies(overlay, presetId) {
  try {
    const preflight = await loadRuntimePackPreflight({ presetId });
    const missingPacks = Array.isArray(preflight?.missingPacks) ? preflight.missingPacks : [];
    renderGuideDependencies(overlay, missingPacks);
    return missingPacks;
  } catch {
    showToast(t("composer.dependencyPreflightFailed"), "warning");
    return [];
  }
}

async function applyGuidePreset(applyBtn, presetId, getMissingPacks) {
  if (anySessionRunning()) {
    showToast(t("toast.sessionSkillsBusy"), "error");
    return false;
  }
  applyBtn.disabled = true;
  const installed = await installMissingRuntimePacks(getMissingPacks());
  if (!installed) {
    applyBtn.disabled = false;
    return false;
  }
  const result = await window.assistantClient.applySkillPreset(presetId);
  applyBtn.disabled = false;
  if (!result.ok) {
    showToast(skillErrorMessage(result.error), "error");
    return false;
  }
  await window.assistantClient.setSkillPresetGuideStatus("applied");
  showToast(t("toast.skillsPresetApplied", { name: t(`skills.preset.${presetId}.title`) }), "success");
  handlePresetApplyResult(result);
  await refreshSkillsList();
  return true;
}

export async function maybeShowSkillPresetGuide() {
  if (guideOpen) return;

  const payload = await window.assistantClient.getSkillPresetGuide();
  if (!payload?.ok || !payload.guide?.shouldShow) return;

  const presetId = payload.guide.guidePresetId || "office-starter";
  const overlay = renderGuideModal();
  if (!overlay) return;

  const applyBtn = overlay.querySelector(".skill-preset-guide-apply");
  const browseBtn = overlay.querySelector(".skill-preset-guide-browse");
  const laterBtn = overlay.querySelector(".skill-preset-guide-later");
  let missingRuntimePacks = [];

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      window.assistantClient.setSkillPresetGuideStatus("deferred");
      removeGuide();
      document.removeEventListener("keydown", onKeyDown);
    }
  };

  applyBtn.addEventListener("click", async () => {
    const ok = await applyGuidePreset(applyBtn, presetId, () => missingRuntimePacks);
    if (!ok) return;
    removeGuide();
    document.removeEventListener("keydown", onKeyDown);
  });

  browseBtn.addEventListener("click", async () => {
    await window.assistantClient.setSkillPresetGuideStatus("dismissed");
    removeGuide();
    document.removeEventListener("keydown", onKeyDown);
    openSettingsPage("skills");
  });

  laterBtn.addEventListener("click", async () => {
    await window.assistantClient.setSkillPresetGuideStatus("deferred");
    removeGuide();
    document.removeEventListener("keydown", onKeyDown);
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      window.assistantClient.setSkillPresetGuideStatus("deferred");
      removeGuide();
      document.removeEventListener("keydown", onKeyDown);
    }
  });

  document.body.appendChild(overlay);
  guideOpen = true;
  applyBtn.disabled = true;
  missingRuntimePacks = await hydrateGuideDependencies(overlay, presetId);
  applyBtn.disabled = false;
  document.addEventListener("keydown", onKeyDown);
  requestAnimationFrame(() => applyBtn.focus());
}
