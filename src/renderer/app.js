/**
 * Application entry point — wires all modules together.
 */

import store from "./modules/state.js";
import { initComposer } from "./modules/composer.js";
import { initFileHandler } from "./modules/file-handler.js";
import { wireIpcEvents, renderConversation, refreshState, updateTopbarTitles } from "./modules/message.js";
import { initScrollToBottom } from "./modules/dom.js";
import { renderProjectTree, initAddProject, initTopbarSessionRename } from "./modules/project-tree.js";
import { loadTemplates, renderTemplates } from "./modules/templates.js";
import { initStatusBar } from "./modules/status-bar.js";
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
}

// ---------------------------------------------------------------------------
// Resize handles
// ---------------------------------------------------------------------------

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
    const delta = e.clientX - startX;
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
// Global search
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  wireIpcEvents();

  initComposer();
  initFileHandler();
  initPanelToggles();
  initResizeHandles();
  initGlobalSearch();
  initStatusBar();
  initAddProject();
  initTopbarSessionRename();
  initScrollToBottom();

  await refreshState();
  loadTemplates();

  renderConversation();
  renderProjectTree();
  renderTemplates();
  updateTopbarTitles();
}

init();
