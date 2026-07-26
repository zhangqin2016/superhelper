/**
 * Project tree — renders workspaces with nested sessions in the left panel.
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { t } from "../i18n/index.js";
import { refreshState, updateTopbarTitles, applySessionSwitch } from "./session-chrome.js";
import { removeSessionMessages } from "./message.js";
import { promptSessionName, promptProjectName } from "./name-prompt.js";
import { showToast } from "./toast.js";
import { isSessionRunning, getSessionAttention } from "./session-runtime-store.js";
import { confirmWorkspacePackExport } from "./workspace-export-dialog.js";
import { reviewWorkspacePackage } from "./workspace-package-review.js";
import { reorderWorkspaceByCommand } from "./workspace-order.js";
import { createWorkspaceProjectHeader } from "./workspace-project-header.js";

const container = () => $("projectTree");

// Which projects are collapsed
const collapsed = new Set();

/** Expand a project's session list (e.g. after creating a session). */
export function expandProjectGroup(projectId) {
  if (projectId) collapsed.delete(projectId);
}

function afterSessionListChanged(projectId) {
  expandProjectGroup(projectId);
  renderProjectTree();
}

async function createNamedSession(projectId, defaultTitle) {
  const title = await promptSessionName(defaultTitle || t("prompt.newSession"));
  if (!title) return null;
  return window.assistantClient.createSession(title, projectId);
}

async function renameSessionById(sessionId, currentTitle) {
  const newTitle = await promptSessionName(currentTitle);
  if (!newTitle || newTitle === currentTitle) return false;
  const result = await window.assistantClient.renameSession(sessionId, newTitle);
  if (result.ok) {
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
  }
  return result.ok;
}

export function renderProjectTree() {
  const el = container();
  if (!el) return;
  el.textContent = "";
  el.setAttribute("role", "list");

  const projects = store.get("projects") || [];
  const activeProjectId = store.get("activeProjectId");
  const activeSessionId = store.get("activeSessionId");

  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "project-tree-empty";
    empty.setAttribute("role", "listitem");
    empty.textContent = t("sidebar.emptyWorkspace");
    el.appendChild(empty);
    return;
  }

  for (const [projectIndex, project] of projects.entries()) {
    const sessions = project.sessions || [];
    const isActive = project.id === activeProjectId;
    const isCollapsed = collapsed.has(project.id);

    const group = document.createElement("div");
    group.className = `project-group${isActive ? " active" : ""}`;
    group.dataset.projectId = project.id;
    group.setAttribute("role", "listitem");
    const header = createWorkspaceProjectHeader({
      project,
      position: projectIndex + 1,
      total: projects.length,
      isCollapsed,
      onToggleCollapsed: ({ restoreFocus }) => {
        if (collapsed.has(project.id)) collapsed.delete(project.id);
        else collapsed.add(project.id);
        renderProjectTree();
        if (restoreFocus) {
          const nextHeaderMain = [...container().querySelectorAll(".project-header-main")]
            .find((item) => item.dataset.projectId === project.id);
          nextHeaderMain?.focus({ preventScroll: true });
        }
      },
      onRename: async () => {
        const newName = await promptProjectName(project.name);
        if (!newName || newName === project.name) return;
        await window.assistantClient.renameProject(project.id, newName);
        await refreshState();
        renderProjectTree();
        updateTopbarTitles();
      },
      onCreateSession: async () => {
        const result = await createNamedSession(project.id);
        if (!result?.ok) {
          showToast(result?.detail || t("toast.createSessionFailed"), "error");
          return;
        }
        const switched = await window.assistantClient.switchSession(result.session.id);
        await refreshState();
        afterSessionListChanged(project.id);
        await applySessionSwitch(switched, result.session.id, project.id);
      },
      onShowMenu: (event) => showProjectMenu(event, project),
    });
    group.appendChild(header);

    const sessionList = document.createElement("div");
    sessionList.className = "project-sessions";
    sessionList.setAttribute("role", "list");
    if (isCollapsed) sessionList.style.display = "none";

    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "project-sessions-empty";
      empty.setAttribute("role", "listitem");
      empty.textContent = t("sidebar.noSessions");
      sessionList.appendChild(empty);
    } else {
      for (const s of sessions) {
        const item = document.createElement("div");
        item.className = `session-item${s.id === activeSessionId ? " active" : ""}`;
        item.setAttribute("role", "listitem");
        item.dataset.sessionId = s.id;
        item.dataset.projectId = project.id;

        const status = document.createElement("span");
        status.className = "session-status";
        applySessionStatusDot(status, s.id);
        item.appendChild(status);

        const title = document.createElement("span");
        title.className = "session-title session-title-editable";
        title.textContent = s.title;
        title.title = t("sidebar.renameSessionHint");
        title.addEventListener("dblclick", async (e) => {
          e.stopPropagation();
          await renameSessionById(s.id, s.title);
        });
        item.appendChild(title);

        const meta = document.createElement("span");
        meta.className = "session-meta";
        meta.textContent = s.messageCount ? t("sidebar.messageCount", { count: s.messageCount }) : "";
        item.appendChild(meta);

        item.addEventListener("click", async () => {
          const visibleId = document.querySelector(".session-messages.is-active")?.dataset?.sessionId;
          if (s.id === store.get("activeSessionId") && s.id === visibleId) return;
          try {
            const sw = await window.assistantClient.switchSession(s.id);
            await applySessionSwitch(sw, s.id, project.id);
          } catch (err) {
            showToast(err?.message || t("toast.switchSessionFailed"), "error");
          }
        });

        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showSessionMenu(e.clientX, e.clientY, s.id, s.title);
        });

        sessionList.appendChild(item);
      }
    }

    group.appendChild(sessionList);

    el.appendChild(group);
  }
}

export function updateProjectTreeSelection() {
  const el = container();
  if (!el) return;
  const activeProjectId = store.get("activeProjectId");
  const activeSessionId = store.get("activeSessionId");

  el.querySelectorAll(".project-group").forEach((group) => {
    group.classList.toggle("active", group.dataset.projectId === activeProjectId);
  });

  el.querySelectorAll(".session-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.sessionId === activeSessionId);
  });
}

// Paint a session-list status dot. Precedence: running > finished-unviewed
// (done/failed) > idle. "done"/"failed" come from getSessionAttention, set when
// a background turn finishes and cleared when the user views the session.
function applySessionStatusDot(dot, sessionId) {
  const running = isSessionRunning(sessionId);
  const attention = running ? null : getSessionAttention(sessionId);
  dot.classList.toggle("running", running);
  dot.classList.toggle("done", attention === "done");
  dot.classList.toggle("error", attention === "failed");
  dot.classList.toggle("idle", !running && !attention);
  dot.title = running
    ? t("sidebar.processing")
    : attention === "done"
      ? t("sidebar.sessionDone")
      : attention === "failed"
        ? t("sidebar.sessionFailed")
        : "";
}

export function updateSessionRunningIndicators() {
  container()?.querySelectorAll(".session-item").forEach((item) => {
    const dot = item.querySelector(".session-status");
    if (dot) applySessionStatusDot(dot, item.dataset.sessionId);
  });
}

export function updateSessionMetaCounts() {
  const sessionById = new Map();
  for (const project of store.get("projects") || []) {
    for (const session of project.sessions || []) {
      sessionById.set(session.id, session);
    }
  }

  container()?.querySelectorAll(".session-item").forEach((item) => {
    const session = sessionById.get(item.dataset.sessionId);
    if (!session) return;
    const meta = item.querySelector(".session-meta");
    if (meta) meta.textContent = session.messageCount ? t("sidebar.messageCount", { count: session.messageCount }) : "";
  });
}

export function updateProjectTreeChrome() {
  updateProjectTreeSelection();
  updateSessionRunningIndicators();
  updateSessionMetaCounts();
}

const CTX_MENU_CSS = "position:fixed;z-index:10000;min-width:160px;padding:6px;background:var(--bg-floating);border:1px solid var(--border-light);border-radius:8px;box-shadow:var(--shadow-floating);";

// Place a context menu at (x, y) but flip/clamp it back inside the viewport —
// menus opened on the last list item used to overflow below the window and
// get clipped.
function placeContextMenu(menu, x, y) {
  document.body.appendChild(menu);
  const { width, height } = menu.getBoundingClientRect();
  const margin = 8;
  let left = x;
  let top = y;
  if (left + width > window.innerWidth - margin) left = Math.max(margin, x - width);
  if (top + height > window.innerHeight - margin) top = Math.max(margin, y - height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showProjectMenu(e, project) {
  const existing = document.querySelector(".ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = CTX_MENU_CSS;
  const projects = store.get("projects") || [];
  const projectIndex = projects.findIndex((item) => item.id === project.id);
  const filterActive = container()?.dataset.filterActive === "true";

  const items = [
    {
      label: t("ctx.switchFolder"),
      action: async () => {
        await window.assistantClient.switchProject(project.id);
        await refreshState();
        renderProjectTree();
        updateTopbarTitles();
      },
    },
    {
      label: t("workspaceOrder.moveTop"),
      disabled: filterActive || projectIndex <= 0,
      errorKey: "toast.workspaceOrderFailed",
      action: () => reorderWorkspaceByCommand(project.id, "top"),
    },
    {
      label: t("workspaceOrder.moveUp"),
      disabled: filterActive || projectIndex <= 0,
      errorKey: "toast.workspaceOrderFailed",
      action: () => reorderWorkspaceByCommand(project.id, "up"),
    },
    {
      label: t("workspaceOrder.moveDown"),
      disabled: filterActive || projectIndex < 0 || projectIndex >= projects.length - 1,
      errorKey: "toast.workspaceOrderFailed",
      action: () => reorderWorkspaceByCommand(project.id, "down"),
    },
    {
      label: t("ctx.rename"),
      action: async () => {
        const name = await promptProjectName(project.name);
        if (!name || name === project.name) return;
        await window.assistantClient.renameProject(project.id, name);
        await refreshState();
        renderProjectTree();
        updateTopbarTitles();
      },
    },
    {
      label: t("ctx.openInFinder"),
      action: () => window.assistantClient.openProject(project.id),
    },
    {
      label: t("ctx.sharePack"),
      action: () => shareWorkspacePack(project),
    },
    {
      label: t("ctx.delete"),
      danger: true,
      action: async () => {
        const result = await window.assistantClient.removeProject(project.id);
        if (result.ok) {
          const { hideAllSessionMessages } = await import("./message.js");
          hideAllSessionMessages();
          await refreshState();
          renderProjectTree();
          updateTopbarTitles();
        }
      },
    },
  ];

  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "ctx-menu-item";
    btn.disabled = Boolean(item.disabled);
    if (item.danger) btn.style.color = "#f87171";
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      menu.remove();
      if (!item.errorKey) {
        item.action();
        return;
      }
      try {
        void Promise.resolve(item.action()).catch((error) => {
          showToast(error?.message || t(item.errorKey), "error");
        });
      } catch (error) {
        showToast(error?.message || t(item.errorKey), "error");
      }
    });
    menu.appendChild(btn);
  }

  placeContextMenu(menu, e.clientX, e.clientY);

  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}

function showSessionMenu(x, y, sessionId, title) {
  const existing = document.querySelector(".ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = CTX_MENU_CSS;

  const rename = document.createElement("button");
  rename.className = "ctx-menu-item";
  rename.textContent = t("ctx.rename");
  rename.addEventListener("click", async () => {
    menu.remove();
    await renameSessionById(sessionId, title);
  });

  const archive = document.createElement("button");
  archive.className = "ctx-menu-item";
  archive.textContent = t("ctx.archive");
  archive.addEventListener("click", async () => {
    menu.remove();
    await window.assistantClient.archiveSession(sessionId);
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
  });

  const del = document.createElement("button");
  del.className = "ctx-menu-item";
  del.style.color = "#f87171";
  del.textContent = t("ctx.delete");
  del.addEventListener("click", async () => {
    menu.remove();
    await window.assistantClient.deleteSession(sessionId);
    removeSessionMessages(sessionId);
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
  });

  menu.append(rename, archive, del);
  placeContextMenu(menu, x, y);

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}

// Export a workspace as a shareable capability pack: preview what travels
// (privacy is an informed choice), confirm, then write the zip.
async function shareWorkspacePack(project) {
  // A rejected IPC (e.g. main process not restarted after an update) must not
  // vanish silently — surface it so "nothing happened" never happens.
  try {
    if (typeof window.assistantClient.exportPackPreview !== "function") {
      showToast(t("toast.exportPackFailed"), "error");
      return;
    }
    const info = await window.assistantClient.exportPackPreview(project.id);
    if (!info?.ok) {
      showToast(info?.error || t("toast.exportPackFailed"), "error");
      return;
    }
    const sizeMb = (info.preview.totalBytes / (1024 * 1024)).toFixed(1);
    const confirmed = await confirmWorkspacePackExport(info, sizeMb);
    if (!confirmed) return;
    const result = await window.assistantClient.exportPack(project.id, confirmed);
    if (result?.ok) showToast(t("toast.exportPackDone"), "success");
    else if (!result?.canceled) showToast(result?.error || t("toast.exportPackFailed"), "error");
  } catch (err) {
    showToast(err?.message || t("toast.exportPackFailed"), "error");
  }
}

export async function completeWorkspaceImport(result) {
  await refreshState();
  if (result.projectId) {
    const switched = await window.assistantClient.switchProject(result.projectId);
    const sessionId = switched?.sessions?.[0]?.id;
    if (sessionId) await applySessionSwitch(switched, sessionId, result.projectId);
    expandProjectGroup(result.projectId);
  }
  renderProjectTree();
  updateTopbarTitles();
  if (result.missingSkills?.length) {
    showToast(t("toast.importPackMissingSkills", { skills: result.missingSkills.join(", ") }), "warning");
  } else {
    showToast(t("toast.importPackDone", { name: result.projectName || "" }), "success");
  }
}

async function importWorkspacePack() {
  try {
    if (typeof window.assistantClient.pickWorkspacePackage !== "function") {
      showToast(t("toast.importPackFailed"), "error");
      return;
    }
    const inspection = await window.assistantClient.pickWorkspacePackage();
    if (!inspection?.ok) {
      if (!inspection?.canceled) showToast(inspection?.error || t("toast.importPackFailed"), "error");
      return;
    }
    if (!inspection.recognized) {
      showToast(t("pack.importNotRecognized"), "warning");
      return;
    }
    const decision = await reviewWorkspacePackage(inspection, { allowAttach: false });
    if (decision?.action !== "import") return;
    const result = await window.assistantClient.importWorkspacePackagePath({
      filePath: inspection.filePath,
      selectedAutomationIndexes: decision.selectedAutomationIndexes,
    });
    if (!result?.ok) {
      if (!result?.canceled) showToast(result?.error || t("toast.importPackFailed"), "error");
      return;
    }
    await completeWorkspaceImport(result);
  } catch (err) {
    showToast(err?.message || t("toast.importPackFailed"), "error");
  }
}

async function addFolderWorkspace() {
  const result = await window.assistantClient.addProject();
  if (!result.ok) return;

  // Re-adding an existing folder just switches to it — say so, skip the
  // rename prompt (the workspace already has a name).
  if (result.existed) {
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
    showToast(t("toast.folderAlreadyWorkspace"), "info");
    return;
  }

  const project = (result.state?.projects || []).find(
    (p) => p.id === result.state.activeProjectId,
  );
  if (project) {
    const name = await promptProjectName(project.name);
    if (name && name !== project.name) {
      await window.assistantClient.renameProject(project.id, name);
    }
  }

  await refreshState();
  renderProjectTree();
  updateTopbarTitles();
}

export function initAddProject() {
  // The add-workspace button offers both ways to get a new workspace —
  // an existing folder, or an imported capability pack — in one menu, so
  // the header stays a single uncluttered button.
  $("addProjectBtn")?.addEventListener("click", (e) => {
    const existing = document.querySelector(".ctx-menu");
    if (existing) existing.remove();
    const rect = e.currentTarget.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.cssText = CTX_MENU_CSS;
    for (const [label, action] of [
      [t("ctx.addFolder"), addFolderWorkspace],
      [t("ctx.importPack"), importWorkspacePack],
    ]) {
      const btn = document.createElement("button");
      btn.className = "ctx-menu-item";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        menu.remove();
        void action();
      });
      menu.appendChild(btn);
    }
    placeContextMenu(menu, rect.left, rect.bottom + 4);
    setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
  });
}

export function initTopbarSessionRename() {
  $("projectTitle")?.addEventListener("click", async () => {
    const sessionId = store.get("activeSessionId");
    if (!sessionId) return;

    const projects = store.get("projects") || [];
    let currentTitle = t("prompt.newSession");
    for (const project of projects) {
      const session = (project.sessions || []).find((s) => s.id === sessionId);
      if (session) {
        currentTitle = session.title;
        break;
      }
    }

    await renameSessionById(sessionId, currentTitle);
  });
}

const style = document.createElement("style");
style.textContent = `
  .ctx-menu-item {
    display:block;width:100%;padding:6px 12px;border:0;border-radius:4px;
    background:transparent;color:var(--text-primary);font-size:13px;text-align:start;cursor:pointer;
  }
  .ctx-menu-item:hover { background:var(--bg-surface-hover); }
  .project-name-editable { cursor: pointer; }
  .project-name-editable:hover { color: var(--accent); }
`;
document.head.appendChild(style);
