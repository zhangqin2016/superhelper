/**
 * Project tree — renders workspaces with nested sessions in the left panel.
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { renderConversation, refreshState, updateTopbarTitles } from "./message.js";
import { promptSessionName, promptProjectName } from "./name-prompt.js";

const container = () => $("projectTree");

// Which projects are collapsed
const collapsed = new Set();

async function createNamedSession(projectId, defaultTitle = "新对话") {
  const title = await promptSessionName(defaultTitle);
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

    const header = document.createElement("div");
    header.className = "project-header";
    header.addEventListener("click", (e) => {
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
    name.className = "project-name project-name-editable";
    name.textContent = project.name;
    name.title = "双击可修改文件夹名称";
    name.addEventListener("dblclick", async (e) => {
      e.stopPropagation();
      const newName = await promptProjectName(project.name);
      if (!newName || newName === project.name) return;
      await window.assistantClient.renameProject(project.id, newName);
      await refreshState();
      renderProjectTree();
      updateTopbarTitles();
    });

    info.append(name);

    const actions = document.createElement("div");
    actions.className = "project-actions";

    const newSessionBtn = document.createElement("button");
    newSessionBtn.className = "project-action-btn";
    newSessionBtn.title = "新建对话";
    newSessionBtn.textContent = "+";
    newSessionBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const result = await createNamedSession(project.id);
      if (!result?.ok) return;
      await window.assistantClient.switchProject(project.id);
      const sw = await window.assistantClient.switchSession(result.session.id);
      if (sw.ok) store.set("conversation", sw.conversation || []);
      await refreshState();
      renderProjectTree();
      renderConversation();
      updateTopbarTitles();
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

    const sessionList = document.createElement("div");
    sessionList.className = "project-sessions";
    if (isCollapsed) sessionList.style.display = "none";

    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "project-sessions-empty";
      empty.textContent = "暂无对话";
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
        title.className = "session-title session-title-editable";
        title.textContent = s.title;
        title.title = "双击可修改名称";
        title.addEventListener("dblclick", async (e) => {
          e.stopPropagation();
          await renameSessionById(s.id, s.title);
        });
        item.appendChild(title);

        const meta = document.createElement("span");
        meta.className = "session-meta";
        meta.textContent = s.messageCount ? `${s.messageCount}条` : "";
        item.appendChild(meta);

        item.addEventListener("click", async () => {
          if (project.id !== store.get("activeProjectId")) {
            await window.assistantClient.switchProject(project.id);
          }
          const sw = await window.assistantClient.switchSession(s.id);
          if (sw.ok && sw.conversation) {
            store.set("conversation", sw.conversation);
          }
          await refreshState();
          renderProjectTree();
          renderConversation();
          updateTopbarTitles();
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

function showProjectMenu(e, project) {
  const existing = document.querySelector(".ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:10000;min-width:160px;padding:6px;background:#1e2140;border:1px solid #2a2d50;border-radius:8px;box-shadow:0 12px 36px rgba(0,0,0,0.5);`;

  const items = [
    {
      label: "切换到此文件夹",
      action: async () => {
        await window.assistantClient.switchProject(project.id);
        await refreshState();
        renderProjectTree();
        updateTopbarTitles();
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
        const name = await promptProjectName(project.name);
        if (!name || name === project.name) return;
        await window.assistantClient.renameProject(project.id, name);
        await refreshState();
        renderProjectTree();
        updateTopbarTitles();
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
          updateTopbarTitles();
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
    await renameSessionById(sessionId, title);
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
    updateTopbarTitles();
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
    updateTopbarTitles();
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

export function initAddProject() {
  $("addProjectBtn")?.addEventListener("click", async () => {
    const result = await window.assistantClient.addProject();
    if (!result.ok) return;

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
  });
}

export function initTopbarSessionRename() {
  $("projectTitle")?.addEventListener("click", async () => {
    const sessionId = store.get("activeSessionId");
    if (!sessionId) return;

    const projects = store.get("projects") || [];
    let currentTitle = "新对话";
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
    background:transparent;color:#e0e0f0;font-size:13px;text-align:left;cursor:pointer;
  }
  .ctx-menu-item:hover { background:#2a2d50; }
  .project-name-editable { cursor: text; }
  .project-name-editable:hover { color: var(--accent); }
`;
document.head.appendChild(style);
