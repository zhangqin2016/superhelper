/**
 * Chat UI — runtime-event driven Assistant Turn Article renderer.
 */

import store from "./state.js";
import { $, scrollToBottom, scrollToBottomAfterLayout, bindPanelScroll, initScrollToBottom, isNearBottom } from "./dom.js";
import { shouldLoadOlderOnScroll } from "./scroll-geometry.js";
import { t } from "../i18n/index.js";
import {
  applyRuntimeBatch,
  getRuntimeSession,
  syncCommittedMessages,
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
import { collectUnrenderedCommittedMessages } from "./message-render-keys.js";

const sessionViews = new Map();
const renderedMessageKeys = new Map();
const liveRenderTimers = new Map();
const LIVE_RENDER_THROTTLE_MS = 150;
let runtimeHeartbeat = null;
const lastRuntimeVisualSig = new Map();

function runtimeVisualSig(runtime) {
  const live = runtime.liveTurn;
  if (!live) return `idle:${runtime.phase}:${runtime.committedMessages.length}`;
  const toolSig = [...(live.tools || new Map()).values()]
    .map((tool) => `${tool.id}:${tool.status || ""}`)
    .join(",");
  // NOTE: deliberately NOT keyed on elapsed time. The live turn does not show a
  // per-second clock, so including a ticking elapsed value here forced a full
  // re-render (and scroll-to-bottom) every second — visible as the timeline
  // jittering up and down during execution even when nothing was streaming.
  // The signature must change only when something on screen actually changes.
  return [
    live.turnId,
    live.phase,
    live.final?.type || "",
    live.assistantText?.length || 0,
    live.thinkingText?.length || 0,
    live.activityLabel || "",
    live.timeline?.length || 0,
    toolSig,
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
      renderGeneration: 0,
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
      if (!shouldLoadOlderOnScroll(panel)) return;
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

export function renderConversation(sessionId, opts = {}) {
  const v = ensurePanel(sessionId);
  if (!v.listEl) return;
  if (opts.force) {
    v.renderGeneration += 1;
    v.listEl.replaceChildren();
    v.liveArticles.clear();
    renderedMessageKeys.set(sessionId, new Set());
    lastRuntimeVisualSig.delete(sessionId);
  }

  const pendingCount = renderCommittedMessages(sessionId, {
    preserveScroll: Boolean(opts.preserveScroll),
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
const COMMITTED_INITIAL_WINDOW = 80;
const COMMITTED_WINDOW_THRESHOLD = 160;

function committedMessagesForRender(messages = [], opts = {}) {
  if (!Array.isArray(messages)) return [];
  if (opts.preserveScroll) return messages;
  if (messages.length <= COMMITTED_WINDOW_THRESHOLD) return messages;
  return messages.slice(-COMMITTED_INITIAL_WINDOW);
}

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

  const renderMessages = committedMessagesForRender(runtime.committedMessages, opts);
  const pending = collectUnrenderedCommittedMessages(renderMessages, keys);
  if (pending.length === 0) return 0;

  if (pending.length <= COMMITTED_RENDER_CHUNK) {
    for (const { message } of pending) {
      appendCommittedMessage(sessionId, runtime, message);
    }
    opts.onComplete?.();
    return pending.length;
  }

  let cursor = 0;
  const generation = view(sessionId).renderGeneration;
  const pump = () => {
    if (view(sessionId).renderGeneration !== generation) return;
    const end = Math.min(cursor + COMMITTED_RENDER_CHUNK, pending.length);
    for (; cursor < end; cursor++) {
      const { message } = pending[cursor];
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

  // Re-edit: copies the text back into the composer (no conversation rewind —
  // the edited text is sent as a new message).
  if (String(message.content || "").trim()) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "runtime-user-edit";
    edit.textContent = t("message.reEdit");
    edit.addEventListener("click", () => {
      const input = $("promptInput");
      if (!input) return;
      input.value = message.content || "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    article.appendChild(edit);
  }

  article.append(label, body);
  if (beforeNode && v.listEl?.contains(beforeNode)) v.listEl.insertBefore(article, beforeNode);
  else v.listEl?.appendChild(article);
}

function appendFinalAssistantArticle(sessionId, message, beforeNode = null) {
  if (message?.meta?.scheduledDraft) {
    appendScheduledDraftArticle(sessionId, message, beforeNode);
    return;
  }
  const v = ensurePanel(sessionId);
  const liveTurn = message.record
    ? liveTurnFromRecord(message.record)
    : legacyLiveTurnFromMessage(message);
  const article = renderSealedTurnArticle(liveTurn, Boolean(message.failed));
  appendArticleActions(article, sessionId, message);
  if (beforeNode && v.listEl?.contains(beforeNode)) v.listEl.insertBefore(article, beforeNode);
  else v.listEl?.appendChild(article);
}

const COPY_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5h-6a1 1 0 0 0-1 1v6"/></svg>';
const COPIED_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>';

// A small right-aligned icon row under the answer (room for export-PDF etc.
// later). Always visible but visually muted — hover discovery does not work
// for non-technical users.
function appendArticleActions(article, sessionId, message) {
  const actions = document.createElement("div");
  actions.className = "assistant-article-actions";
  if (message.failed) actions.appendChild(buildRetryAction(sessionId, message));
  const copyText = String(message.content || "").trim();
  if (copyText) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "assistant-icon-btn assistant-copy-answer-btn";
    copy.title = t("message.copyAnswer");
    copy.setAttribute("aria-label", t("message.copyAnswer"));
    copy.innerHTML = COPY_ICON_SVG;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(copyText);
        copy.innerHTML = COPIED_ICON_SVG;
        copy.classList.add("is-done");
        setTimeout(() => {
          copy.innerHTML = COPY_ICON_SVG;
          copy.classList.remove("is-done");
        }, 1500);
      } catch {
        showScheduledToast(t("common.copyFailed"), "warning");
      }
    });
    actions.appendChild(copy);
  }
  if (actions.childElementCount) article.appendChild(actions);
}

// A failed turn must offer a one-click retry. Retrying replays the LAST user
// message, so the button verifies at click time that this is still the
// newest committed message.
function buildRetryAction(sessionId, message) {
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "assistant-action-btn assistant-retry-btn";
  retry.textContent = t("turn.retry");
  retry.addEventListener("click", async () => {
    const committed = getRuntimeSession(sessionId).committedMessages;
    const last = committed[committed.length - 1];
    if (last !== message && (last?.turnId == null || last.turnId !== message.turnId)) {
      showScheduledToast(t("turn.retryStale"), "warning");
      retry.remove();
      return;
    }
    retry.disabled = true;
    try {
      const result = await window.assistantClient.retryLastMessage(sessionId);
      if (result?.ok) {
        retry.remove();
      } else {
        retry.disabled = false;
        showScheduledToast(result?.detail || result?.error || t("turn.retryFailed"), "error");
      }
    } catch (err) {
      retry.disabled = false;
      showScheduledToast(err?.message || t("turn.retryFailed"), "error");
    }
  });
  return retry;
}

function formatScheduleDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function appendScheduledDraftArticle(sessionId, message, beforeNode = null) {
  const v = ensurePanel(sessionId);
  const scheduled = message.meta.scheduledDraft || {};
  const draft = scheduled.draft || {};
  const created = scheduled.status === "created";

  const article = document.createElement("article");
  article.className = "assistant-turn-article scheduled-draft-article";
  article.dataset.messageId = message.id || "";

  const shell = document.createElement("div");
  shell.className = "scheduled-draft-chat-card";

  const title = document.createElement("div");
  title.className = "scheduled-draft-title";
  title.textContent = created ? t("scheduled.cardCreatedTitle") : t("scheduled.cardTitle");
  shell.appendChild(title);

  const rows = document.createElement("div");
  rows.className = "scheduled-draft-rows";
  appendScheduledDraftRow(rows, t("scheduled.previewTitle"), draft.title || t("scheduled.untitled"));
  appendScheduledDraftRow(rows, t("scheduled.previewSchedule"), draft.scheduleText || "");
  appendScheduledDraftRow(rows, t("scheduled.previewNextRun"), formatScheduleDateTime(draft.nextRunAt || scheduled.task?.nextRunAt));
  appendScheduledDraftRow(rows, t("scheduled.previewScope"), t("scheduled.previewScopeValue"));
  shell.appendChild(rows);

  const actions = document.createElement("div");
  actions.className = "scheduled-draft-actions";

  if (created) {
    const pill = document.createElement("span");
    pill.className = "scheduled-draft-pill";
    pill.textContent = t("scheduled.created");
    actions.appendChild(pill);
  } else {
    const create = document.createElement("button");
    create.type = "button";
    create.className = "button-primary";
    create.textContent = t("scheduled.cardCreate");
    create.addEventListener("click", () => void createScheduledDraftFromMessage(sessionId, message.id, create));
    actions.appendChild(create);
  }
  shell.appendChild(actions);

  article.appendChild(shell);
  if (beforeNode && v.listEl?.contains(beforeNode)) v.listEl.insertBefore(article, beforeNode);
  else v.listEl?.appendChild(article);
}

function appendScheduledDraftRow(container, label, value) {
  if (!value) return;
  const row = document.createElement("div");
  row.className = "scheduled-draft-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value;
  row.append(key, val);
  container.appendChild(row);
}

async function createScheduledDraftFromMessage(sessionId, messageId, button) {
  if (!sessionId || !messageId || !window.assistantClient?.createScheduledTaskFromDraftMessage) return;
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = t("scheduled.creating");
  }
  try {
    const result = await window.assistantClient.createScheduledTaskFromDraftMessage({
      sessionId,
      messageId,
    });
    if (!result?.ok) {
      showScheduledToast(t("scheduled.createFailed"), "error");
      return;
    }
    if (Array.isArray(result.conversation)) {
      syncCommittedMessages(sessionId, result.conversation);
      renderConversation(sessionId, { force: true, forceScrollBottom: true });
    }
    showScheduledToast(t("scheduled.created"), "success");
  } catch (error) {
    showScheduledToast(error?.message || t("scheduled.createFailed"), "error");
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function showScheduledToast(message, type) {
  void import("./toast.js").then((m) => m.showToast?.(message, type));
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

/** Fallback re-render for the active session at most once/sec, in case a render
 *  was missed. Only runs WHILE the active session has a live turn — started and
 *  stopped on demand instead of ticking forever. */
function manageHeartbeat() {
  const sid = store.get("activeSessionId");
  const live = sid && (() => {
    const lt = getRuntimeSession(sid).liveTurn;
    return lt && !lt.final;
  })();
  if (live && !runtimeHeartbeat) {
    runtimeHeartbeat = setInterval(() => {
      const s = store.get("activeSessionId");
      if (!s) return;
      const runtime = getRuntimeSession(s);
      if (runtime.liveTurn && !runtime.liveTurn.final) {
        const sig = runtimeVisualSig(runtime);
        if (lastRuntimeVisualSig.get(s) !== sig) renderRuntimeSession(s);
      } else {
        manageHeartbeat(); // turn ended → stop ticking
      }
    }, 1000);
  } else if (!live && runtimeHeartbeat) {
    clearInterval(runtimeHeartbeat);
    runtimeHeartbeat = null;
  }
}

export function initMessageUi() {
  initScrollToBottom();
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
    // Only re-render the ACTIVE session's live turn. Background (hidden) sessions
    // would otherwise run morphdom off-screen on every event for no visible gain;
    // they re-render from committed + live state when switched to (applySessionSwitch).
    const activeId = store.get("activeSessionId");
    if (activeId && sessionViews.has(activeId)) renderRuntimeForSession(activeId);
    manageHeartbeat();
    // Status dots must still refresh for ALL sessions — including a BACKGROUND
    // session finishing while another is viewed — so the sidebar shows done/failed
    // instead of a stuck "processing". Cheap: it only toggles classes on the dots.
    updateSessionRunningIndicators();
  });
}
