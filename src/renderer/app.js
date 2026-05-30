/**
 * Application entry point — wires all modules together.
 */

import { initI18n, onLocaleChange, t, applyDomI18n } from "./i18n/index.js";
import { initComposer } from "./modules/composer.js";
import { initSessionSkills, refreshSessionSkillsUi } from "./modules/session-skills.js";
import { initFileHandler } from "./modules/file-handler.js";
import { refreshState, updateTopbarTitles } from "./modules/session-chrome.js";
import { wireMessageIpc, initMessageUi, syncComposerForActiveSession } from "./modules/message.js";
import { renderProjectTree, initAddProject, initTopbarSessionRename } from "./modules/project-tree.js";
import { initSettingsPanel } from "./modules/settings-panel.js";
import { initModelSettings } from "./modules/model-settings.js";
import { initPermissionSettings } from "./modules/permission-settings.js";
import { initSearchSettings } from "./modules/search-settings.js";
import { initSkillSettings, refreshSkillsList } from "./modules/skill-settings.js";
import { initLocaleSettings, refreshLocaleSelect } from "./modules/locale-settings.js";
import { initDiffPanel } from "./modules/diff-panel.js";
import { showToast } from "./modules/toast.js";
import { $ } from "./modules/dom.js";

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
  $("globalSearch")?.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase();
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
  });
}

function updateAboutVersion() {
  const el = $("settingsAboutVersion");
  if (el) el.textContent = t("settings.aboutVersion", { version: "0.1.0" });
}

async function bindAppIcons() {
  try {
    const url = await window.assistantClient?.getAppIconUrl?.();
    if (!url) {
      console.warn("[app-icon] no runtime icon URL");
      return;
    }
    for (const img of document.querySelectorAll(".app-logo, .settings-about-logo")) {
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
    updateAboutVersion();
    await refreshLocaleSelect();
    updateTopbarTitles();
    renderProjectTree();
    await refreshSkillsList();
    await refreshSessionSkillsUi();
    syncComposerForActiveSession();
  });
}

async function init() {
  await initI18n();
  updateAboutVersion();
  wireLocaleRefresh();

  await bindAppIcons();
  initMessageUi();
  wireMessageIpc();

  initComposer();
  initFileHandler();
  initPanelToggles();
  initResizeHandles();
  initGlobalSearch();
  initAddProject();
  initTopbarSessionRename();
  initSettingsPanel();
  initModelSettings();
  initLocaleSettings();
  initPermissionSettings();
  initSearchSettings();
  initSkillSettings();
  initSessionSkills();

  initDiffPanel();

  await refreshLocaleSelect();
  await refreshState();
  const state = await window.assistantClient.getFullState();
  if (state?.agent && !state.agent.ready) {
    showToast(state.agent.error || t("app.agentNotReady"), "error");
  }

  renderProjectTree();
  updateTopbarTitles();
  await refreshSessionSkillsUi();
}

init();
