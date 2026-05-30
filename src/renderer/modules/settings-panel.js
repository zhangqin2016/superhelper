/**
 * Settings panel — model presets and app maintenance (opened from left sidebar).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t, tPermission } from "../i18n/index.js";
import { refreshModelSelect } from "./model-settings.js";
import { refreshPermissionSelect } from "./permission-settings.js";
import { refreshSearchSettings } from "./search-settings.js";
import { refreshSkillsList } from "./skill-settings.js";
import store from "./state.js";

const SETTINGS_PAGES = ["general", "model", "permission", "search", "skills", "about"];

let panelOpen = false;
let activeSettingsPage = "general";

function switchSettingsPage(pageId) {
  if (!SETTINGS_PAGES.includes(pageId)) return;
  activeSettingsPage = pageId;

  document.querySelectorAll(".settings-nav-item").forEach((btn) => {
    const isActive = btn.dataset.settingsPage === pageId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-current", isActive ? "page" : "false");
  });

  document.querySelectorAll(".settings-page").forEach((page) => {
    const isActive = page.dataset.settingsPage === pageId;
    page.classList.toggle("is-active", isActive);
    page.hidden = !isActive;
  });
}

function setPanelOpen(open) {
  panelOpen = open;
  const panel = $("settingsPanel");
  if (panel) panel.hidden = !open;
  document.body.classList.toggle("settings-open", open);
  if (open) switchSettingsPage(activeSettingsPage);
}

export async function initSettingsPanel() {
  const openBtn = $("settingsBtn");
  const panel = $("settingsPanel");
  const closeBtn = $("settingsCloseBtn");
  const backdrop = $("settingsBackdrop");

  if (!openBtn || !panel) return;

  document.querySelectorAll(".settings-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchSettingsPage(btn.dataset.settingsPage || "general");
    });
  });

  switchSettingsPage(activeSettingsPage);

  openBtn.addEventListener("click", async () => {
    const { refreshLocaleSelect } = await import("./locale-settings.js");
    await refreshLocaleSelect();
    await refreshModelSelect();
    await refreshPermissionSelect();
    await refreshSearchSettings();
    await refreshSkillsList();
    setPanelOpen(true);
  });

  closeBtn?.addEventListener("click", () => setPanelOpen(false));
  backdrop?.addEventListener("click", () => setPanelOpen(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panelOpen) setPanelOpen(false);
  });

  $("permissionModeSelect")?.addEventListener("change", async () => {
    if ((store.get("runningSessionIds") || []).length > 0) {
      showToast(t("toast.permissionBusySession"), "error");
      await refreshPermissionSelect();
      return;
    }
    const modeId = $("permissionModeSelect").value;
    const result = await window.assistantClient.setActivePermission(modeId);
    if (!result.ok) {
      const msg =
        result.error === "BUSY"
          ? t("toast.permissionBusy")
          : t("toast.permissionSwitchFailed");
      showToast(msg, "error");
      await refreshPermissionSelect();
      return;
    }
    const active = (result.modes || []).find((m) => m.id === result.activeModeId);
    showToast(t("toast.permissionSwitched", { label: tPermission(active) || "" }), "success");
  });

  $("settingsClearCache")?.addEventListener("click", async () => {
    const result = await window.assistantClient.clearStagingCache();
    showToast(result?.ok ? t("toast.cacheCleared") : t("toast.cacheClearFailed"), result?.ok ? "success" : "error");
  });
}
