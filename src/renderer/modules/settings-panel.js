/**
 * Settings panel — model presets and app maintenance (opened from left sidebar).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t, tPermission } from "../i18n/index.js";
import { refreshLocaleSelect } from "./locale-settings.js";
import { refreshModelSelect } from "./model-settings.js";
import { refreshPermissionSelect, refreshSessionPermissionSelect } from "./permission-settings.js";
import { refreshSearchSettings } from "./search-settings.js";
import { refreshMediaProviderSettings } from "./media-provider-settings.js";
import { refreshSkillsList } from "./skill-settings.js";
import { refreshConnectorSettings, initConnectorSettings } from "./connector-settings.js";
import { refreshWorkspaceApps } from "./workspace-apps.js";
import { initRuntimePackSettings, refreshRuntimePackSettings } from "./runtime-pack-settings.js";
import { refreshLicenseStatus, refreshUpdateSettings } from "./license-update-settings.js";
import { anySessionRunning } from "./session-runtime-store.js";
import { activeSession, refreshStateLight } from "./session-chrome.js";
import { confirmDialog } from "./confirm-dialog.js";
import { refreshUsageSettings, initUsageSettings } from "./usage-settings.js";
import { initSupportSettings } from "./support-settings.js";
import { initThemeSettings, refreshThemeSelect } from "./theme-settings.js";
import { initMemorySettings, refreshMemorySettings } from "./memory-settings.js";
import { initAccountSettings, refreshAccountSettings } from "./account-settings.js";
import { getNotificationPrefs, setNotificationPrefs } from "./task-alert.js";

// "account" merges usage + license; "help" merges feedback + contact + about.
// Multiple <section>s can share one page id — switchSettingsPage shows them all.
const SETTINGS_PAGES = ["general", "model", "permission", "search", "media", "connectors", "skills", "apps", "runtime", "memory", "account", "help"];
const SETTINGS_SEGMENT_DEFAULTS = {
  account: "overview",
  help: "feedback",
};

let panelOpen = false;
let activeSettingsPage = "general";
const activeSettingsSegments = { ...SETTINGS_SEGMENT_DEFAULTS };
let refreshInFlight = null;

function parseSettingsSegment(value = "") {
  const [group, segment] = String(value).split(":");
  return { group, segment };
}

function setSettingsSegment(group, segment) {
  if (!group || !segment) return;
  activeSettingsSegments[group] = segment;

  document.querySelectorAll("[data-settings-segment-tab]").forEach((button) => {
    const parsed = parseSettingsSegment(button.dataset.settingsSegmentTab);
    if (parsed.group !== group) return;
    const isActive = parsed.segment === segment;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  document.querySelectorAll("[data-settings-segment-panel]").forEach((panel) => {
    const parsed = parseSettingsSegment(panel.dataset.settingsSegmentPanel);
    if (parsed.group !== group) return;
    const isActive = parsed.segment === segment;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  });
}

function syncSettingsSegments() {
  for (const [group, fallback] of Object.entries(SETTINGS_SEGMENT_DEFAULTS)) {
    setSettingsSegment(group, activeSettingsSegments[group] || fallback);
  }
}

async function confirmBypassPermission() {
  return confirmDialog({
    title: t("permission.bypassConfirmTitle"),
    message: t("permission.bypassConfirmMessage"),
    confirmText: t("permission.bypassConfirm"),
    cancelText: t("prompt.cancel"),
    danger: true,
  });
}

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
  syncSettingsSegments();
}

function setPanelOpen(open) {
  panelOpen = open;
  const panel = $("settingsPanel");
  if (panel) panel.hidden = !open;
  document.body.classList.toggle("settings-open", open);
  if (open) switchSettingsPage(activeSettingsPage);
}

/** @param {string} [pageId] */
export function openSettingsPage(pageId = "general") {
  if (pageId && SETTINGS_PAGES.includes(pageId)) {
    activeSettingsPage = pageId;
  }
  setPanelOpen(true);
  refreshSettingsPanelData();
}

function refreshSettingsPanelData() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = Promise.allSettled([
    refreshLocaleSelect(),
    refreshThemeSelect(),
    refreshModelSelect(),
    refreshPermissionSelect(),
    refreshSearchSettings(),
    refreshMediaProviderSettings(),
    refreshConnectorSettings(),
    refreshSkillsList(),
    refreshWorkspaceApps(),
    refreshRuntimePackSettings(),
    refreshLicenseStatus(),
    refreshUpdateSettings(),
    refreshUsageSettings(),
    refreshAccountSettings(),
    refreshMemorySettings(),
  ])
    .then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.warn("[settings] refresh failed:", result.reason?.message || result.reason);
        }
      }
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
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
  document.querySelectorAll("[data-settings-segment-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { group, segment } = parseSettingsSegment(btn.dataset.settingsSegmentTab);
      setSettingsSegment(group, segment);
    });
  });

  switchSettingsPage(activeSettingsPage);

  openBtn.addEventListener("click", () => {
    setPanelOpen(true);
    refreshSettingsPanelData();
  });

  closeBtn?.addEventListener("click", () => setPanelOpen(false));
  backdrop?.addEventListener("click", () => setPanelOpen(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panelOpen) setPanelOpen(false);
  });

  $("permissionModeSelect")?.addEventListener("change", async () => {
    if (anySessionRunning()) {
      showToast(t("toast.permissionBusySession"), "error");
      await refreshPermissionSelect();
      return;
    }
    const modeId = $("permissionModeSelect").value;
    if (modeId === "full" && !(await confirmBypassPermission())) {
      await refreshPermissionSelect();
      return;
    }
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
    await refreshSessionPermissionSelect();
  });

  $("sessionPermissionModeSelect")?.addEventListener("change", async () => {
    const sessionId = activeSession()?.id;
    if (!sessionId) {
      await refreshSessionPermissionSelect();
      return;
    }
    const modeId = $("sessionPermissionModeSelect").value || "inherit";
    if (modeId === "full" && !(await confirmBypassPermission())) {
      await refreshSessionPermissionSelect();
      return;
    }
    const result = await window.assistantClient.setSessionPermission(sessionId, modeId);
    if (!result.ok) {
      const msg =
        result.error === "BUSY"
          ? t("toast.permissionBusy")
          : t("toast.permissionSwitchFailed");
      showToast(msg, "error");
      await refreshSessionPermissionSelect();
      return;
    }
    const active = (result.modes || []).find((m) => m.id === result.effectiveModeId);
    showToast(t("toast.sessionPermissionSwitched", { label: tPermission(active) || "" }), "success");
    await refreshStateLight();
    await refreshSessionPermissionSelect();
  });

  $("settingsClearCache")?.addEventListener("click", async () => {
    const result = await window.assistantClient.clearStagingCache();
    showToast(result?.ok ? t("toast.cacheCleared") : t("toast.cacheClearFailed"), result?.ok ? "success" : "error");
  });

  // Task-completion alerts (notification preferences) live on the General page,
  // not Model. Wire the two toggles here next to the other general controls.
  {
    const prefs = getNotificationPrefs();
    for (const [key, id] of [["sound", "completionSoundToggle"], ["notify", "completionNotifyToggle"]]) {
      const box = $(id);
      if (!box) continue;
      box.checked = prefs[key] !== false;
      box.addEventListener("change", () => void setNotificationPrefs({ [key]: box.checked }));
    }
  }

  initUsageSettings();
  initAccountSettings();
  initSupportSettings();
  initThemeSettings();
  initMemorySettings();
  initConnectorSettings();
  initRuntimePackSettings();
}
