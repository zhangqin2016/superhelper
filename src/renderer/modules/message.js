/**
 * Chat UI — one message panel per session (Claude Code App style).
 */

import store from "./state.js";
import {
  $,
  scrollToBottom,
  scrollToBottomAfterLayout,
  bindPanelScroll,
  initScrollToBottom,
} from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { activeProject, updateTopbarTitles } from "./session-chrome.js";
import {
  isSessionRunning,
  setSessionRunning,
  syncRunningFromState,
  isActiveSessionBusy,
} from "./session-busy.js";

const stackEl = () => $("sessionMessagesStack");

/** @type {Map<string, {
 *   panel: HTMLElement,
 *   listEl: HTMLElement,
 *   activeTurn: { article: HTMLElement, activity: HTMLElement, bubble: HTMLElement } | null,
 *   toolCards: Map<string, { card: HTMLElement, name: string, input: object, status: string }>,
 *   activeMarkdown: string,
 *   activeBubble: HTMLElement | null,
 *   activityLabel: string,
 * }>} */
const sessionViews = new Map();

function isActiveSession(sessionId) {
  return store.get("activeSessionId") === sessionId;
}

function view(sessionId) {
  if (!sessionViews.has(sessionId)) {
    sessionViews.set(sessionId, {
      panel: null,
      listEl: null,
      activeTurn: null,
      toolCards: new Map(),
      activeMarkdown: "",
      activeBubble: null,
      activityLabel: "",
    });
  }
  return sessionViews.get(sessionId);
}

function ensurePanel(sessionId) {
  const v = view(sessionId);
  if (v.panel) return v;

  const root = stackEl();
  if (!root) return v;

  const panel = document.createElement("div");
  panel.className = "session-messages";
  panel.dataset.sessionId = sessionId;
  panel.setAttribute("aria-hidden", "true");

  const listEl = document.createElement("div");
  listEl.className = "messages";
  panel.appendChild(listEl);

  root.appendChild(panel);
  bindPanelScroll(panel);

  v.panel = panel;
  v.listEl = listEl;
  return v;
}

export function showSessionMessages(sessionId) {
  if (!sessionId) return;
  ensurePanel(sessionId);

  for (const el of stackEl()?.querySelectorAll(".session-messages") || []) {
    const active = el.dataset.sessionId === sessionId;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-hidden", active ? "false" : "true");
  }

  if (isActiveSession(sessionId)) {
    syncActiveStoreFromView(sessionId);
  }

  requestAnimationFrame(() => scrollToBottom(true, view(sessionId).panel));
}

export function hideAllSessionMessages() {
  for (const el of stackEl()?.querySelectorAll(".session-messages") || []) {
    el.classList.remove("is-active");
    el.setAttribute("aria-hidden", "true");
  }
}

export function removeSessionMessages(sessionId) {
  const v = sessionViews.get(sessionId);
  if (!v) return;
  v.panel?.remove();
  sessionViews.delete(sessionId);
}

function syncActiveStoreFromView(sessionId) {
  const v = view(sessionId);
  store.set("activeBubble", v.activeBubble);
  store.set("activeMarkdown", v.activeMarkdown);
}

function appendMarkdownSegment(prev, next) {
  const piece = String(next ?? "");
  if (!piece) return prev || "";
  const base = prev || "";
  if (!base) return piece;
  if (base.endsWith("\n") || piece.startsWith("\n")) return base + piece;
  return `${base}\n\n${piece}`;
}

function softenStreamGlue(text) {
  return String(text || "")
    .replace(/([。！？!?])([^\s\n\r])/g, "$1\n\n$2")
    .replace(/\.(?=[A-Z\u4e00-\u9fff])/g, ".\n\n");
}

export function createMessage(sessionId, role, text = "", files = null) {
  const v = ensurePanel(sessionId);
  const listEl = v.listEl;
  if (!listEl) return null;

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

  if (files?.length) {
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
  listEl.appendChild(wrapper);
  scrollToBottom(isActiveSession(sessionId), v.panel);
  return bubble;
}

/** Remove the last user bubble (optimistic send rolled back). */
export function removeLastUserMessage(sessionId) {
  const v = view(sessionId);
  const listEl = v.listEl;
  if (!listEl) return;
  const userMsgs = listEl.querySelectorAll(".msg-user");
  const last = userMsgs[userMsgs.length - 1];
  last?.remove();
  scrollToBottom(isActiveSession(sessionId), v.panel);
}

function getConversationForSession(sessionId) {
  for (const project of store.get("projects") || []) {
    const session = (project.sessions || []).find((s) => s.id === sessionId);
    if (session?.messages) return session.messages;
  }
  return store.get("conversation") || [];
}

export function hasLiveTurn(sessionId) {
  const v = view(sessionId);
  return Boolean(v.activeTurn);
}

/** Keep in-flight assistant UI when switching back (do not rebuild from history). */
export function shouldPreserveSessionView(sessionId) {
  return hasLiveTurn(sessionId);
}

export function resumeLiveSessionUi(sessionId) {
  if (!sessionId || hasLiveTurn(sessionId)) return;
  if (isSessionRunning(sessionId)) beginAssistantTurn(sessionId);
}

export function syncComposerForActiveSession() {
  const sid = store.get("activeSessionId");
  const hasProject = (store.get("projects") || []).length > 0;
  const busy = Boolean(sid && (isSessionRunning(sid) || hasLiveTurn(sid)));
  store.set("isBusy", busy);
  setBusyUI(busy);

  const promptInput = $("promptInput");
  const blocked = !hasProject || !sid;
  for (const id of ["sendBtn", "promptInput", "attachBtn"]) {
    const el = $(id);
    if (el) el.disabled = blocked || busy;
  }
  if (promptInput) {
    promptInput.placeholder = !hasProject
      ? "请先添加工作空间文件夹"
      : !sid
        ? "请先新建对话"
        : "有什么想问的？";
  }

  import("./project-tree.js")
    .then(({ updateSessionRunningIndicators }) => updateSessionRunningIndicators())
    .catch(() => {});
}

export function renderConversation(sessionId) {
  const sid = sessionId || store.get("activeSessionId");
  if (!sid) return;

  finishActiveTurn(sid);
  const v = ensurePanel(sid);
  if (!v.listEl) return;

  v.listEl.textContent = "";
  const conv = getConversationForSession(sid);

  if (!conv.length) {
    const project = activeProject();
    createMessage(
      sid,
      "assistant",
      project
        ? `当前文件夹：${project.name}。有什么想问的？`
        : "请先添加一个文件夹，然后开始聊天吧。",
    );
  } else {
    for (const msg of conv) {
      createMessage(
        sid,
        msg.role === "user" ? "user" : "assistant",
        msg.content,
        msg.files || null,
      );
    }
  }

  v.activeBubble = null;
  v.activeMarkdown = "";
  if (isActiveSession(sid)) syncActiveStoreFromView(sid);
  scrollToBottomAfterLayout(v.panel);
}

function countRunningTools(sessionId) {
  let n = 0;
  for (const entry of view(sessionId).toolCards.values()) {
    if (entry.status === "running") n++;
  }
  return n;
}

function updateBusyMeta(sessionId) {
  if (!isActiveSession(sessionId)) return;
  const meta = $("sessionMeta");
  if (!meta || !store.get("isBusy")) return;
  const label = view(sessionId).activityLabel;
  meta.textContent = label || "正在处理，请稍候…";
}

function syncTurnProgress(sessionId) {
  const v = view(sessionId);
  if (!v.activeTurn?.activity) return;

  const progress = v.activeTurn.activity.querySelector(".turn-progress");
  const waiting =
    isActiveSession(sessionId) &&
    store.get("isBusy") &&
    countRunningTools(sessionId) === 0;

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
      v.activeTurn.activity.appendChild(row);
    }
    v.activeTurn.activity.hidden = false;
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

function beginAssistantTurn(sessionId) {
  const v = view(sessionId);
  if (v.activeTurn) return v.activeTurn.bubble;

  const listEl = ensurePanel(sessionId).listEl;
  if (!listEl) return null;

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
  listEl.appendChild(article);

  v.activeTurn = { article, activity, bubble };
  v.activeBubble = bubble;
  v.activeMarkdown = "";
  if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
  scrollToBottom(false, v.panel);
  return bubble;
}

function finishActiveTurn(sessionId) {
  const v = view(sessionId);
  clearToolCards(sessionId);
  if (v.activeTurn?.activity) {
    v.activeTurn.activity.replaceChildren();
    v.activeTurn.activity.hidden = true;
  }
  v.activeTurn = null;
  v.activeBubble = null;
  v.activeMarkdown = "";
  if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
}

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

function syncActivityVisibility(sessionId) {
  const turn = view(sessionId).activeTurn;
  if (!turn) return;
  turn.activity.hidden = turn.activity.childElementCount === 0;
}

function addToolCard(sessionId, id, name, input) {
  if (!view(sessionId).activeTurn) beginAssistantTurn(sessionId);
  const v = view(sessionId);

  const summary = toolSummary(name, input);
  v.activityLabel = summary.detail
    ? `${summary.title}：${summary.detail}`
    : summary.title;
  updateBusyMeta(sessionId);

  const card = document.createElement("div");
  card.className = "tool-card tool-card-running";
  card.dataset.toolId = id;
  renderToolCardContent(card, name, input);

  v.activeTurn.activity.appendChild(card);
  v.activeTurn.activity.hidden = false;
  scrollToBottom(false, v.panel);
  v.toolCards.set(id, { card, name, input, status: "running" });
  syncTurnProgress(sessionId);
}

function updateToolCard(sessionId, id, status) {
  const v = view(sessionId);
  const entry = v.toolCards.get(id);
  if (!entry) return;

  if (status === "failed") {
    entry.card.classList.remove("tool-card-running");
    entry.card.classList.add("tool-card-failed");
    entry.card.querySelector(".tool-card-label").textContent =
      `${toolSummary(entry.name, entry.input).title}失败`;
    entry.status = "failed";
    v.toolCards.delete(id);
    v.activityLabel = "遇到问题，正在调整…";
    updateBusyMeta(sessionId);
    window.setTimeout(() => {
      entry.card.remove();
      syncActivityVisibility(sessionId);
      syncTurnProgress(sessionId);
      refreshRunningActivityLabel(sessionId);
    }, 4000);
  } else {
    entry.card.classList.remove("tool-card-running");
    entry.card.classList.add("tool-card-done");
    entry.card.querySelector(".tool-card-dot")?.classList.add("tool-card-dot-done");
    entry.status = "done";
    refreshRunningActivityLabel(sessionId);
  }

  syncTurnProgress(sessionId);
  syncActivityVisibility(sessionId);
}

function refreshRunningActivityLabel(sessionId) {
  const v = view(sessionId);
  for (const entry of v.toolCards.values()) {
    if (entry.status !== "running") continue;
    const summary = toolSummary(entry.name, entry.input);
    v.activityLabel = summary.detail
      ? `${summary.title}：${summary.detail}`
      : summary.title;
    updateBusyMeta(sessionId);
    return;
  }
  if (isActiveSession(sessionId) && store.get("isBusy")) {
    v.activityLabel = "继续处理中，请稍候…";
    updateBusyMeta(sessionId);
  }
}

function clearToolCards(sessionId) {
  const v = view(sessionId);
  for (const { card } of v.toolCards.values()) {
    card.remove();
  }
  v.toolCards.clear();
  v.activeTurn?.activity?.querySelectorAll(".turn-progress").forEach((el) => el.remove());
  syncActivityVisibility(sessionId);
}

export function wireMessageIpc() {
  window.assistantClient.onTool((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    addToolCard(sessionId, payload.id, payload.name, payload.input);
  });

  window.assistantClient.onToolDone((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    updateToolCard(sessionId, payload.id, payload.status);
  });

  window.assistantClient.onChunk((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    const v = view(sessionId);

    let bubble = v.activeBubble;
    if (!bubble) {
      bubble = beginAssistantTurn(sessionId);
    }
    v.activeMarkdown = softenStreamGlue(
      appendMarkdownSegment(v.activeMarkdown, payload.text),
    );
    renderMarkdown(bubble, v.activeMarkdown);
    if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
    scrollToBottom(false, v.panel);
    if (isActiveSession(sessionId) && store.get("isBusy")) {
      syncTurnProgress(sessionId);
    }
  });

  window.assistantClient.onDone(async (payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;

    clearToolCards(sessionId);
    view(sessionId).activityLabel = "";
    setSessionRunning(sessionId, false);

    const v = view(sessionId);
    if (v.activeBubble) {
      v.activeBubble.classList.remove("pending");
      if (!v.activeMarkdown.trim() && !v.activeBubble.textContent.trim()) {
        renderMarkdown(v.activeBubble, "已完成。");
      }
    }
    finishActiveTurn(sessionId);

    const { refreshStateLight } = await import("./session-chrome.js");
    await refreshStateLight({ reRenderActive: isActiveSession(sessionId) });

    if (isActiveSession(sessionId)) {
      $("promptInput")?.focus();
      syncComposerForActiveSession();
    }
  });

  window.assistantClient.onStatus((status) => {
    const sessionId = status.sessionId;
    if (!sessionId) return;
    const busy = status.state === "thinking";
    if (busy) {
      setSessionRunning(sessionId, true);
      if (!view(sessionId).activeBubble) beginAssistantTurn(sessionId);
    }
    if (isActiveSession(sessionId)) syncComposerForActiveSession();
    import("./project-tree.js")
      .then(({ updateSessionRunningIndicators }) => updateSessionRunningIndicators())
      .catch(() => {});
  });

  window.assistantClient.onError(async (error) => {
    const sessionId = error.sessionId;
    if (!sessionId) return;

    clearToolCards(sessionId);
    setSessionRunning(sessionId, false);

    let bubble = view(sessionId).activeBubble;
    if (!bubble) bubble = beginAssistantTurn(sessionId);
    bubble.classList.remove("pending");
    renderMarkdown(bubble, error.message || "处理请求时遇到问题。");
    finishActiveTurn(sessionId);

    const { refreshStateLight } = await import("./session-chrome.js");
    await refreshStateLight({ reRenderActive: isActiveSession(sessionId) });

    if (isActiveSession(sessionId)) syncComposerForActiveSession();
  });

  window.assistantClient.onFocusSession((payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    store.set("activeSessionId", sessionId);
    showSessionMessages(sessionId);
    renderConversation(sessionId);
    updateTopbarTitles();
  });
}

export function setBusyUI(busy) {
  for (const id of ["sendBtn", "promptInput", "attachBtn"]) {
    const el = $(id);
    if (el) el.disabled = busy;
  }

  const interruptBtn = $("interruptBtn");
  if (interruptBtn) interruptBtn.hidden = !busy;

  import("./project-tree.js")
    .then(({ updateSessionRunningIndicators }) => updateSessionRunningIndicators())
    .catch(() => {});

  const sid = store.get("activeSessionId");
  if (busy && sid) {
    syncTurnProgress(sid);
    updateBusyMeta(sid);
  } else if (sid) {
    view(sid).activityLabel = "";
  }

  const meta = $("sessionMeta");
  if (meta && !busy) {
    const project = activeProject();
    meta.textContent = project?.path
      ? project.path
      : project?.name
        ? `文件夹：${project.name}`
        : "已就绪";
  }
}

export function initMessageUi() {
  initScrollToBottom();
}
