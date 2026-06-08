/**
 * Chat UI — runtime-event driven Assistant Turn Article renderer.
 */

import store from "./state.js";
import { $, scrollToBottom, scrollToBottomAfterLayout, bindPanelScroll, initScrollToBottom, isNearBottom } from "./dom.js";
import { t } from "../i18n/index.js";
import {
  applyRuntimeBatch,
  getRuntimeSession,
  subscribeRuntime,
  canSend,
  canInterrupt,
} from "./session-runtime-store.js";
import {
  liveTurnFromRecord,
  legacyLiveTurnFromMessage,
  renderSealedTurnArticle,
  createLiveTurnArticleShell,
  renderLiveTurnArticle,
} from "./turn-view-renderer.js";
import { updateSessionRunningIndicators } from "./project-tree.js";
import { updateTopbarTitles } from "./session-chrome.js";
import { renderMessageQueue } from "./composer.js";
import { addDiffEntry } from "./diff-panel.js";
import { syncWorkbenchEmptyState } from "./workbench-empty.js";

const sessionViews = new Map();
const renderedMessageKeys = new Map();
const liveRenderTimers = new Map();
const LIVE_RENDER_THROTTLE_MS = 300;
let runtimeHeartbeat = null;
const lastRuntimeVisualSig = new Map();

function runtimeVisualSig(runtime) {
  const live = runtime.liveTurn;
  if (!live) return `idle:${runtime.phase}:${runtime.committedMessages.length}`;
  const toolSig = [...(live.tools || new Map()).values()]
    .map((tool) => `${tool.id}:${tool.status || ""}`)
    .join(",");
  const elapsed = live.final
    ? 0
    : Math.floor((Date.now() - (Number(live.startedAt) || Date.now())) / 1000);
  return [
    live.turnId,
    live.phase,
    live.final?.type || "",
    live.assistantText?.length || 0,
    live.thinkingText?.length || 0,
    live.activityLabel || "",
    live.timeline?.length || 0,
    toolSig,
    elapsed,
    live.permissions?.size || 0,
    live.questions?.size || 0,
    live.hooks?.size || 0,
    runtime.queue?.length || 0,
  ].join("|");
}

function scheduleLiveRender(sessionId) {
  if (!sessionId || liveRenderTimers.has(sessionId)) return;
  liveRenderTimers.set(sessionId, setTimeout(() => {
    liveRenderTimers.delete(sessionId);
    renderRuntimeSession(sessionId);
  }, LIVE_RENDER_THROTTLE_MS));
}

function shouldThrottleLiveRender(sessionId) {
  const runtime = getRuntimeSession(sessionId);
  return Boolean(
    runtime.liveTurn &&
    !runtime.liveTurn.final &&
    ["starting", "streaming", "tool_running"].includes(runtime.phase),
  );
}

function renderRuntimeForSession(sessionId) {
  if (shouldThrottleLiveRender(sessionId)) scheduleLiveRender(sessionId);
  else renderRuntimeSession(sessionId);
}

function stackEl() {
  return $("sessionMessagesStack");
}

function isActiveSession(sessionId) {
  return store.get("activeSessionId") === sessionId;
}

function view(sessionId) {
  if (!sessionViews.has(sessionId)) {
    sessionViews.set(sessionId, {
      sessionId,
      panel: null,
      listEl: null,
      liveArticles: new Map(),
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
  listEl.className = "messages runtime-messages";
  panel.appendChild(listEl);
  root.appendChild(panel);
  bindPanelScroll(panel);
  panel.addEventListener(
    "scroll",
    () => {
      if (!panel.classList.contains("is-active")) return;
      if (panel.scrollTop > 80) return;
      void import("./session-chrome.js").then((m) =>
        m.loadOlderConversationForSession?.(sessionId, panel),
      );
    },
    { passive: true },
  );

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
  syncWorkbenchEmptyState(view(sessionId).listEl);
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
  renderedMessageKeys.delete(sessionId);
}

export function shouldPreserveSessionView(sessionId) {
  const v = view(sessionId);
  if ([...v.liveArticles.values()].some((article) => article?.isConnected)) return true;
  return Boolean(v.listEl?.querySelector(".runtime-user-message, .assistant-turn-article"));
}

export function resumeLiveSessionUi(sessionId, opts = {}) {
  renderRuntimeSession(sessionId);
  const runtime = getRuntimeSession(sessionId);
  if (runtime.liveTurn || !canSend(sessionId)) {
    void refreshRuntimeSnapshot(sessionId);
  }
  syncComposerForActiveSession();
  if (opts.forceScrollBottom) scrollToBottomAfterLayout(view(sessionId).panel, true);
}

async function refreshRuntimeSnapshot(sessionId) {
  if (!sessionId || !window.assistantClient?.getRuntimeSnapshot) return;
  try {
    const snap = await window.assistantClient.getRuntimeSnapshot(sessionId);
    if (snap?.runtime?.recent?.length) {
      applyRuntimeBatch({
        sessionId,
        batchSeq: snap.runtime.batchSeq || 0,
        events: snap.runtime.recent,
      }, { allowReplay: true });
    }
  } catch {
    // Runtime events are live; snapshot replay is a repair path only.
  }
}

function messageKey(message, index) {
  return (message.turnId ? `${message.role}:${message.turnId}` : null) || message.id || `${message.role}:${message.timestamp || index}:${index}`;
}

export function renderConversation(sessionId, opts = {}) {
  const v = ensurePanel(sessionId);
  if (!v.listEl) return;
  if (opts.force) {
    v.listEl.replaceChildren();
    v.liveArticles.clear();
    renderedMessageKeys.set(sessionId, new Set());
    lastRuntimeVisualSig.delete(sessionId);
  }

  const pendingCount = renderCommittedMessages(sessionId, {
    onComplete: opts.forceScrollBottom
      ? () => scrollToBottomAfterLayout(v.panel, true)
      : null,
  });
  renderRuntimeSession(sessionId, { preserveScroll: Boolean(opts.preserveScroll) });
  syncWorkbenchEmptyState(v.listEl);
  if (opts.forceScrollBottom && pendingCount === 0) {
    scrollToBottomAfterLayout(v.panel, true);
  }
}

const COMMITTED_RENDER_CHUNK = 5;

function appendCommittedMessage(sessionId, runtime, message) {
  const anchor = committedInsertAnchor(sessionId, runtime);
  if (message.role === "user") appendUserMessage(sessionId, message, anchor);
  else if (message.role === "assistant") {
    if (message.turnId && runtime.liveTurn?.turnId === message.turnId) return;
    appendFinalAssistantArticle(sessionId, message, anchor);
  }
}

function committedInsertAnchor(sessionId, runtime) {
  if (!runtime.liveTurn?.turnId) return null;
  const article = view(sessionId).liveArticles.get(runtime.liveTurn.turnId);
  return article?.isConnected ? article : null;
}

function renderCommittedMessages(sessionId, opts = {}) {
  const runtime = getRuntimeSession(sessionId);
  const keys = renderedMessageKeys.get(sessionId) || new Set();
  renderedMessageKeys.set(sessionId, keys);

  const pending = [];
  for (const [index, message] of runtime.committedMessages.entries()) {
    const key = messageKey(message, index);
    if (keys.has(key)) continue;
    pending.push({ key, message });
  }
  if (pending.length === 0) return 0;

  if (pending.length <= COMMITTED_RENDER_CHUNK) {
    for (const { key, message } of pending) {
      keys.add(key);
      appendCommittedMessage(sessionId, runtime, message);
    }
    opts.onComplete?.();
    return pending.length;
  }

  let cursor = 0;
  const pump = () => {
    const end = Math.min(cursor + COMMITTED_RENDER_CHUNK, pending.length);
    for (; cursor < end; cursor++) {
      const { key, message } = pending[cursor];
      keys.add(key);
      appendCommittedMessage(sessionId, runtime, message);
    }
    if (cursor < pending.length) {
      requestAnimationFrame(pump);
    } else {
      syncWorkbenchEmptyState(ensurePanel(sessionId).listEl);
      opts.onComplete?.();
    }
  };
  pump();
  return pending.length;
}

function appendUserMessage(sessionId, message, beforeNode = null) {
  const v = ensurePanel(sessionId);
  const article = document.createElement("article");
  article.className = "msg msg-user runtime-user-message";

  const label = document.createElement("p");
  label.className = "runtime-user-label";
  label.textContent = t("message.userTaskLabel");

  const body = document.createElement("div");
  body.className = "runtime-user-body";
  body.textContent = message.content || "";
  renderFiles(body, message.files || []);

  article.append(label, body);
  if (beforeNode && v.listEl?.contains(beforeNode)) v.listEl.insertBefore(article, beforeNode);
  else v.listEl?.appendChild(article);
}

function appendFinalAssistantArticle(sessionId, message, beforeNode = null) {
  const v = ensurePanel(sessionId);
  const liveTurn = message.record
    ? liveTurnFromRecord(message.record)
    : legacyLiveTurnFromMessage(message);
  const article = renderSealedTurnArticle(liveTurn, Boolean(message.failed));
  if (beforeNode && v.listEl?.contains(beforeNode)) v.listEl.insertBefore(article, beforeNode);
  else v.listEl?.appendChild(article);
}

function renderFiles(container, files) {
  if (!files?.length) return;
  const wrap = document.createElement("div");
  wrap.className = "runtime-message-files";
  for (const file of files) {
    const chip = document.createElement("span");
    chip.className = "runtime-message-file";
    chip.textContent = file.name || file.path || "file";
    wrap.appendChild(chip);
  }
  container.appendChild(wrap);
}

function ensureLiveArticle(sessionId, liveTurn) {
  const v = ensurePanel(sessionId);
  let article = v.liveArticles.get(liveTurn.turnId);
  if (article) return article;

  article = createLiveTurnArticleShell(liveTurn);
  v.liveArticles.set(liveTurn.turnId, article);
  v.listEl?.appendChild(article);
  return article;
}

function renderRuntimeSession(sessionId, opts = {}) {
  const runtime = getRuntimeSession(sessionId);
  const sig = runtimeVisualSig(runtime);
  if (!opts.force && lastRuntimeVisualSig.get(sessionId) === sig) return;
  lastRuntimeVisualSig.set(sessionId, sig);

  const panel = view(sessionId).panel;
  const shouldFollow = !opts.preserveScroll && isActiveSession(sessionId) && isNearBottom(panel);
  renderCommittedMessages(sessionId);
  if (runtime.liveTurn) renderLiveTurn(sessionId, runtime.liveTurn, runtime.queue);
  syncWorkbenchEmptyState(view(sessionId).listEl);
  syncComposerForActiveSession();
  updateSessionRunningIndicators();
  updateTopbarTitles();
  if (shouldFollow) scrollToBottomAfterLayout(panel, true);
}

function renderLiveTurn(sessionId, liveTurn, queue) {
  const article = ensureLiveArticle(sessionId, liveTurn);
  renderLiveTurnArticle(article, liveTurn, { sessionId, queue });
}

export function createMessage(sessionId, role, text = "", files = null, options = null) {
  const message = { role, content: text, files, failed: Boolean(options?.failed) };
  if (role === "user") appendUserMessage(sessionId, message);
  else appendFinalAssistantArticle(sessionId, message);
}

export function getQueuedMessageCount(sessionId) {
  return getRuntimeSession(sessionId).queue.length;
}

export function hasPendingUserQuestion(sessionId) {
  const live = getRuntimeSession(sessionId).liveTurn;
  return Boolean(live && live.questions.size > 0);
}

export async function respondPendingUserQuestionFromComposer(sessionId, text) {
  const live = getRuntimeSession(sessionId).liveTurn;
  const first = live ? [...live.questions.values()][0] : null;
  if (!first) return { ok: false, error: "NO_PENDING_QUESTION" };
  return window.assistantClient.respondUserQuestion(sessionId, first.requestId, { answer: text }, text);
}

export function refreshWorkbenchEmptyForActiveSession() {
  const sid = store.get("activeSessionId");
  if (!sid) return;
  const listEl = view(sid).listEl;
  if (!listEl?.querySelector(".workbench-empty")) return;
  listEl.querySelector(".workbench-empty")?.remove();
  syncWorkbenchEmptyState(listEl);
}

export function syncComposerForActiveSession() {
  const sid = store.get("activeSessionId");
  const busy = sid ? !canSend(sid) : false;
  store.set("isBusy", busy);
  store.set("runningSessionId", busy ? sid : null);
  $("composer")?.classList.toggle("composer-busy", busy);
  const input = $("promptInput");
  const submit = $("sendBtn");
  const interrupt = $("interruptBtn");
  if (input) {
    input.placeholder = busy
      ? (canInterrupt(sid) ? t("composer.placeholderBusy") : t("composer.placeholderWaiting"))
      : t("composer.placeholder");
  }
  if (submit) submit.disabled = false;
  if (interrupt) interrupt.hidden = !busy;
  if (sid) renderMessageQueue(sid, getRuntimeSession(sid).queue);
}

export function initMessageUi() {
  initScrollToBottom();
  if (!runtimeHeartbeat) {
    runtimeHeartbeat = setInterval(() => {
      const sid = store.get("activeSessionId");
      if (!sid) return;
      const runtime = getRuntimeSession(sid);
      if (runtime.liveTurn && !runtime.liveTurn.final) {
        const sig = runtimeVisualSig(runtime);
        if (lastRuntimeVisualSig.get(sid) !== sig) renderRuntimeSession(sid);
      }
    }, 1000);
  }
}

export function wireMessageIpc() {
  window.assistantClient.onRuntimeEvents?.((batch) => {
    applyRuntimeBatch(batch);
  });
  window.assistantClient.onFileDiff?.((entry) => {
    if (entry?.sessionId) addDiffEntry(entry.sessionId, entry);
    const sid = entry?.sessionId || store.get("activeSessionId");
    if (sid) {
      lastRuntimeVisualSig.delete(sid);
      renderRuntimeSession(sid);
    }
  });
  subscribeRuntime(() => {
    for (const sessionId of sessionViews.keys()) renderRuntimeForSession(sessionId);
  });
}
