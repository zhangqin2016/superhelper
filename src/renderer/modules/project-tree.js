/**
 * Project tree — renders workspaces with nested sessions in the left panel.
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { renderConversation, refreshState } from "./message.js";
import { loadFileTree } from "./file-tree.js";

const container = () => $("projectTree");

// Which projects are collapsed
const collapsed = new Set();

export function renderProjectTree() {
  const el = container();
  if (!el) return;
  el.textContent = "";

  const projects = store.get("projects") || [];
  const activeProjectId = store.get("activeProjectId");
  const activeSessionId = store.get("activeSessionId");
  const pinned = projects.filter((p) => p.pinned);
  const unpinned = projects.filter((p) => !p.pinned);
  const sorted = [...pinned, ...unpinned];

  for (const project of sorted) {
    const sessions = project.sessions || [];
    const isActive = project.id === activeProjectId;
    const isCollapsed = collapsed.has(project.id);

    const group = document.createElement("div");
    group.className = `project-group${isActive ? " active" : ""}`;

    // --- Project header ---
    const header = document.createElement("div");
    header.className = "project-header";
    header.addEventListener("click", (e) => {
      // Don't toggle if clicking action buttons
      if (e.target.closest(".project-action-btn")) return;
      collapsed.has(project.id)
        ? collapsed.delete(project.id)
        : collapsed.add(project.id);
      renderProjectTree();
    });

    const icon = document.createElement("span");
    icon.className = "project-collapse-icon";
    icon.textContent = isCollapsed ? "▶" : "▼";

    const info = document.createElement("div");
    info.className = "project-info";

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name;

    const pathEl = document.createElement("span");
    pathEl.className = "project-path";
    pathEl.textContent = project.path;
    pathEl.title = project.path;

    info.append(name, pathEl);

    const actions = document.createElement("div");
    actions.className = "project-actions";

    const newSessionBtn = document.createElement("button");
    newSessionBtn.className = "project-action-btn";
    newSessionBtn.title = "在此工作空间新建会话";
    newSessionBtn.textContent = "+";
    newSessionBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const result = await window.assistantClient.createSession("新会话", project.id);
      if (result.ok) {
        await window.assistantClient.switchProject(project.id);
        await window.assistantClient.switchSession(result.session.id);
        await refreshState();
        renderProjectTree();
        renderConversation();
        loadFileTree();
      }
    });

    const moreBtn = document.createElement("button");
    moreBtn.className = "project-action-btn";
    moreBtn.title = "更多操作";
    moreBtn.textContent = "…";
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showProjectMenu(e, project);
    });

    actions.append(newSessionBtn, moreBtn);
    header.append(icon, info, actions);
    group.appendChild(header);

    // --- Sessions ---
    const sessionList = document.createElement("div");
    sessionList.className = "project-sessions";
    if (isCollapsed) sessionList.style.display = "none";

    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "project-sessions-empty";
      empty.textContent = "暂无会话";
      sessionList.appendChild(empty);
    } else {
      for (const s of sessions) {
        const item = document.createElement("div");
        item.className = `session-item${s.id === activeSessionId ? " active" : ""}`;
        item.dataset.sessionId = s.id;
        item.dataset.projectId = project.id;

        const status = document.createElement("span");
        status.className = `session-status ${s.status || "idle"}`;
        item.appendChild(status);

        const title = document.createElement("span");
        title.className = "session-title";
        title.textContent = s.title;
        item.appendChild(title);

        const meta = document.createElement("span");
        meta.className = "session-meta";
        meta.textContent = s.messageCount ? `${s.messageCount}条` : "";
        item.appendChild(meta);

        item.addEventListener("click", async () => {
          if (store.get("isBusy")) return;
          // Switch project if needed
          if (project.id !== store.get("activeProjectId")) {
            await window.assistantClient.switchProject(project.id);
          }
          await window.assistantClient.switchSession(s.id);
          await refreshState();
          renderProjectTree();
          renderConversation();
          loadFileTree();
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

// ---------------------------------------------------------------------------
// Project context menu
// ---------------------------------------------------------------------------

function showProjectMenu(e, project) {
  const existing = document.querySelector(".ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:10000;min-width:160px;padding:6px;background:#1e2140;border:1px solid #2a2d50;border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,0.5);`;

  const items = [
    {
      label: "设为默认项目",
      action: async () => {
        await window.assistantClient.switchProject(project.id);
        await refreshState();
        renderProjectTree();
        loadFileTree();
      },
    },
    {
      label: project.pinned ? "取消置顶" : "置顶",
      action: async () => {
        await window.assistantClient.pinProject(project.id);
        await refreshState();
        renderProjectTree();
      },
    },
    {
      label: "重命名",
      action: async () => {
        const name = prompt("新名称", project.name);
        if (name && name.trim()) {
          await window.assistantClient.renameProject(project.id, name.trim());
          await refreshState();
          renderProjectTree();
        }
      },
    },
    {
      label: "在 Finder 中打开",
      action: () => window.assistantClient.openProject(project.id),
    },
    {
      label: "删除",
      danger: true,
      action: async () => {
        const result = await window.assistantClient.removeProject(project.id);
        if (result.ok) {
          await refreshState();
          renderProjectTree();
          renderConversation();
          loadFileTree();
        }
      },
    },
  ];

  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "ctx-menu-item";
    if (item.danger) btn.style.color = "#f87171";
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      menu.remove();
      item.action();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}

// ---------------------------------------------------------------------------
// Session context menu
// ---------------------------------------------------------------------------

function showSessionMenu(x, y, sessionId, title) {
  const existing = document.querySelector(".ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:10000;min-width:160px;padding:6px;background:#1e2140;border:1px solid #2a2d50;border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,0.5);`;

  const rename = document.createElement("button");
  rename.className = "ctx-menu-item";
  rename.textContent = "重命名";
  rename.addEventListener("click", async () => {
    menu.remove();
    const newTitle = prompt("新名称", title);
    if (newTitle && newTitle.trim()) {
      await window.assistantClient.renameSession(sessionId, newTitle.trim());
      await refreshState();
      renderProjectTree();
    }
  });

  const archive = document.createElement("button");
  archive.className = "ctx-menu-item";
  archive.textContent = "归档";
  archive.addEventListener("click", async () => {
    menu.remove();
    await window.assistantClient.archiveSession(sessionId);
    await refreshState();
    renderProjectTree();
    renderConversation();
  });

  const del = document.createElement("button");
  del.className = "ctx-menu-item";
  del.style.color = "#f87171";
  del.textContent = "删除";
  del.addEventListener("click", async () => {
    menu.remove();
    await window.assistantClient.deleteSession(sessionId);
    await refreshState();
    renderProjectTree();
    renderConversation();
  });

  menu.append(rename, archive, del);
  document.body.appendChild(menu);

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}

// ---------------------------------------------------------------------------
// Add-project button handler
// ---------------------------------------------------------------------------

export function initAddProject() {
  $("addProjectBtn")?.addEventListener("click", async () => {
    const result = await window.assistantClient.addProject();
    if (result.ok) {
      await refreshState();
      renderProjectTree();
      loadFileTree();
    }
  });
}

// ---------------------------------------------------------------------------
// Context menu styles (inject once)
// ---------------------------------------------------------------------------

const style = document.createElement("style");
style.textContent = `
  .ctx-menu-item {
    display:block;width:100%;padding:6px 12px;border:0;border-radius:4px;
    background:transparent;color:#e0e0f0;font-size:13px;text-align:left;cursor:pointer;
  }
  .ctx-menu-item:hover { background:#2a2d50; }
`;
document.head.appendChild(style);
