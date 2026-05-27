/**
 * Session list rendering and interaction (left panel).
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { renderConversation, refreshState } from "./message.js";

const container = () => $("sessionList");

export function renderSessionList() {
  const el = container();
  if (!el) return;
  el.textContent = "";

  const sessions = store.get("sessions") || [];
  const activeId = store.get("activeSessionId");

  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = `session-item${s.id === activeId ? " active" : ""}`;
    item.dataset.sessionId = s.id;

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
      await window.assistantClient.switchSession(s.id);
      await refreshState();
      renderSessionList();
      renderConversation();
    });

    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showSessionMenu(e.clientX, e.clientY, s.id, s.title);
    });

    el.appendChild(item);
  }
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
    const newTitle = prompt("新名称", title);
    if (newTitle && newTitle.trim()) {
      await window.assistantClient.renameSession(sessionId, newTitle.trim());
      await refreshState();
      renderSessionList();
    }
  });

  const del = document.createElement("button");
  del.className = "ctx-menu-item";
  del.textContent = "删除";
  del.addEventListener("click", async () => {
    menu.remove();
    await window.assistantClient.deleteSession(sessionId);
    await refreshState();
    renderSessionList();
    renderConversation();
  });

  menu.append(rename, del);
  document.body.appendChild(menu);

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("click", closeMenu); }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}

// Inject context menu styles
const style = document.createElement("style");
style.textContent = `
  .ctx-menu-item {
    display:block;width:100%;padding:6px 12px;border:0;border-radius:4px;
    background:transparent;color:#e0e0f0;font-size:13px;text-align:left;cursor:pointer;
  }
  .ctx-menu-item:hover { background:#2a2d50; }
`;
document.head.appendChild(style);
