/**
 * Message rendering: chat bubbles, Markdown, conversation display.
 */

import store from "./state.js";
import { $, scrollToBottom } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

const messagesEl = $("messages");

export function createMessage(role, text = "", files = null) {
  const wrapper = document.createElement("article");
  wrapper.className = `msg msg-${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "你" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (role === "assistant") {
    renderMarkdown(bubble, text);
  } else {
    bubble.textContent = text;
  }

  if (files && files.length > 0) {
    const fc = document.createElement("div");
    fc.className = "msg-bubble-files";
    for (const f of files) {
      const fi = document.createElement("div");
      fi.className = "msg-bubble-file";
      fi.textContent = f.isImage ? `[图片] ${f.name}` : f.name;
      fc.appendChild(fi);
    }
    bubble.appendChild(fc);
  }

  wrapper.append(avatar, bubble);
  messagesEl.appendChild(wrapper);
  scrollToBottom();
  return bubble;
}

export function renderConversation() {
  messagesEl.textContent = "";
  const conv = store.get("conversation");
  if (!conv || conv.length === 0) {
    const project = activeProject();
    createMessage("assistant", project ? `当前项目：${project.name}。` : "选择一个项目开始工作吧。");
    return;
  }
  for (const msg of conv) {
    createMessage(msg.role === "user" ? "user" : "assistant", msg.content, msg.files || null);
  }
  store.set("activeBubble", null);
  store.set("activeMarkdown", "");
}

export function activeProject() {
  const state = store.get("projects");
  const id = store.get("activeProjectId");
  if (!state || !id) return null;
  return state.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------
// IPC event wiring
// ---------------------------------------------------------------------------

// Track active tool cards
const toolCards = new Map();

function toolLabel(name, input) {
  const action = input?.query || input?.search_query || input?.prompt || "";
  const shortAction = String(action).slice(0, 40);
  const icons = {
    WebSearch: "🔍", web_search_prime: "🔍", webReader: "📖",
    Read: "📄", Write: "✏️", Edit: "✏️", Bash: "⚡",
    Grep: "🔎", Glob: "🗂️",
  };
  const icon = icons[name] || "🔄";
  const desc = shortAction ? `「${shortAction}${action.length > 40 ? "..." : ""}」` : "";
  return `${icon} ${name} ${desc}`;
}

function addToolCard(id, name, input) {
  const el = $("messages");
  if (!el) return;

  const card = document.createElement("div");
  card.className = "tool-card tool-card-running";
  card.dataset.toolId = id;

  const dot = document.createElement("span");
  dot.className = "tool-card-dot";

  const label = document.createElement("span");
  label.className = "tool-card-label";
  label.textContent = toolLabel(name, input);

  card.append(dot, label);
  el.appendChild(card);
  scrollToBottom();
  toolCards.set(id, card);
}

function updateToolCard(id, status) {
  const card = toolCards.get(id);
  if (!card) return;
  card.classList.remove("tool-card-running");
  card.classList.add(status === "failed" ? "tool-card-failed" : "tool-card-done");
  toolCards.delete(id);
}

export function wireIpcEvents() {
  window.assistantClient.onTool((payload) => {
    const sid = store.get("activeSessionId");
    if (payload.sessionId && payload.sessionId !== sid) return;
    addToolCard(payload.id, payload.name, payload.input);
  });

  window.assistantClient.onToolDone((payload) => {
    const sid = store.get("activeSessionId");
    if (payload.sessionId && payload.sessionId !== sid) return;
    updateToolCard(payload.id, payload.status);
  });

  window.assistantClient.onChunk((payload) => {
    const sid = store.get("activeSessionId");
    if (payload.sessionId && payload.sessionId !== sid) return;

    let bubble = store.get("activeBubble");
    if (!bubble) {
      bubble = createMessage("assistant", "");
      store.set("activeBubble", bubble);
      store.set("activeMarkdown", "");
    }
    bubble.classList.remove("pending");
    const current = store.get("activeMarkdown") + payload.text;
    store.set("activeMarkdown", current);
    renderMarkdown(bubble, current);
    scrollToBottom();
  });

  window.assistantClient.onDone(async (payload) => {
    const sid = store.get("activeSessionId");
    if (payload.sessionId && payload.sessionId !== sid) return;

    // Clear any lingering tool cards
    for (const [id, card] of toolCards) {
      card.classList.remove("tool-card-running");
      card.classList.add("tool-card-done");
    }
    toolCards.clear();

    const bubble = store.get("activeBubble");
    if (bubble) {
      bubble.classList.remove("pending");
      const md = store.get("activeMarkdown");
      if (!md.trim() && !bubble.textContent.trim()) {
        renderMarkdown(bubble, "已完成。");
      }
    }
    store.set("activeBubble", null);
    store.set("activeMarkdown", "");
    store.set("isBusy", false);
    setBusyUI(false);
    $("promptInput")?.focus();

    try {
      const result = await window.assistantClient.getDiff();
      if (result.ok && result.diffs.length > 0) {
        store.set("diffs", result.diffs);
        store.set("diffSummary", result.summary);
        showDiffPanel();
      }
    } catch {}

    await refreshState();
  });

  window.assistantClient.onStatus((status) => {
    const sid = store.get("activeSessionId");
    if (status.sessionId && status.sessionId !== sid) return;
    const busy = status.state === "thinking";
    store.set("isBusy", busy);
    setBusyUI(busy);
  });

  window.assistantClient.onError(async (error) => {
    const sid = store.get("activeSessionId");
    if (error.sessionId && error.sessionId !== sid) return;

    for (const [id, card] of toolCards) {
      card.classList.remove("tool-card-running");
      card.classList.add("tool-card-failed");
    }
    toolCards.clear();

    let bubble = store.get("activeBubble");
    if (!bubble) bubble = createMessage("assistant", "");
    bubble.classList.remove("pending");
    renderMarkdown(bubble, error.message || "处理请求时遇到问题。");
    store.set("activeBubble", null);
    store.set("activeMarkdown", "");
    store.set("isBusy", false);
    setBusyUI(false);
    await refreshState();
  });
}

// ---------------------------------------------------------------------------
// Diff panel control
// ---------------------------------------------------------------------------

export function showDiffPanel() {
  const panel = $("diffPanel");
  if (panel) panel.hidden = false;
}

export function hideDiffPanel() {
  const panel = $("diffPanel");
  if (panel) panel.hidden = true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function refreshState() {
  try {
    const state = await window.assistantClient.getFullState();
    if (state) {
      store.set("projects", state.projects || []);
      store.set("activeProjectId", state.activeProjectId);
      store.set("activeSessionId", state.activeSessionId);
      const active = (state.projects || []).find((p) => p.id === state.activeProjectId);
      store.set("workingDir", active ? active.path : "");
      updateWorkingDir(active ? active.path : "");
      updateProjectTitle(active ? active.name : "");
      // Flatten sessions for backward compat
      const allSessions = [];
      for (const p of state.projects || []) {
        for (const s of p.sessions || []) {
          allSessions.push(s);
        }
      }
      store.set("sessions", allSessions);
      if (state.conversation) store.set("conversation", state.conversation);
    }
  } catch {}
}

function updateWorkingDir(path) {
  const el = $("workingDir");
  if (el) el.textContent = path || "--";
}

function updateProjectTitle(name) {
  const el = $("projectTitle");
  if (el && name) el.textContent = name;
}

function setBusyUI(busy) {
  for (const id of ["sendBtn", "promptInput", "attachBtn", "newSessionBtn"]) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
  const meta = $("sessionMeta");
  if (meta) meta.textContent = busy ? "正在思考..." : "已就绪";

  const badge = $("statusBadge");
  if (badge) {
    badge.textContent = busy ? "执行中" : "就绪";
    badge.className = `status-badge ${busy ? "running" : "idle"}`;
  }

  const cliState = $("statusCliState");
  if (cliState) cliState.textContent = `CLI: ${busy ? "运行中" : "就绪"}`;
}
