/**
 * Application entry point — wires all modules together.
 */

import { initI18n, onLocaleChange, t, applyDomI18n } from "./i18n/index.js";
import { initComposer } from "./modules/composer.js";
import { initScheduledTasks } from "./modules/scheduled-tasks.js";
import { initSessionSkills, refreshSessionSkillsUi } from "./modules/session-skills.js";
import { initCharacterSessionControl, refreshCharacterControlUi } from "./modules/character-session-control.js";
import { initCharacterLibrary, refreshCharacterLibraryUi } from "./modules/character-library.js";
import { initFileHandler } from "./modules/file-handler.js";
import { refreshState, updateTopbarTitles } from "./modules/session-chrome.js";
import { wireMessageIpc, initMessageUi, syncComposerForActiveSession } from "./modules/message.js";
import { initMigrationProgress } from "./modules/migration-progress.js";
import { initStartupHealth } from "./modules/startup-health.js";
import { initRuntimePackProgress } from "./modules/runtime-pack-progress.js";
import { initVoiceDictation } from "./modules/voice-dictation.js";
import { renderProjectTree, initAddProject, initTopbarSessionRename } from "./modules/project-tree.js";
import { initSettingsPanel } from "./modules/settings-panel.js";
import { initAccountMenu } from "./modules/account-menu.js";
import { initModelSettings } from "./modules/model-settings.js";
import { initPermissionSettings } from "./modules/permission-settings.js";
import { initSearchSettings } from "./modules/search-settings.js";
import { initMediaProviderSettings } from "./modules/media-provider-settings.js";
import { initMobilePairingSettings } from "./modules/mobile-pairing-settings.js";
import { initSkillSettings, refreshSkillsList } from "./modules/skill-settings.js";
import { initWorkspaceApps, refreshWorkspaceApps } from "./modules/workspace-apps.js";
import { initLocaleSettings, refreshLocaleSelect } from "./modules/locale-settings.js";
import {
  initLicenseUpdateSettings,
  refreshLicenseStatus,
  refreshUpdateSettings,
  startAutoUpdateChecks,
  kickAutoUpdateCheck,
} from "./modules/license-update-settings.js";
import { initDiffPanel } from "./modules/diff-panel.js";
import { initFindBar } from "./modules/find-bar.js";
import { initTaskCenter } from "./modules/task-center.js";
import { showActionToast, showToast } from "./modules/toast.js";
import { initCustomSelects, syncCustomSelects } from "./modules/custom-select.js";
import { $ } from "./modules/dom.js";
import store from "./modules/state.js";
import { initWorkspaceOrder } from "./modules/workspace-order.js";
import { initWorkspaceSwitcher } from "./modules/workspace-switcher.js";

function initPanelToggles() {
  const shell = $("appShell");
  if (!shell) return;
  $("leftToggleBtn")?.addEventListener("click", () => {
    shell.classList.toggle("left-collapsed");
  });
}

function initResizeHandles() {
  const shell = $("appShell");
  if (!shell) return;
  initResizeHandle("leftResizeHandle", "left-w", "left-collapsed", 180, 450);
}

function initResizeHandle(handleId, varName, collapseClass, minW, maxW) {
  const handle = $(handleId);
  const shell = $("appShell");
  if (!handle || !shell) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  handle.addEventListener("mousedown", (e) => {
    if (shell.classList.contains(collapseClass)) return;
    dragging = true;
    startX = e.clientX;
    startW = parseFloat(getComputedStyle(shell).getPropertyValue(`--${varName}`)) || minW;
    handle.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rtl = document.documentElement.dir === "rtl";
    const delta = rtl ? startX - e.clientX : e.clientX - startX;
    const newW = Math.min(maxW, Math.max(minW, startW + delta));
    shell.style.setProperty(`--${varName}`, `${newW}px`);
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("active");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

function initGlobalSearch() {
  const search = $("globalSearch");
  const projectTree = $("projectTree");
  const applySearch = (value) => {
    const query = String(value ?? "").trim().toLowerCase();
    if (projectTree) {
      projectTree.dataset.filterActive = query ? "true" : "false";
      projectTree.dispatchEvent(new CustomEvent("workspace-filter-change", {
        detail: { query },
      }));
    }
    const groups = document.querySelectorAll(".project-group");
    for (const group of groups) {
      const projName = group.querySelector(".project-name")?.textContent?.toLowerCase() || "";
      const sessionItems = group.querySelectorAll(".session-item");
      let anySessionVisible = false;
      for (const item of sessionItems) {
        const title = item.querySelector(".session-title")?.textContent?.toLowerCase() || "";
        const match = !query || title.includes(query) || projName.includes(query);
        item.style.display = match ? "" : "none";
        if (match) anySessionVisible = true;
      }
      group.style.display = !query || anySessionVisible || projName.includes(query) ? "" : "none";
    }
  };

  search?.addEventListener("input", (event) => applySearch(event.target.value));
  applySearch(search?.value || "");
}

function setWorkspaceProjects(projects) {
  const focusedProjectId = document.activeElement
    ?.closest?.(".project-group")
    ?.dataset?.projectId;
  store.set("projects", projects);
  renderProjectTree();
  if (!focusedProjectId) return;
  const headerMain = [...document.querySelectorAll(".project-header-main")]
    .find((item) => item.dataset.projectId === focusedProjectId);
  headerMain?.focus({ preventScroll: true });
}

async function updateAboutVersion() {
  const el = $("settingsAboutVersion");
  if (!el) return;
  try {
    const result = await window.assistantClient?.getAppVersion?.();
    el.textContent = t("settings.aboutVersion", { version: result?.version || "0.1.0" });
  } catch {
    el.textContent = t("settings.aboutVersion", { version: "0.1.0" });
  }
}

async function bindAppIcons() {
  try {
    const url = await window.assistantClient?.getAppIconUrl?.();
    if (!url) {
      console.warn("[app-icon] no runtime icon URL");
      return;
    }
    for (const img of document.querySelectorAll(".app-logo, .settings-about-logo, .assistant-turn-logo")) {
      img.src = url;
      img.addEventListener("error", () => {
        console.warn("[app-icon] failed to render logo");
      }, { once: true });
    }
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) favicon.href = url;
  } catch (err) {
    console.warn("[app-icon] bind failed:", err);
  }
}

function wireLocaleRefresh() {
  onLocaleChange(async () => {
    applyDomI18n();
    await updateAboutVersion();
    await refreshLicenseStatus();
    await refreshLocaleSelect();
    updateTopbarTitles();
    renderProjectTree();
    await refreshSkillsList();
    await refreshWorkspaceApps();
    await refreshSessionSkillsUi();
    refreshCharacterControlUi();
    refreshCharacterLibraryUi();
    syncComposerForActiveSession();
    syncCustomSelects();
  });
}

function initRendererHeartbeat() {
  const send = window.assistantClient?.sendRendererHeartbeat;
  if (typeof send !== "function") return;
  const intervalMs = 1000;
  let seq = 0;
  let expected = performance.now() + intervalMs;
  const tick = () => {
    const current = performance.now();
    const rendererLagMs = Math.max(0, current - expected);
    expected = current + intervalMs;
    try {
      send({
        seq: ++seq,
        rendererLagMs: Math.round(rendererLagMs),
        visibilityState: document.visibilityState || "",
      });
    } catch {
      /* heartbeat must never affect the UI */
    }
  };
  tick();
  setInterval(tick, intervalMs);
}

async function init() {
  await initI18n();
  initRendererHeartbeat();
  await updateAboutVersion();
  wireLocaleRefresh();

  await bindAppIcons();
  initMessageUi();
  wireMessageIpc();
  initMigrationProgress();
  initStartupHealth();
  initRuntimePackProgress();
  initVoiceDictation();
  initCustomSelects();

  initComposer();
  initScheduledTasks();
  initFileHandler();
  initPanelToggles();
  initResizeHandles();
  initGlobalSearch();
  initAddProject();
  initTopbarSessionRename();
  await initSettingsPanel();
  initAccountMenu();
  initModelSettings();
  initLocaleSettings();
  initPermissionSettings();
  initSearchSettings();
  initMediaProviderSettings();
  initMobilePairingSettings();
  initSkillSettings();
  initWorkspaceApps();
  initLicenseUpdateSettings();
  initSessionSkills();
  initCharacterSessionControl();
  initCharacterLibrary();

  initDiffPanel();
  initFindBar();
  initTaskCenter();

  await refreshLocaleSelect();
  await refreshLicenseStatus();
  await refreshUpdateSettings();
  startAutoUpdateChecks();
  kickAutoUpdateCheck();
  const state = await refreshState();
  if (state?.agent && !state.agent.ready) {
    showToast(state.agent.error || t("app.agentNotReady"), "error");
  }

  initWorkspaceSwitcher();
  initWorkspaceOrder({
    getTree: () => $("projectTree"),
    getProjects: () => store.get("projects") || [],
    setProjects: setWorkspaceProjects,
    persist: (projectIds) => window.assistantClient.reorderProjects(projectIds),
    isFilterActive: () => $("projectTree")?.dataset.filterActive === "true",
    t,
    showToast,
    showActionToast,
  });
  renderProjectTree();
  updateTopbarTitles();
  await refreshSessionSkillsUi();
}

init();
