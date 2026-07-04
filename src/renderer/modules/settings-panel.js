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

const SETTINGS_PAGES = [
  "general",
  "model",
  "permission",
  "search",
  "media",
  "connectors",
  "skills",
  "apps",
  "runtime",
  "memory",
  "account",
  "help",
  "usage",
  "license",
  "feedback",
  "contact",
  "about",
];
const SETTINGS_SUBNAV_GROUPS = {
  account: ["account", "usage", "license"],
  usage: ["account", "usage", "license"],
  license: ["account", "usage", "license"],
  feedback: ["feedback", "contact", "about"],
  contact: ["feedback", "contact", "about"],
  about: ["feedback", "contact", "about"],
};
const SETTINGS_NAV_PARENT = {
  usage: "account",
  license: "account",
  feedback: "help",
  contact: "help",
  about: "help",
};

let panelOpen = false;
let activeSettingsPage = "general";
let refreshInFlight = null;
let appPolicy = { region: "china", features: { account: true, billing: true, accountLogin: true, purchase: true, usage: true } };
let appPolicyRefreshSeq = 0;

function accountFeatureEnabled() {
  const features = appPolicy?.features || {};
  return features.account !== false && features.accountLogin !== false;
}

function usageFeatureEnabled() {
  const features = appPolicy?.features || {};
  return features.usage !== false;
}

function normalizeSettingsPage(pageId) {
  if (pageId === "help") return "about";
  if (!accountFeatureEnabled() && pageId === "account") return usageFeatureEnabled() ? "usage" : "license";
  if (!usageFeatureEnabled() && pageId === "usage") return accountFeatureEnabled() ? "account" : "license";
  return pageId;
}

export function applyAppPolicyToSettings(policy = {}) {
  appPolicy = {
    region: policy.region || policy.id || "china",
    features: {
      account: true,
      billing: true,
      accountLogin: true,
      purchase: true,
      usage: true,
      ...(policy.features || {}),
    },
  };
  const accountEnabled = accountFeatureEnabled();
  const usageEnabled = usageFeatureEnabled();
  const accountNav = document.querySelector('.settings-nav-item[data-settings-page="account"], .settings-nav-item[data-edition-account-nav="true"]');
  if (accountNav) {
    if (!accountNav.dataset.originalSettingsPage) {
      accountNav.dataset.originalSettingsPage = accountNav.dataset.settingsPage || "account";
      accountNav.dataset.originalI18n = accountNav.dataset.i18n || "";
    }
    accountNav.dataset.editionAccountNav = "true";
    if (accountEnabled) {
      accountNav.dataset.settingsPage = accountNav.dataset.originalSettingsPage || "account";
      if (accountNav.dataset.originalI18n) accountNav.dataset.i18n = accountNav.dataset.originalI18n;
      accountNav.hidden = false;
      accountNav.textContent = t("settings.nav.account");
    } else if (usageEnabled) {
      accountNav.dataset.settingsPage = "usage";
      delete accountNav.dataset.i18n;
      accountNav.hidden = false;
      accountNav.textContent = t("settings.nav.usage");
    } else {
      accountNav.dataset.settingsPage = "license";
      delete accountNav.dataset.i18n;
      accountNav.hidden = false;
      accountNav.textContent = t("settings.nav.license");
    }
  }
  document.querySelectorAll('[data-settings-link="account"]').forEach((btn) => {
    btn.hidden = !accountEnabled;
  });
  document.querySelectorAll('[data-settings-link="usage"]').forEach((btn) => {
    btn.hidden = !usageEnabled;
  });
  const accountPage = $("settingsPageAccount");
  if (accountPage && !accountEnabled) {
    accountPage.hidden = true;
    accountPage.classList.remove("is-active");
  }
  const usagePage = $("settingsPageUsage");
  if (usagePage && !usageEnabled) {
    usagePage.hidden = true;
    usagePage.classList.remove("is-active");
  }
  document.querySelectorAll(".account-usage-balance").forEach((section) => {
    section.hidden = !accountEnabled;
  });
  if (!accountEnabled && activeSettingsPage === "account") {
    activeSettingsPage = usageEnabled ? "usage" : "license";
  }
  if (!usageEnabled && activeSettingsPage === "usage") {
    activeSettingsPage = accountEnabled ? "account" : "license";
  }
}

export const applyEditionToSettings = applyAppPolicyToSettings;

async function refreshAppPolicy() {
  const seq = ++appPolicyRefreshSeq;
  const applyLatestPolicy = (policy) => {
    if (seq !== appPolicyRefreshSeq) return false;
    applyAppPolicyToSettings(policy || {});
    return true;
  };
  try {
    const getPolicy = window.assistantClient?.getAppPolicy;
    const policy = typeof getPolicy === "function" ? await getPolicy().catch(() => null) : null;
    if (policy?.ok !== false) {
      applyLatestPolicy(policy || {});
      return;
    }
  } catch {
    /* fall back to packaged edition */
  }
  try {
    const edition = await window.assistantClient?.getAppEdition?.();
    if (edition?.ok !== false) {
      applyLatestPolicy(edition || {});
      return;
    }
  } catch {
    /* fall back below */
  }
  applyLatestPolicy({});
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
  pageId = normalizeSettingsPage(pageId);
  if (!SETTINGS_PAGES.includes(pageId)) return;
  activeSettingsPage = pageId;

  document.querySelectorAll(".settings-nav-item").forEach((btn) => {
    const parent = accountFeatureEnabled()
      ? SETTINGS_NAV_PARENT[pageId]
      : { ...SETTINGS_NAV_PARENT, usage: "usage", license: usageFeatureEnabled() ? "usage" : "license" }[pageId];
    const isActive = btn.dataset.settingsPage === (parent || pageId);
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-current", isActive ? "page" : "false");
  });

  document.querySelectorAll(".settings-page").forEach((page) => {
    const isActive = page.dataset.settingsPage === pageId;
    page.classList.toggle("is-active", isActive);
    page.hidden = !isActive;
  });

  document.querySelectorAll("[data-settings-link]").forEach((btn) => {
    const target = btn.dataset.settingsLink || "";
    const active = target === pageId;
    const related = SETTINGS_SUBNAV_GROUPS[pageId]?.includes(target);
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.tabIndex = related ? 0 : -1;
  });
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
  pageId = normalizeSettingsPage(pageId);
  if (pageId && SETTINGS_PAGES.includes(pageId)) {
    activeSettingsPage = pageId;
  }
  setPanelOpen(true);
  refreshAppPolicy()
    .then(() => {
      if (panelOpen) switchSettingsPage(activeSettingsPage);
    })
    .catch(() => {});
  refreshSettingsPanelData();
}

function refreshSettingsPanelData() {
  if (refreshInFlight) return refreshInFlight;
  const refreshers = [
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
    refreshMemorySettings(),
  ];
  if (usageFeatureEnabled()) refreshers.push(refreshUsageSettings());
  if (accountFeatureEnabled()) refreshers.push(refreshAccountSettings());
  refreshInFlight = Promise.allSettled(refreshers)
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
  await refreshAppPolicy();
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
  document.querySelectorAll("[data-settings-link]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchSettingsPage(btn.dataset.settingsLink || "general");
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
  if (accountFeatureEnabled()) initAccountSettings();
  initSupportSettings();
  initThemeSettings();
  initMemorySettings();
  initConnectorSettings();
  initRuntimePackSettings();
}
