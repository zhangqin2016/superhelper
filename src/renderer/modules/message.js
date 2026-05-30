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
import { renderMarkdown, renderMarkdownWithCache, clearHighlightCache } from "./markdown.js";
import { activeProject, updateTopbarTitles, refreshStateLight } from "./session-chrome.js";
import { t } from "../i18n/index.js";
import {
  isSessionRunning,
  setSessionRunning,
  syncRunningFromState,
  isActiveSessionBusy,
} from "./session-busy.js";
import { showToast } from "./toast.js";
import { updateSessionRunningIndicators } from "./project-tree.js";
import {
  addToolCard as addToolCardImpl,
  updateToolCard as updateToolCardImpl,
  clearToolCards as clearToolCardsImpl,
  syncTurnProgress as syncTurnProgressImpl,
  updateBusyMeta as updateBusyMetaImpl,
  countRunningTools,
} from "./tool-cards.js";

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

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const streamSettleTimers = new Map();

function clearStreamSettleTimer(sessionId) {
  const t = streamSettleTimers.get(sessionId);
  if (t) clearTimeout(t);
  streamSettleTimers.delete(sessionId);
}

/** @type {Map<string, ReturnType<typeof setInterval>>} */
const busyHeartbeats = new Map();

function clearBusyHeartbeat(sessionId) {
  const timer = busyHeartbeats.get(sessionId);
  if (timer) clearInterval(timer);
  busyHeartbeats.delete(sessionId);
}

/** Keep visible “still working” cues when the engine is silent (tools/subagents). */
function refreshBusyIndicators(sessionId) {
  if (!sessionId || !isSessionRunning(sessionId)) {
    clearBusyHeartbeat(sessionId);
    return;
  }

  if (!hasLiveTurn(sessionId)) {
    beginAssistantTurn(sessionId);
  }

  const v = view(sessionId);
  if (v.activeBubble) {
    v.activeBubble.classList.add("pending");
  }
  syncTurnProgress(sessionId);
  updateBusyMeta(sessionId);

  if (!busyHeartbeats.has(sessionId)) {
    busyHeartbeats.set(
      sessionId,
      setInterval(() => {
        if (!isSessionRunning(sessionId)) {
          clearBusyHeartbeat(sessionId);
          return;
        }
        refreshBusyIndicators(sessionId);
      }, 2500),
    );
  }
}

function scheduleStreamSettle(sessionId) {
  if (!sessionId) return;
  const v = view(sessionId);
  if (v.turnHadToolUse || countRunningTools(v.toolCards) > 0) return;

  clearStreamSettleTimer(sessionId);
  streamSettleTimers.set(
    sessionId,
    setTimeout(async () => {
      streamSettleTimers.delete(sessionId);
      if (!hasLiveTurn(sessionId) || !isSessionRunning(sessionId)) return;
      if (view(sessionId).turnHadToolUse || countRunningTools(v.toolCards) > 0) return;
      const md = view(sessionId).activeMarkdown?.trim();
      if (!md) return;
      try {
        await window.assistantClient.settleTurn(sessionId);
      } catch (err) {
        console.warn("[settle-turn]", err);
      }
    }, 12000),
  );
}

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
      turnHadToolUse: false,
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
  // 清理未完成的工具卡片
  for (const { card } of v.toolCards.values()) {
    card.remove();
  }
  v.toolCards.clear();
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

export function createMessage(sessionId, role, text = "", files = null, options = null) {
  const v = ensurePanel(sessionId);
  const listEl = v.listEl;
  if (!listEl) return null;

  const wrapper = document.createElement("article");
  wrapper.className = `msg msg-${role}`;
  if (options?.failed) wrapper.dataset.failed = "true";

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? t("message.user") : t("message.assistant");

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
      fi.textContent = f.isImage ? t("message.imagePrefix", { name: f.name }) : f.name;
      fc.appendChild(fi);
    }
    bubble.appendChild(fc);
  }

  wrapper.append(avatar, bubble);
  if (role === "assistant" && options?.failed) {
    attachRetryAction(wrapper, sessionId);
  }
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

/** Remove the last assistant bubble (before retry). */
export function removeLastAssistantMessage(sessionId) {
  const v = view(sessionId);
  const listEl = v.listEl;
  if (!listEl) return;
  const assistantMsgs = listEl.querySelectorAll(".msg-assistant:not(.msg-turn)");
  const last = assistantMsgs[assistantMsgs.length - 1];
  last?.remove();
  scrollToBottom(isActiveSession(sessionId), v.panel);
}

function retryErrorMessage(result) {
  if (result.detail) return result.detail;
  const key = `send.error.${result.error}`;
  const mapped = t(key);
  return mapped === key ? t("send.error.GENERIC") : mapped;
}

function attachRetryAction(article, sessionId) {
  if (!article || article.querySelector(".msg-retry-btn")) return;

  const row = document.createElement("div");
  row.className = "msg-actions";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-retry-btn";
  btn.textContent = t("message.retry");
  btn.addEventListener("click", () => {
    retryLastPrompt(sessionId).catch((err) => {
      console.error("[retry]", err);
    });
  });

  row.appendChild(btn);
  article.appendChild(row);
}

export async function retryLastPrompt(sessionId) {
  if (!sessionId) return;
  if (isSessionRunning(sessionId) || hasLiveTurn(sessionId)) {
    showToast(t("send.error.BUSY"), "warning");
    return;
  }

  const result = await window.assistantClient.retryLastMessage(sessionId);
  if (!result.ok) {
    showToast(retryErrorMessage(result), "error");
    return;
  }

  removeLastAssistantMessage(sessionId);
  setSessionRunning(sessionId, true);
  beginAssistantTurn(sessionId);
  refreshBusyIndicators(sessionId);
  syncComposerForActiveSession();
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
  if (isSessionRunning(sessionId)) {
    beginAssistantTurn(sessionId);
    refreshBusyIndicators(sessionId);
  }
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
    promptInput.placeholder = busy
      ? t("composer.placeholderBusy")
      : !hasProject
        ? t("composer.placeholderNeedProject")
        : !sid
          ? t("composer.placeholderNeedSession")
          : t("composer.placeholder");
  }

  if (busy && sid) {
    refreshBusyIndicators(sid);
  } else if (sid) {
    clearBusyHeartbeat(sid);
  }

  updateSessionRunningIndicators();
}

export function renderConversation(sessionId) {
  clearHighlightCache();
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
        ? t("composer.placeholderWithProject", { name: project.name })
        : t("composer.placeholderEmpty"),
    );
  } else {
    for (const msg of conv) {
      createMessage(
        sid,
        msg.role === "user" ? "user" : "assistant",
        msg.content,
        msg.files || null,
        msg.failed ? { failed: true } : null,
      );
    }
  }

  v.activeBubble = null;
  v.activeMarkdown = "";
  if (isActiveSession(sid)) syncActiveStoreFromView(sid);
  scrollToBottomAfterLayout(v.panel);
}

// --- Tool card wrappers (delegate to tool-cards.js) ---

function addToolCard(sessionId, id, name, input) {
  if (!view(sessionId).activeTurn) beginAssistantTurn(sessionId);
  const v = view(sessionId);
  v.turnHadToolUse = true;
  clearStreamSettleTimer(sessionId);
  addToolCardImpl(v, id, name, input);
  updateBusyMeta(sessionId);
  syncTurnProgress(sessionId);
}

function updateToolCard(sessionId, id, status) {
  const v = view(sessionId);
  updateToolCardImpl(v, id, status);
}

function clearToolCards(sessionId) {
  const v = view(sessionId);
  clearToolCardsImpl(v);
}

function syncTurnProgress(sessionId) {
  const v = view(sessionId);
  syncTurnProgressImpl(v);
}

function updateBusyMeta(sessionId) {
  if (!store.get("isBusy")) return;
  const v = view(sessionId);
  updateBusyMetaImpl(v);
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
  avatar.textContent = t("message.assistant");

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
  v._lastRenderedLength = 0;
  v.activeBubble = bubble;
  v.activeMarkdown = "";
  v.turnHadToolUse = false;
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
  v._lastRenderedLength = 0;
  v.activeTurn = null;
  v.activeBubble = null;
  v.activeMarkdown = "";
  v.turnHadToolUse = false;
  if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
}


export function forceEndTurnUi(sessionId) {
  if (!sessionId) return;
  clearStreamSettleTimer(sessionId);
  clearBusyHeartbeat(sessionId);
  clearToolCards(sessionId);
  view(sessionId).activityLabel = "";
  setSessionRunning(sessionId, false);

  const v = view(sessionId);
  if (v.activeBubble) {
    v.activeBubble.classList.remove("pending");
  }
  finishActiveTurn(sessionId);
  syncComposerForActiveSession();
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
    scheduleStreamSettle(sessionId);
  });

  window.assistantClient.onChunk((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    const v = view(sessionId);

    let bubble = v.activeBubble;
    if (!bubble) {
      bubble = beginAssistantTurn(sessionId);
      if (!bubble) return;
    }

    v.activeMarkdown = softenStreamGlue(
      appendMarkdownSegment(v.activeMarkdown, payload.text),
    );

    const hasCodeFence = v.activeMarkdown.includes("```");
    const hasHtmlInNew = /<[a-zA-Z][^>]*>/.test(payload.text);
    const threshold = v.activeMarkdown.length - (v._lastRenderedLength || 0) > 200;

    if (hasCodeFence || hasHtmlInNew || threshold) {
      renderMarkdownWithCache(bubble, v.activeMarkdown);
      v._lastRenderedLength = v.activeMarkdown.length;
    } else {
      // 纯文本增量追加 — 不做 Markdown 解析
      if (bubble.textContent) {
        bubble.textContent += payload.text;
      } else {
        bubble.textContent = payload.text;
      }
    }

    if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
    scrollToBottom(false, v.panel);
    if (isActiveSession(sessionId) && store.get("isBusy")) {
      syncTurnProgress(sessionId);
    }
  });

  window.assistantClient.onDone(async (payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;

    clearStreamSettleTimer(sessionId);
    clearBusyHeartbeat(sessionId);
    clearToolCards(sessionId);
    view(sessionId).activityLabel = "";
    setSessionRunning(sessionId, false);

    const v = view(sessionId);
    if (v.activeBubble) {
      v.activeBubble.classList.remove("pending");
      if (!v.activeMarkdown.trim() && !v.activeBubble.textContent.trim()) {
        renderMarkdown(v.activeBubble, t("message.done"));
      }
    }
    finishActiveTurn(sessionId);

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
      refreshBusyIndicators(sessionId);
    }
    if (isActiveSession(sessionId)) syncComposerForActiveSession();
    updateSessionRunningIndicators();
  });

  window.assistantClient.onError(async (error) => {
    const sessionId = error.sessionId;
    if (!sessionId) return;

    clearStreamSettleTimer(sessionId);
    clearBusyHeartbeat(sessionId);
    clearToolCards(sessionId);
    setSessionRunning(sessionId, false);

    const v = view(sessionId);
    let bubble = v.activeBubble;
    if (!bubble) bubble = beginAssistantTurn(sessionId);
    bubble.classList.remove("pending");
    renderMarkdown(bubble, error.message || t("message.errorGeneric"));
    if (v.activeTurn?.article) {
      v.activeTurn.article.dataset.failed = "true";
      attachRetryAction(v.activeTurn.article, sessionId);
    }
    finishActiveTurn(sessionId);

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

  updateSessionRunningIndicators();

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
        ? t("app.folderLabel", { name: project.name })
        : t("app.ready");
  }
}

export function initMessageUi() {
  initScrollToBottom();
}
