/**
 * Application entry point — wires all modules together.
 */

import store from "./modules/state.js";
import { initComposer } from "./modules/composer.js";
import { initFileHandler } from "./modules/file-handler.js";
import { wireIpcEvents, renderConversation, refreshState } from "./modules/message.js";
import { renderProjectTree, initAddProject } from "./modules/project-tree.js";
import { loadFileTree, renderFileTree } from "./modules/file-tree.js";
import { initDiffButtons, renderDiffView } from "./modules/diff-viewer.js";
import { renderTasks } from "./modules/task-panel.js";
import { initTerminal } from "./modules/terminal.js";
import { loadTemplates, renderTemplates } from "./modules/templates.js";
import { initStatusBar } from "./modules/status-bar.js";
import { initVoice } from "./modules/voice.js";
import { initPlugin } from "./modules/plugin.js";
import { $ } from "./modules/dom.js";

// ---------------------------------------------------------------------------
// Panel toggle
// ---------------------------------------------------------------------------

function initPanelToggles() {
  const shell = $("appShell");
  if (!shell) return;

  $("leftToggleBtn")?.addEventListener("click", () => {
    shell.classList.toggle("left-collapsed");
  });

  $("rightToggleBtn")?.addEventListener("click", () => {
    shell.classList.toggle("right-collapsed");
  });
}

// ---------------------------------------------------------------------------
// Resize handles
// ---------------------------------------------------------------------------

function initResizeHandles() {
  const shell = $("appShell");
  if (!shell) return;

  initResizeHandle("leftResizeHandle", "left-w", "left-collapsed", 180, 450);
  initResizeHandle("rightResizeHandle", "right-w", "right-collapsed", 220, 500);
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
    const delta = varName === "left-w" ? e.clientX - startX : startX - e.clientX;
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

// ---------------------------------------------------------------------------
// Mode switch
// ---------------------------------------------------------------------------

function initModeSwitch() {
  $("modeFastBtn")?.addEventListener("click", () => {
    store.set("mode", "fast");
    $("modeFastBtn").classList.add("active");
    $("modeDeepBtn").classList.remove("active");
  });

  $("modeDeepBtn")?.addEventListener("click", () => {
    store.set("mode", "deep");
    $("modeDeepBtn").classList.add("active");
    $("modeFastBtn").classList.remove("active");
  });
}

// ---------------------------------------------------------------------------
// Plugin panel
// ---------------------------------------------------------------------------

function initPluginPanel() {
  $("pluginBtn")?.addEventListener("click", () => {
    const panel = $("pluginPanel");
    if (panel) panel.hidden = false;
    refreshPlugins();
  });

  $("closePluginBtn")?.addEventListener("click", () => {
    const panel = $("pluginPanel");
    if (panel) panel.hidden = true;
  });
}

async function refreshPlugins() {
  const state = await window.assistantClient.listPlugins();
  if (state) {
    store.set("plugins", state.plugins || []);
    renderPluginList();
  }
}

function renderPluginList() {
  const list = $("pluginList");
  if (!list) return;
  list.textContent = "";

  const plugins = store.get("plugins") || [];
  for (const p of plugins) {
    const card = document.createElement("div");
    card.className = "plugin-card";
    card.innerHTML = `
      <h3>${p.name}</h3>
      <p>${p.description}</p>
    `;
    for (const scope of p.scopes) {
      const state = scope === "global" ? p.global : p.workspace;
      const installed = !!state;
      const enabled = state?.enabled;
      const row = document.createElement("div");
      row.className = "plugin-scope-row";
      row.innerHTML = `<span>${scope === "global" ? "全局" : "当前项目"}</span>`;
      const actions = document.createElement("div");
      actions.className = "plugin-scope-actions";
      if (installed) {
        const toggleBtn = document.createElement("button");
        toggleBtn.textContent = enabled ? "已启用" : "已禁用";
        toggleBtn.className = enabled ? "enabled" : "";
        toggleBtn.addEventListener("click", async () => {
          await window.assistantClient.setPluginEnabled(p.id, scope, !enabled);
          await refreshPlugins();
        });
        const uninstallBtn = document.createElement("button");
        uninstallBtn.textContent = "卸载";
        uninstallBtn.addEventListener("click", async () => {
          await window.assistantClient.uninstallPlugin(p.id, scope);
          await refreshPlugins();
        });
        actions.append(toggleBtn, uninstallBtn);
      } else {
        const installBtn = document.createElement("button");
        installBtn.textContent = "安装";
        installBtn.addEventListener("click", async () => {
          await window.assistantClient.installPlugin(p.id, scope);
          await refreshPlugins();
        });
        actions.appendChild(installBtn);
      }
      row.appendChild(actions);
      card.appendChild(row);
    }
    list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Global search
// ---------------------------------------------------------------------------

function initGlobalSearch() {
  $("globalSearch")?.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase();
    const groups = document.querySelectorAll(".project-group");
    for (const group of groups) {
      const projName = group.querySelector(".project-name")?.textContent?.toLowerCase() || "";
      const projPath = group.querySelector(".project-path")?.textContent?.toLowerCase() || "";
      const sessionItems = group.querySelectorAll(".session-item");
      let anySessionVisible = false;
      for (const item of sessionItems) {
        const title = item.querySelector(".session-title")?.textContent?.toLowerCase() || "";
        const match = !query || title.includes(query) || projName.includes(query) || projPath.includes(query);
        item.style.display = match ? "" : "none";
        if (match) anySessionVisible = true;
      }
      // Hide project group only if query exists AND nothing matches
      group.style.display = !query || anySessionVisible || projName.includes(query) || projPath.includes(query) ? "" : "none";
    }
  });
}

// ---------------------------------------------------------------------------
// File tree refresh
// ---------------------------------------------------------------------------

function initFileTreeRefresh() {
  $("refreshFileTreeBtn")?.addEventListener("click", () => {
    loadFileTree();
  });
}

// ---------------------------------------------------------------------------
// Clear completed tasks
// ---------------------------------------------------------------------------

function initClearTasks() {
  $("clearTasksBtn")?.addEventListener("click", () => {
    const tasks = (store.get("tasks") || []).filter((t) => t.status === "running");
    store.set("tasks", tasks);
    renderTasks();
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  wireIpcEvents();

  initComposer();
  initFileHandler();
  initPanelToggles();
  initResizeHandles();
  initModeSwitch();
  initPluginPanel();
  initGlobalSearch();
  initFileTreeRefresh();
  initClearTasks();
  initDiffButtons();
  initStatusBar();
  initVoice();
  initPlugin();
  initTerminal();
  initAddProject();

  // Load initial data
  await refreshState();

  // Load file tree for current project
  loadFileTree();

  // Load templates
  loadTemplates();

  // Render UI
  renderConversation();
  renderProjectTree();
  renderTasks();

  // Watch project for file changes
  window.assistantClient.watchProject();
}

init();
