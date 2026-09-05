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
import { onMobilePairingPageShown, onMobilePairingPageHidden } from "./mobile-pairing-settings.js";
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
import { initSupportDiagnosticsSettings } from "./support-diagnostics-settings.js";
import { initThemeSettings, refreshThemeSelect } from "./theme-settings.js";
import { initMemorySettings, refreshMemorySettings } from "./memory-settings.js";
import { initAccountSettings, refreshAccountSettings, applyAccountLoginPolicy } from "./account-settings.js";
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
  "mobile",
  "account",
  "help",
  "usage",
  "license",
  "feedback",
  "diagnostics",
  "contact",
  "about",
];
const SETTINGS_SUBNAV_GROUPS = {
  account: ["account", "usage", "license"],
  usage: ["account", "usage", "license"],
  license: ["account", "usage", "license"],
  feedback: ["feedback", "diagnostics", "contact", "about"],
  diagnostics: ["feedback", "diagnostics", "contact", "about"],
  contact: ["feedback", "diagnostics", "contact", "about"],
  about: ["feedback", "diagnostics", "contact", "about"],
};
const SETTINGS_NAV_PARENT = {
  usage: "account",
  license: "account",
  feedback: "help",
  diagnostics: "help",
  contact: "help",
  about: "help",
};

let panelOpen = false;
let activeSettingsPage = "general";
let refreshInFlight = null;
let appPolicy = { region: "china", features: { account: true, billing: true, accountLogin: true, purchase: true, usage: true } };
let appPolicyRefreshSeq = 0;

export function accountFeatureEnabled() {
  const features = appPolicy?.features || {};
  return features.enterpriseAccountLogin === true || (features.account !== false && features.accountLogin !== false);
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
  applyAccountLoginPolicy(appPolicy);
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

  // The mobile-pairing page polls for pending requests only while it is open.
  if (pageId === "mobile") onMobilePairingPageShown();
  else onMobilePairingPageHidden();
}

// Element that opened the panel — focus returns here on close (keyboard a11y).
let settingsOpener = null;

function focusableIn(container) {
  if (!container) return [];
  return [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((elm) => elm.getClientRects().length > 0);
}

function setPanelOpen(open) {
  panelOpen = open;
  const panel = $("settingsPanel");
  if (panel) {
    panel.hidden = !open;
    if (open) panel.setAttribute("aria-modal", "true");
  }
  document.body.classList.toggle("settings-open", open);
  if (open) {
    settingsOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    switchSettingsPage(activeSettingsPage);
    // Initial focus lands in the dialog (the close button is always present and
    // unambiguous), so Tab is trapped inside rather than walking the chat behind.
    ($("settingsCloseBtn") || focusableIn(panel)[0])?.focus();
  } else if (settingsOpener) {
    settingsOpener.focus();
    settingsOpener = null;
  }
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
      return refreshSettingsPanelData();
    })
    .catch(() => {
      refreshSettingsPanelData();
    });
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
    refreshAppPolicy()
      .then(() => {
        if (panelOpen) switchSettingsPage(activeSettingsPage);
        return refreshSettingsPanelData();
      })
      .catch(() => {
        refreshSettingsPanelData();
      });
  });

  closeBtn?.addEventListener("click", () => setPanelOpen(false));
  backdrop?.addEventListener("click", () => setPanelOpen(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panelOpen) setPanelOpen(false);
  });

  // Focus trap: keep Tab / Shift+Tab cycling within the open dialog instead of
  // leaking into the chat behind it.
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !panelOpen) return;
    const items = focusableIn(panel);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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
  initSupportDiagnosticsSettings();
  initThemeSettings();
  initMemorySettings();
  initConnectorSettings();
  initRuntimePackSettings();
}
