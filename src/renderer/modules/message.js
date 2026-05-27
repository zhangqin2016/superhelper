/**
 * Message rendering: chat bubbles, Markdown, conversation display.
 */

import store from "./state.js";
import { $, scrollToBottom } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

const messagesEl = $("messages");

/** Join streamed assistant segments with paragraph breaks instead of gluing inline. */
function appendMarkdownSegment(prev, next) {
  const piece = String(next ?? "");
  if (!piece) return prev || "";
  const base = prev || "";
  if (!base) return piece;
  if (base.endsWith("\n") || piece.startsWith("\n")) return base + piece;
  return `${base}\n\n${piece}`;
}

/** Break glued sentence boundaries from model output into separate lines. */
function softenStreamGlue(text) {
  return String(text || "")
    .replace(/([。！？!?])([^\s\n\r])/g, "$1\n\n$2")
    .replace(/\.(?=[A-Z\u4e00-\u9fff])/g, ".\n\n");
}

export function createMessage(role, text = "", files = null) {
  const wrapper = document.createElement("article");
  wrapper.className = `msg msg-${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "你" : "助手";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (role === "assistant") {
    renderMarkdown(bubble, softenStreamGlue(text));
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
  scrollToBottom(true);
  return bubble;
}

export function renderConversation() {
  finishActiveTurn();
  messagesEl.textContent = "";
  const conv = store.get("conversation");
  if (!conv || conv.length === 0) {
    const project = activeProject();
    createMessage("assistant", project ? `当前文件夹：${project.name}。有什么想问的？` : "请先添加一个文件夹，然后开始聊天吧。");
    return;
  }
  for (const msg of conv) {
    createMessage(msg.role === "user" ? "user" : "assistant", msg.content, msg.files || null);
  }
  store.set("activeBubble", null);
  store.set("activeMarkdown", "");
  scrollToBottom(true);
}

export function activeProject() {
  const state = store.get("projects");
  const id = store.get("activeProjectId");
  if (!state || !id) return null;
  return state.find((p) => p.id === id) || null;
}

export function activeSession() {
  const sessionId = store.get("activeSessionId");
  if (!sessionId) return null;
  for (const project of store.get("projects") || []) {
    const session = (project.sessions || []).find((s) => s.id === sessionId);
    if (session) return session;
  }
  return null;
}

export function updateTopbarTitles() {
  const project = activeProject();
  const session = activeSession();
  const titleEl = $("projectTitle");
  const metaEl = $("sessionMeta");

  if (titleEl) {
    titleEl.textContent = session?.title || project?.name || "智能助手";
  }
  if (metaEl && !store.get("isBusy")) {
    metaEl.textContent = project?.name ? `文件夹：${project.name}` : "已就绪";
  }
}

// ---------------------------------------------------------------------------
// IPC event wiring
// ---------------------------------------------------------------------------

const toolCards = new Map();
/** @type {{ article: HTMLElement, activity: HTMLElement, bubble: HTMLElement } | null} */
let activeTurn = null;
let currentActivityLabel = "";

function countRunningTools() {
  let n = 0;
  for (const entry of toolCards.values()) {
    if (entry.status === "running") n++;
  }
  return n;
}

function updateBusyMeta() {
  const meta = $("sessionMeta");
  if (!meta || !store.get("isBusy")) return;
  meta.textContent = currentActivityLabel || "正在处理，请稍候…";
}

function syncTurnProgress() {
  if (!activeTurn?.activity) return;

  const progress = activeTurn.activity.querySelector(".turn-progress");
  const waiting = store.get("isBusy") && countRunningTools() === 0;

  if (waiting) {
    if (!progress) {
      const row = document.createElement("div");
      row.className = "turn-progress tool-card tool-card-running";
      const dot = document.createElement("span");
      dot.className = "tool-card-dot";
      const label = document.createElement("span");
      label.className = "tool-card-label";
      label.textContent = "继续处理中，请稍候…";
      row.append(dot, label);
      activeTurn.activity.appendChild(row);
    }
    activeTurn.activity.hidden = false;
  } else if (progress) {
    progress.remove();
  }
}

function basename(path) {
  if (!path) return "";
  const parts = String(path).split(/[/\\]/);
  return parts[parts.length - 1] || String(path);
}

function clip(text, max = 72) {
  const value = String(text || "").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function toolSummary(name, input = {}) {
  switch (name) {
    case "Read":
      return { title: "读取文件", detail: basename(input.file_path || input.path || input.target_file) };
    case "Write":
      return { title: "写入文件", detail: basename(input.file_path || input.path) };
    case "Edit":
    case "MultiEdit":
      return { title: "修改文件", detail: basename(input.file_path || input.path) };
    case "Bash":
      return { title: "执行命令", detail: clip(input.command || input.description) };
    case "Grep":
      return { title: "搜索内容", detail: clip(input.pattern || input.query) };
    case "Glob":
      return { title: "查找文件", detail: clip(input.pattern || input.glob_pattern) };
    case "WebSearch":
    case "web_search_prime":
      return { title: "搜索网络", detail: clip(input.query || input.search_query) };
    case "webReader":
      return { title: "阅读网页", detail: clip(input.url) };
    default:
      return {
        title: name || "处理中",
        detail: clip(input.query || input.prompt || input.description || input.file_path || input.path),
      };
  }
}

export function beginAssistantTurn() {
  if (activeTurn) return activeTurn.bubble;

  const article = document.createElement("article");
  article.className = "msg msg-assistant msg-turn";

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = "助手";

  const body = document.createElement("div");
  body.className = "msg-body";

  const activity = document.createElement("div");
  activity.className = "tool-activity";
  activity.hidden = true;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble pending";

  body.append(activity, bubble);
  article.append(avatar, body);
  messagesEl.appendChild(article);

  activeTurn = { article, activity, bubble };
  store.set("activeBubble", bubble);
  store.set("activeMarkdown", "");
  scrollToBottom(false);
  return bubble;
}

function finishActiveTurn() {
  clearToolCards();
  if (activeTurn?.activity) {
    activeTurn.activity.replaceChildren();
    activeTurn.activity.hidden = true;
  }
  activeTurn = null;
  store.set("activeBubble", null);
  store.set("activeMarkdown", "");
}

export { finishActiveTurn, setBusyUI };

function renderToolCardContent(card, name, input) {
  const { title, detail } = toolSummary(name, input);
  card.replaceChildren();

  const dot = document.createElement("span");
  dot.className = "tool-card-dot";

  const textWrap = document.createElement("div");
  textWrap.style.minWidth = "0";
  textWrap.style.flex = "1";

  const label = document.createElement("span");
  label.className = "tool-card-label";
  label.textContent = title;

  textWrap.appendChild(label);
  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.className = "tool-card-detail";
    detailEl.textContent = detail;
    textWrap.appendChild(detailEl);
  }

  card.append(dot, textWrap);
}

function syncActivityVisibility() {
  if (!activeTurn) return;
  activeTurn.activity.hidden = activeTurn.activity.childElementCount === 0;
}

function addToolCard(id, name, input) {
  if (!activeTurn) beginAssistantTurn();

  const summary = toolSummary(name, input);
  currentActivityLabel = summary.detail
    ? `${summary.title}：${summary.detail}`
    : summary.title;
  updateBusyMeta();

  const card = document.createElement("div");
  card.className = "tool-card tool-card-running";
  card.dataset.toolId = id;
  renderToolCardContent(card, name, input);

  activeTurn.activity.appendChild(card);
  activeTurn.activity.hidden = false;
  scrollToBottom(false);
  toolCards.set(id, { card, name, input, status: "running" });
  syncTurnProgress();
}

function updateToolCard(id, status) {
  const entry = toolCards.get(id);
  if (!entry) return;

  if (status === "failed") {
    entry.card.classList.remove("tool-card-running");
    entry.card.classList.add("tool-card-failed");
    entry.card.querySelector(".tool-card-label").textContent =
      `${toolSummary(entry.name, entry.input).title}失败`;
    entry.status = "failed";
    toolCards.delete(id);
    currentActivityLabel = "遇到问题，正在调整…";
    updateBusyMeta();
    window.setTimeout(() => {
      entry.card.remove();
      syncActivityVisibility();
      syncTurnProgress();
      refreshRunningActivityLabel();
    }, 4000);
  } else {
    entry.card.classList.remove("tool-card-running");
    entry.card.classList.add("tool-card-done");
    entry.card.querySelector(".tool-card-dot")?.classList.add("tool-card-dot-done");
    entry.status = "done";
    refreshRunningActivityLabel();
  }

  syncTurnProgress();
  syncActivityVisibility();
}

function refreshRunningActivityLabel() {
  for (const entry of toolCards.values()) {
    if (entry.status !== "running") continue;
    const summary = toolSummary(entry.name, entry.input);
    currentActivityLabel = summary.detail
      ? `${summary.title}：${summary.detail}`
      : summary.title;
    updateBusyMeta();
    return;
  }
  if (store.get("isBusy")) {
    currentActivityLabel = "继续处理中，请稍候…";
    updateBusyMeta();
  }
}

function clearToolCards() {
  for (const { card } of toolCards.values()) {
    card.remove();
  }
  toolCards.clear();
  activeTurn?.activity?.querySelectorAll(".turn-progress").forEach((el) => el.remove());
  syncActivityVisibility();
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
      bubble = beginAssistantTurn();
    }
    const current = softenStreamGlue(
      appendMarkdownSegment(store.get("activeMarkdown"), payload.text),
    );
    store.set("activeMarkdown", current);
    renderMarkdown(bubble, current);
    scrollToBottom(false);
    if (store.get("isBusy")) syncTurnProgress();
  });

  window.assistantClient.onDone(async (payload) => {
    const sid = store.get("activeSessionId");
    if (payload.sessionId && payload.sessionId !== sid) return;

    clearToolCards();
    currentActivityLabel = "";

    const bubble = store.get("activeBubble");
    if (bubble) {
      bubble.classList.remove("pending");
      const md = store.get("activeMarkdown");
      if (!md.trim() && !bubble.textContent.trim()) {
        renderMarkdown(bubble, "已完成。");
      }
    }
    finishActiveTurn();
    store.set("isBusy", false);
    setBusyUI(false);
    syncTurnProgress();
    $("promptInput")?.focus();

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

    clearToolCards();

    let bubble = store.get("activeBubble");
    if (!bubble) bubble = beginAssistantTurn();
    bubble.classList.remove("pending");
    renderMarkdown(bubble, error.message || "处理请求时遇到问题。");
    finishActiveTurn();
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
      updateTopbarTitles();
      // Flatten sessions for backward compat
      const allSessions = [];
      for (const p of state.projects || []) {
        for (const s of p.sessions || []) {
          allSessions.push(s);
        }
      }
      store.set("sessions", allSessions);
      if (state.conversation) store.set("conversation", state.conversation);
      updateTopbarTitles();
    }
  } catch {}
}

function updateWorkingDir(path) {
  const el = $("workingDir");
  if (el) el.textContent = path || "--";
}

function setBusyUI(busy) {
  for (const id of ["sendBtn", "promptInput", "attachBtn", "newSessionBtn"]) {
    const el = $(id);
    if (el) el.disabled = busy;
  }

  const interruptBtn = $("interruptBtn");
  if (interruptBtn) interruptBtn.hidden = !busy;

  if (busy) {
    syncTurnProgress();
    updateBusyMeta();
  } else {
    currentActivityLabel = "";
  }

  const meta = $("sessionMeta");
  if (meta && !busy) {
    const project = activeProject();
    meta.textContent = project?.name ? `文件夹：${project.name}` : "已就绪";
  }

  const badge = $("statusBadge");
  if (badge) {
    badge.textContent = busy ? "回复中" : "就绪";
    badge.className = `status-badge ${busy ? "running" : "idle"}`;
  }

  const cliState = $("statusCliState");
  if (cliState) cliState.textContent = `助手：${busy ? "回复中" : "就绪"}`;
}
