/**
 * Chat UI — one message panel per session (Claude Code App style).
 */

import store from "./state.js";
import {
  $,
  scrollToBottom,
  scrollToBottomAfterLayout,
  scrollToBottomThrottled,
  bindPanelScroll,
  initScrollToBottom,
} from "./dom.js";
import {
  renderMarkdown,
  renderMarkdownWithCache,
  clearHighlightCache,
} from "./markdown.js";
import { activeProject, updateTopbarTitles, refreshStateLight } from "./session-chrome.js";
import { t } from "../i18n/index.js";
import {
  canSend,
  canInterrupt,
  getTurnPhase,
  getTurnId,
  applyTurnState as storeTurnState,
} from "./session-busy.js";
import { showToast } from "./toast.js";
import { renderMessageQueue } from "./composer.js";
import { createSessionEventApplier } from "./session-event-applier.js";
import { updateSessionRunningIndicators } from "./project-tree.js";
import {
  addToolCard as addToolCardImpl,
  addToolCardPlaceholder as addToolCardPlaceholderImpl,
  updateToolCardInput as updateToolCardInputImpl,
  finalizeToolCardInput as finalizeToolCardInputImpl,
  updateToolCard as updateToolCardImpl,
  clearTimeline as clearToolCardsImpl,
  collapseTimeline as collapseToolCardsImpl,
  updateToolCardProgress as updateToolCardProgressImpl,
  syncTurnProgress as syncTurnProgressImpl,
  refreshRunningActivityLabel,
  countRunningTools,
  toolSummary,
  syncActivityVisibility,
  addOrUpdateEngineNotice,
  engineNoticeText,
  finishTimeline as finishEngineNotices,
  addTextEntry,
  updateTextEntry,
  finalizeTextEntry,
} from "./turn-timeline.js";

const stackEl = () => $("sessionMessagesStack");

/** @type {Map<string, {
 *   panel: HTMLElement,
 *   listEl: HTMLElement,
 *   activeTurn: { article: HTMLElement, activity: HTMLElement, bubble: HTMLElement, queue: HTMLElement } | null,
 *   toolCards: Map<string, { card: HTMLElement, name: string, input: object, status: string }>,
 *   engineNotices: Map<string, { card: HTMLElement, code: string, status: string, payload?: object, startedAt?: number, timer?: ReturnType<typeof setInterval> | null }>,
 *   timeline: object | null,
 *   activeMarkdown: string,
 *   activeBubble: HTMLElement | null,
 *   activityLabel: string,
 *   activityLabelSource: string,
 *   turnStartedAt: number,
 * }>} */
const sessionViews = new Map();

/** @type {Map<string, ReturnType<typeof setInterval>>} */
const busyHeartbeats = new Map();
let turnStateWatchdog = null;

function clearBusyHeartbeat(sessionId) {
  const timer = busyHeartbeats.get(sessionId);
  if (timer) clearInterval(timer);
  busyHeartbeats.delete(sessionId);
}

/** Pending user messages waiting for the current turn to finish (Claude CLI queue). */
const queuedMessageCounts = new Map();
/** @type {Map<string, Array<{ index: number, preview: string, hasFiles: boolean }>>} */
const queuedMessageItems = new Map();

export function getQueuedMessageCount(sessionId) {
  if (!sessionId) return 0;
  return queuedMessageCounts.get(sessionId) || 0;
}

function setQueuedMessageCount(sessionId, count) {
  if (!sessionId) return;
  if (count > 0) queuedMessageCounts.set(sessionId, count);
  else queuedMessageCounts.delete(sessionId);
}

function setQueuedMessageItems(sessionId, items) {
  if (!sessionId) return;
  if (items?.length) queuedMessageItems.set(sessionId, items);
  else queuedMessageItems.delete(sessionId);
}

function renderInlineTurnQueue(sessionId, items = []) {
  const v = view(sessionId);
  const turn = v.activeTurn;
  if (!turn?.queue) return;

  if (!items.length) {
    turn.queue.hidden = true;
    turn.queue.replaceChildren();
    return;
  }

  turn.queue.hidden = false;
  turn.queue.replaceChildren();

  const header = document.createElement("div");
  header.className = "turn-queue-header";
  header.textContent = t("timeline.queuedTitle", { count: items.length });
  turn.queue.appendChild(header);

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "turn-queue-item";

    const badge = document.createElement("span");
    badge.className = "message-queue-badge";
    badge.textContent = t("composer.queueBadge");

    const text = document.createElement("span");
    text.className = "message-queue-preview";
    const preview =
      item.preview ||
      (item.hasFiles ? t("composer.queueAttachmentOnly") : t("composer.queueEmptyText"));
    text.textContent = preview;
    text.title = preview;

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "message-queue-remove";
    rm.innerHTML = "&times;";
    rm.title = t("composer.cancelQueued");
    rm.setAttribute("aria-label", t("composer.cancelQueued"));
    rm.addEventListener("click", async () => {
      try {
        const result = await window.assistantClient.cancelQueuedMessage(sessionId, item.index);
        if (!result?.ok) showToast(t("toast.queueCancelFailed"), "warning");
      } catch (err) {
        showToast(err?.message || t("toast.queueCancelFailed"), "error");
      }
    });

    row.append(badge, text, rm);
    turn.queue.appendChild(row);
  }
}

/** Keep visible “still working” cues when the engine is silent (tools/subagents). */
function refreshBusyIndicators(sessionId) {
  if (!sessionId || canSend(sessionId)) {
    clearBusyHeartbeat(sessionId);
    const inactive = sessionId ? view(sessionId).activeTurn?.article : null;
    inactive?.classList.remove("is-running");
    return;
  }

  if (!hasLiveTurn(sessionId)) {
    beginAssistantTurn(sessionId);
  }

  const v = view(sessionId);
  if (v.activeBubble) {
    v.activeBubble.classList.add("pending");
  }
  v.activeTurn?.article?.classList.add("is-running");
  syncTurnProgress(sessionId);

  if (!busyHeartbeats.has(sessionId)) {
    busyHeartbeats.set(
      sessionId,
      setInterval(() => {
        if (canSend(sessionId)) {
          clearBusyHeartbeat(sessionId);
          return;
        }
        refreshBusyIndicators(sessionId);
      }, 2500),
    );
  }
}

function isActiveSession(sessionId) {
  return store.get("activeSessionId") === sessionId;
}

function eventTurnId(payload) {
  return payload?.turnId ? String(payload.turnId) : null;
}

function view(sessionId) {
  if (!sessionViews.has(sessionId)) {
    sessionViews.set(sessionId, {
      panel: null,
      listEl: null,
      activeTurn: null,
      toolCards: new Map(),
      engineNotices: new Map(),
      timeline: null,
      activeMarkdown: "",
      activeBubble: null,
      activityLabel: "",
      activityLabelSource: "",
      turnStartedAt: 0,
      turnHadToolUse: false,
      sessionId,
    });
  }
  return sessionViews.get(sessionId);
}

function acceptLiveTurnEvent(sessionId, payload) {
  const incoming = eventTurnId(payload);
  if (!incoming) return true;
  const v = view(sessionId);
  if (!v.activeTurn) return true;
  if (!v.activeTurn.turnId) {
    v.activeTurn.turnId = incoming;
    return true;
  }
  return v.activeTurn.turnId === incoming;
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
  for (const { card } of v.toolCards.values()) {
    card.remove();
  }
  v.toolCards.clear();
  v.panel?.remove();
  sessionViews.delete(sessionId);
  pendingPermissionBySession.delete(sessionId);
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

function appendStreamText(prev, next) {
  return `${prev || ""}${String(next ?? "")}`;
}

function softenStreamGlue(text) {
  return String(text || "")
    .replace(/([。！？!?])([^\s\n\r])/g, "$1\n\n$2")
    .replace(/\.(?=[A-Z\u4e00-\u9fff])/g, ".\n\n");
}

function hasMarkdownSyntax(text) {
  return /(^|\s)(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\))/m.test(String(text || ""));
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
    const hasImages = files.some((f) => f.isImage && f.thumbnail);
    const containerClass = hasImages ? "msg-bubble-images" : "msg-bubble-files";

    const fc = document.createElement("div");
    fc.className = containerClass;

    for (const f of files) {
      if (f.isImage && f.thumbnail) {
        const img = document.createElement("img");
        img.className = "msg-bubble-image";
        img.src = f.thumbnail;
        img.alt = f.name;
        img.title = f.name;
        img.addEventListener("click", async () => {
          const { openImageViewer } = await import("./image-viewer.js");
          openImageViewer(f.thumbnail, f.name);
        });
        fc.appendChild(img);
      } else {
        const fi = document.createElement("div");
        fi.className = "msg-bubble-file";
        fi.textContent = f.isImage ? t("message.imagePrefix", { name: f.name }) : f.name;
        fc.appendChild(fi);
      }
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
  if (!canSend(sessionId)) {
    showToast(t("send.error.BUSY"), "warning");
    return;
  }

  const result = await window.assistantClient.retryLastMessage(sessionId);
  if (!result.ok) {
    showToast(retryErrorMessage(result), "error");
    return;
  }

  removeLastAssistantMessage(sessionId);
  syncComposerForActiveSession();
}

function getConversationForSession(sessionId) {
  if (sessionId && store.get("activeSessionId") === sessionId) {
    const activeConv = store.get("conversation");
    if (Array.isArray(activeConv)) return activeConv;
  }
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
  if (!canSend(sessionId)) {
    beginAssistantTurn(sessionId);
    refreshBusyIndicators(sessionId);
  }
}

export function syncComposerForActiveSession() {
  const sid = store.get("activeSessionId");
  const hasProject = (store.get("projects") || []).length > 0;
  const busy = Boolean(sid && !canSend(sid));
  const awaitingPermission = Boolean(sid && (pendingPermissionBySession.has(sid) || pendingHookBySession.has(sid)));
  const queueCount = sid ? getQueuedMessageCount(sid) : 0;
  store.set("isBusy", busy);
  setBusyUI(busy);

  const promptInput = $("promptInput");
  const blocked = !hasProject || !sid;
  for (const id of ["sendBtn", "promptInput", "attachBtn"]) {
    const el = $(id);
    if (el) el.disabled = blocked;
  }
  const sendBtn = $("sendBtn");
  if (sendBtn) {
    sendBtn.textContent = busy ? t("composer.sendQueued") : t("composer.send");
    sendBtn.classList.toggle("send-btn-queued", busy);
  }
  $("composer")?.classList.toggle("composer-busy", busy);
  if (promptInput) {
    promptInput.placeholder = awaitingPermission
      ? t("composer.placeholderPermission")
      : busy && queueCount > 0
        ? t("composer.placeholderBusyQueue", { count: queueCount })
        : busy
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

  renderMessageQueue(sid, queuedMessageItems.get(sid) || []);

  updateSessionRunningIndicators();
}

export function renderConversation(sessionId, { force = false } = {}) {
  clearHighlightCache();
  const sid = sessionId || store.get("activeSessionId");
  if (!sid) return;

  const v = ensurePanel(sid);
  if (!v.listEl) return;

  // If there's a live turn, finish it (it stays collapsed in the DOM)
  finishActiveTurn(sid);

  // Don't rebuild if already rendered — preserves collapsed tool cards
  if (!force && v.listEl.children.length > 0) {
    v.activeBubble = null;
    v.activeMarkdown = "";
    if (isActiveSession(sid)) syncActiveStoreFromView(sid);
    scrollToBottomAfterLayout(v.panel);
    return;
  }

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

// --- Turn timeline wrappers ---

function addToolCard(sessionId, id, name, input, parentToolUseId, turnId = null) {
  if (!view(sessionId).activeTurn) beginAssistantTurn(sessionId, turnId);
  const v = view(sessionId);
  v.turnHadToolUse = true;
  addToolCardImpl(v, id, name, input, parentToolUseId);
  syncTurnProgress(sessionId);
}

function updateToolCard(sessionId, id, status, result) {
  const v = view(sessionId);
  updateToolCardImpl(v, id, status, result);
}

function clearToolCards(sessionId) {
  const v = view(sessionId);
  clearToolCardsImpl(v);
}

function collapseToolCards(sessionId) {
  const v = view(sessionId);
  collapseToolCardsImpl(v);
}

function syncTurnProgress(sessionId) {
  const v = view(sessionId);
  syncTurnProgressImpl(v);
}

export function beginAssistantTurn(sessionId, turnId = null) {
  const v = view(sessionId);
  if (v.activeTurn) {
    if (turnId && !v.activeTurn.turnId) v.activeTurn.turnId = turnId;
    return v.activeTurn.bubble;
  }

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

  const divider = document.createElement("div");
  divider.className = "turn-section-divider";
  divider.hidden = true;
  const dividerSpan = document.createElement("span");
  dividerSpan.textContent = t("turn.reply");
  divider.appendChild(dividerSpan);

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble pending";
  bubble.hidden = true;

  const replyProgress = document.createElement("div");
  replyProgress.className = "reply-progress-slot";
  replyProgress.hidden = true;

  const queue = document.createElement("div");
  queue.className = "turn-queue-slot";
  queue.hidden = true;

  body.append(activity, divider, bubble, replyProgress, queue);
  article.append(avatar, body);
  listEl.appendChild(article);

  v.activeTurn = { article, activity, bubble, queue, turnId: turnId || getTurnId(sessionId) || null };
  v._lastRenderedLength = 0;
  v.activeBubble = bubble;
  v.activeMarkdown = "";
  v.turnHadToolUse = false;
  v.turnStartedAt = Date.now();
  if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
  scrollToBottom(false, v.panel);
  return bubble;
}

function finishActiveTurn(sessionId) {
  const v = view(sessionId);
  finishEngineNotices(v);
  collapseToolCards(sessionId);
  v.activeTurn?.article?.classList.remove("is-running");
  if (v.activeTurn?.activity) {
    v.activeTurn.activity.hidden = false;
  }
  v._lastRenderedLength = 0;
  const replyProgress = v.activeTurn?.article?.querySelector(".reply-progress-slot");
  replyProgress?.replaceChildren();
  if (replyProgress) replyProgress.hidden = true;
  v.activeTurn?.queue?.replaceChildren();
  if (v.activeTurn?.queue) v.activeTurn.queue.hidden = true;
  v.activeTurn = null;
  v.activeBubble = null;
  v.activeMarkdown = "";
  v.turnHadToolUse = false;
  v.turnStartedAt = 0;
  if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
}

/** Collapse the in-flight assistant turn before appending a user bubble (queue flush / IPC race). */
function materializeTurnEnded(sessionId, event) {
  const v = view(sessionId);
  const assistantText = event?.assistant?.text || "";

  // If text wasn't streamed (no chunk events), render it into the timeline now
  if (assistantText && v.activeTurn && !v.activeMarkdown.trim()) {
    v.activeMarkdown = assistantText;
    addTextEntry(v);
    updateTextEntry(v, assistantText);
    finalizeTextEntry(v, softenStreamGlue(assistantText));
  } else if (v.activeMarkdown && v.activeTurn && !v.timeline?._textCard?.isConnected) {
    // Render accumulated markdown that wasn't finalized by onDone
    addTextEntry(v);
    updateTextEntry(v, v.activeMarkdown);
    finalizeTextEntry(v, softenStreamGlue(v.activeMarkdown));
  }

  // Clean up legacy bubble
  if (v.activeBubble) {
    v.activeBubble.classList.remove("pending");
    v.activeBubble.hidden = true;
  }

  finishActiveTurn(sessionId);
  sealLastTurnArticle(sessionId);
  flushDeferredUserCommits(sessionId);

  if (event?.assistant?.failed && v.listEl) {
    const turn = v.listEl.querySelector(".msg-turn:last-of-type");
    if (turn) {
      turn.dataset.failed = "true";
      attachRetryAction(turn, sessionId);
    }
  }
}

/** Deferred user bubbles when session-events beat turn-ended materialization. */
const deferredUserCommits = new Map();

function flushDeferredUserCommits(sessionId) {
  const pending = deferredUserCommits.get(sessionId);
  if (!pending?.length) return;
  deferredUserCommits.delete(sessionId);
  for (const event of pending) {
    createMessage(sessionId, "user", event.text || "", event.files || null);
  }
}

function appendUserCommitted(sessionId, event) {
  if (hasLiveTurn(sessionId)) {
    if (event.fromQueue) {
      const queue = deferredUserCommits.get(sessionId) || [];
      queue.push(event);
      deferredUserCommits.set(sessionId, queue);
      return;
    }
    // idle IPC can beat turn-ended; seal stale shell so user bubble lands in order
    materializeTurnEnded(sessionId, { assistant: null });
  }
  createMessage(sessionId, "user", event.text || "", event.files || null);
}

const applySessionEventBatch = createSessionEventApplier({
  materializeTurnEnded,
  appendUserCommitted,
});

function sealLastTurnArticle(sessionId) {
  const listEl = view(sessionId).listEl;
  if (!listEl) return;
  const turn = listEl.querySelector(".msg-turn:last-of-type");
  if (!turn) return;

  const activity = turn.querySelector(".tool-activity");
  if (!activity) return;

  activity.querySelector(".turn-progress-slot")?.replaceChildren();
  activity.querySelectorAll(".turn-progress").forEach((el) => el.remove());
  const replyProgress = turn.querySelector(".reply-progress-slot");
  replyProgress?.replaceChildren();
  if (replyProgress) replyProgress.hidden = true;
  const queue = turn.querySelector(".turn-queue-slot");
  queue?.replaceChildren();
  if (queue) queue.hidden = true;

  const hasCards = activity.querySelector(".turn-timeline .tool-card");
  const hasEngine = activity.querySelector(".turn-timeline .engine-notice-card");
  const bar = activity.querySelector(".turn-timeline .tool-summary-bar");
  const barVisible = bar && !bar.hidden;
  if (!hasCards && !hasEngine && !barVisible) {
    activity.hidden = true;
  }
}

function permissionPromptCopy(toolName, payload) {
  if (toolName === "ExitPlanMode") {
    return {
      title: t("permission.approvePlanTitle"),
      desc: t("permission.approvePlanDesc"),
    };
  }
  const summary = toolSummary(toolName, payload.input || {});
  return {
    title: t("permission.approveActionTitle"),
    desc: summary.detail ? `${summary.title}：${summary.detail}` : summary.title,
  };
}

/** Pending tool approvals keyed by session (survives session switch). */
const pendingPermissionBySession = new Map();
/** Pending hook decisions keyed by session. */
const pendingHookBySession = new Map();

function dismissHookPrompt(sessionId, requestId) {
  if (sessionId) {
    const pending = pendingHookBySession.get(sessionId);
    if (!requestId || pending?.requestId === requestId) {
      pendingHookBySession.delete(sessionId);
    }
  }
  if (isActiveSession(sessionId)) {
    syncComposerForActiveSession();
  }

  const turn = view(sessionId)?.activeTurn;
  if (!turn?.activity) return;
  const card = turn.activity.querySelector(
    `.permission-prompt[data-request-id="${requestId}"]`,
  );
  card?.remove();
  syncActivityVisibility(view(sessionId));
}

function dismissPermissionPrompt(sessionId, requestId) {
  if (sessionId) {
    const pending = pendingPermissionBySession.get(sessionId);
    if (!requestId || pending?.requestId === requestId) {
      pendingPermissionBySession.delete(sessionId);
    }
  }
  if (isActiveSession(sessionId)) {
    syncComposerForActiveSession();
  }

  const turn = view(sessionId)?.activeTurn;
  if (!turn?.activity) return;
  const card = turn.activity.querySelector(
    `.permission-prompt[data-request-id="${requestId}"]`,
  );
  card?.remove();
  syncActivityVisibility(view(sessionId));
}

function planPreviewText(payload) {
  if (typeof payload.planPreview === "string" && payload.planPreview.trim()) {
    return payload.planPreview.trim().slice(0, 400);
  }
  const input = payload.input || {};
  if (typeof input.plan === "string" && input.plan.trim()) {
    return input.plan.trim().slice(0, 400);
  }
  if (typeof input.summary === "string" && input.summary.trim()) {
    return input.summary.trim().slice(0, 400);
  }
  return "";
}

function buildPermissionCard(sessionId, payload) {
  const { title, desc } = permissionPromptCopy(payload.toolName, payload);
  const card = document.createElement("div");
  card.className = "permission-prompt";
  card.dataset.requestId = payload.requestId;

  const titleEl = document.createElement("div");
  titleEl.className = "permission-prompt-title";
  titleEl.textContent = payload.title || title;

  const descEl = document.createElement("div");
  descEl.className = "permission-prompt-desc";
  const preview = planPreviewText(payload);
  descEl.textContent = payload.description || preview || desc;

  if (preview && (payload.planPreviewTruncated || preview.length >= 400)) {
    const more = document.createElement("div");
    more.className = "permission-prompt-desc";
    more.textContent = t("permission.planTruncated");
    card.append(titleEl, descEl, more);
  } else {
    card.append(titleEl, descEl);
  }

  const actions = document.createElement("div");
  actions.className = "permission-prompt-actions";

  let rememberChecked = false;
  if (payload.toolName !== "ExitPlanMode") {
    const rememberWrap = document.createElement("label");
    rememberWrap.className = "permission-prompt-remember";
    const rememberInput = document.createElement("input");
    rememberInput.type = "checkbox";
    rememberInput.addEventListener("change", () => {
      rememberChecked = rememberInput.checked;
    });
    rememberWrap.append(rememberInput, document.createTextNode(t("permission.approveRemember")));
    card.appendChild(rememberWrap);
  }

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "permission-prompt-btn permission-prompt-btn-approve";
  approveBtn.textContent = t("permission.approve");

  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.className = "permission-prompt-btn";
  denyBtn.textContent = t("permission.deny");

  actions.append(approveBtn, denyBtn);
  card.appendChild(actions);

  const respond = async (allow) => {
    if (card.classList.contains("permission-prompt-resolved")) return;
    card.classList.add("permission-prompt-resolved");
    try {
      const result = await window.assistantClient.respondPermission(
        sessionId,
        payload.requestId,
        allow,
        { remember: allow && rememberChecked },
      );
      if (!result?.ok) {
        card.classList.remove("permission-prompt-resolved");
        showToast(t("permission.respondFailed"), "error");
      }
    } catch (err) {
      card.classList.remove("permission-prompt-resolved");
      showToast(t("permission.respondFailed"), "error");
      console.warn("[permission-response]", err);
    }
  };

  approveBtn.addEventListener("click", () => respond(true));
  denyBtn.addEventListener("click", () => respond(false));

  return card;
}

function buildHookCard(sessionId, payload) {
  const hookName = payload.hookName || "";
  const toolName = payload.toolName || "";
  const decisionReason = payload.decisionReason || "";

  const card = document.createElement("div");
  card.className = "permission-prompt";
  card.dataset.requestId = payload.requestId;

  const titleEl = document.createElement("div");
  titleEl.className = "permission-prompt-title";
  if (hookName === "PreToolUse") {
    titleEl.textContent = t("hook.pretoolUseTitle", { tool: toolName });
  } else if (hookName === "Stop" || hookName === "SubagentStop") {
    titleEl.textContent = t("hook.stopTitle");
  } else {
    titleEl.textContent = `${t("hook.title")} · ${hookName}`;
  }
  card.appendChild(titleEl);

  if (decisionReason) {
    const reasonEl = document.createElement("div");
    reasonEl.className = "permission-prompt-desc";
    reasonEl.textContent = decisionReason;
    card.appendChild(reasonEl);
  }

  const actions = document.createElement("div");
  actions.className = "permission-prompt-actions";

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "permission-prompt-btn permission-prompt-btn-approve";
  approveBtn.textContent = hookName === "PreToolUse"
    ? t("hook.allowTool")
    : t("hook.approveStop");

  const denyBtn = document.createElement("button");
  denyBtn.type = "button";
  denyBtn.className = "permission-prompt-btn";
  denyBtn.textContent = hookName === "PreToolUse"
    ? t("hook.denyTool")
    : t("hook.blockStop");

  actions.append(approveBtn, denyBtn);
  card.appendChild(actions);

  const respond = async (allow) => {
    if (card.classList.contains("permission-prompt-resolved")) return;
    card.classList.add("permission-prompt-resolved");
    try {
      const result = await window.assistantClient.respondHook(
        sessionId,
        payload.requestId,
        allow,
        {},
      );
      if (!result?.ok) {
        card.classList.remove("permission-prompt-resolved");
        showToast(t("hook.respondFailed"), "error");
      }
    } catch (err) {
      card.classList.remove("permission-prompt-resolved");
      showToast(t("hook.respondFailed"), "error");
      console.warn("[hook-response]", err);
    }
  };

  approveBtn.addEventListener("click", () => respond(true));
  denyBtn.addEventListener("click", () => respond(false));

  return card;
}

function questionTitle(question, index) {
  const header = typeof question.header === "string" ? question.header.trim() : "";
  const text = typeof question.question === "string" ? question.question.trim() : "";
  if (header && text) return `${header}：${text}`;
  return text || header || `${t("question.item")} ${index + 1}`;
}

function normalizeQuestionPayloadQuestions(payload) {
  const raw = Array.isArray(payload?.questions) ? payload.questions : [];
  const normalized = raw
    .map((question, index) => {
      if (typeof question === "string") {
        const text = question.trim();
        return text ? { id: `question_${index + 1}`, question: text, options: [] } : null;
      }
      if (!question || typeof question !== "object") return null;
      const text = [
        question.question,
        question.prompt,
        question.message,
        question.text,
        question.header,
      ]
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .find(Boolean);
      return {
        ...question,
        id: question.id || `question_${index + 1}`,
        question: text || `${t("question.item")} ${index + 1}`,
        options: Array.isArray(question.options) ? question.options : [],
        multiSelect: Boolean(question.multiSelect || question.multi_select),
      };
    })
    .filter(Boolean);
  if (normalized.length) return normalized;
  const fallback = payload?.input && typeof payload.input === "object" ? payload.input : {};
  const fallbackText = [
    fallback.question,
    fallback.prompt,
    fallback.message,
    fallback.text,
    fallback.description,
    fallback.title,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);
  return [{ id: "answer", question: fallbackText || t("question.freeAnswerPrompt"), options: [] }];
}

function buildQuestionCard(sessionId, payload) {
  const card = document.createElement("div");
  card.className = "permission-prompt user-question-prompt";
  card.dataset.requestId = payload.requestId;

  const titleEl = document.createElement("div");
  titleEl.className = "permission-prompt-title";
  titleEl.textContent = t("question.title");
  card.appendChild(titleEl);

  const questions = normalizeQuestionPayloadQuestions(payload);
  const answerFields = [];

  questions.forEach((question, index) => {
    const block = document.createElement("div");
    block.className = "user-question-block";

    const label = document.createElement("div");
    label.className = "permission-prompt-desc";
    label.textContent = questionTitle(question, index);
    block.appendChild(label);

    const options = Array.isArray(question.options) ? question.options : [];
    const inputName = `${payload.requestId}_${index}`;
    const controls = [];

    options.forEach((option, optionIndex) => {
      const optionLabel =
        typeof option?.label === "string" && option.label.trim()
          ? option.label.trim()
          : String(option || "");
      if (!optionLabel) return;

      const wrap = document.createElement("label");
      wrap.className = "user-question-option";
      const input = document.createElement("input");
      input.type = question.multiSelect ? "checkbox" : "radio";
      input.name = inputName;
      input.value = optionLabel;
      if (!question.multiSelect && optionIndex === 0) input.checked = true;

      const text = document.createElement("span");
      const desc =
        typeof option?.description === "string" && option.description.trim()
          ? ` - ${option.description.trim()}`
          : "";
      text.textContent = `${optionLabel}${desc}`;
      wrap.append(input, text);
      block.appendChild(wrap);
      controls.push(input);
    });

    const free = document.createElement("input");
    free.className = "user-question-free";
    free.type = "text";
    free.placeholder = t("question.otherPlaceholder");
    block.appendChild(free);

    answerFields.push({
      key: question.question || question.header || question.id || `question_${index + 1}`,
      multi: Boolean(question.multiSelect),
      controls,
      free,
    });
    card.appendChild(block);
  });

  const actions = document.createElement("div");
  actions.className = "permission-prompt-actions";

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "permission-prompt-btn permission-prompt-btn-approve";
  submitBtn.textContent = t("question.submit");
  actions.appendChild(submitBtn);
  card.appendChild(actions);

  submitBtn.addEventListener("click", async () => {
    if (card.classList.contains("permission-prompt-resolved")) return;
    const answers = {};
    for (const field of answerFields) {
      const freeText = field.free.value.trim();
      if (freeText) {
        answers[field.key] = freeText;
        continue;
      }
      const selected = field.controls.filter((input) => input.checked).map((input) => input.value);
      answers[field.key] = field.multi ? selected : selected[0] || "";
    }

    card.classList.add("permission-prompt-resolved");
    try {
      const result = await window.assistantClient.respondUserQuestion(
        sessionId,
        payload.requestId,
        answers,
        "",
      );
      if (!result?.ok) {
        card.classList.remove("permission-prompt-resolved");
        showToast(t("question.respondFailed"), "error");
      }
    } catch (err) {
      card.classList.remove("permission-prompt-resolved");
      showToast(t("question.respondFailed"), "error");
      console.warn("[question-response]", err);
    }
  });

  return card;
}

function showPermissionPrompt(sessionId, payload) {
  if (!sessionId || !payload?.requestId) return;

  beginAssistantTurn(sessionId, eventTurnId(payload));
  const v = view(sessionId);
  v.turnHadToolUse = true;

  // Render permission card inline — always in the correct session's panel
  const card = buildPermissionCard(sessionId, payload);
  v.activeTurn.activity.querySelectorAll(".permission-prompt").forEach((c) => c.remove());
  v.activeTurn.activity.appendChild(card);
  v.activeTurn.activity.hidden = false;

  pendingPermissionBySession.set(sessionId, payload);

  // Only block composer & show busy if the permission is for the active session
  if (isActiveSession(sessionId)) {
    refreshBusyIndicators(sessionId);
    syncComposerForActiveSession();
  }
}

function showHookPrompt(sessionId, payload) {
  if (!sessionId || !payload?.requestId) return;

  beginAssistantTurn(sessionId, eventTurnId(payload));
  const v = view(sessionId);
  v.turnHadToolUse = true;

  const card = buildHookCard(sessionId, payload);
  v.activeTurn.activity.querySelectorAll(".permission-prompt").forEach((c) => c.remove());
  v.activeTurn.activity.appendChild(card);
  v.activeTurn.activity.hidden = false;

  pendingHookBySession.set(sessionId, payload);

  if (isActiveSession(sessionId)) {
    refreshBusyIndicators(sessionId);
    syncComposerForActiveSession();
  }
}

export function hasPendingUserQuestion(sessionId) {
  const pending = sessionId ? pendingPermissionBySession.get(sessionId) : null;
  return Boolean(pending?.kind === "user-question" && pending.requestId);
}

export async function respondPendingUserQuestionFromComposer(sessionId, responseText) {
  const pending = sessionId ? pendingPermissionBySession.get(sessionId) : null;
  const response = typeof responseText === "string" ? responseText.trim() : "";
  if (!pending?.requestId || pending.kind !== "user-question" || !response) {
    return { ok: false, error: "NO_PENDING_QUESTION" };
  }

  const questions = Array.isArray(pending.questions) ? pending.questions : [];
  const answers = {};
  if (questions.length) {
    const first = questions[0] || {};
    const key = first.question || first.header || first.id || "answer";
    answers[key] = response;
  } else {
    answers.answer = response;
  }

  const result = await window.assistantClient.respondUserQuestion(
    sessionId,
    pending.requestId,
    answers,
    response,
  );
  if (result?.ok) {
    dismissPermissionPrompt(sessionId, pending.requestId);
  }
  return result;
}

function showUserQuestionPrompt(sessionId, payload) {
  if (!sessionId || !payload?.requestId) return;

  beginAssistantTurn(sessionId, eventTurnId(payload));
  const v = view(sessionId);
  v.turnHadToolUse = true;

  const card = buildQuestionCard(sessionId, payload);
  v.activeTurn.activity.querySelectorAll(".user-question-prompt").forEach((c) => c.remove());
  v.activeTurn.activity.appendChild(card);
  v.activeTurn.activity.hidden = false;

  pendingPermissionBySession.set(sessionId, { ...payload, kind: "user-question" });
  if (isActiveSession(sessionId)) {
    refreshBusyIndicators(sessionId);
    syncComposerForActiveSession();
  }
}

function handleEngineNotice(sessionId, payload) {
  if (!sessionId || !payload) return;

  const showPanel = payload.panel !== false;
  const text = engineNoticeText(payload);

  if (showPanel) {
    if (!hasLiveTurn(sessionId)) beginAssistantTurn(sessionId, eventTurnId(payload));
    addOrUpdateEngineNotice(view(sessionId), payload);
    const v = view(sessionId);
    // Meaningful progress (compaction, retry) updates the single activity line;
    // do not overwrite tool-card-driven labels for generic engine codes.
    if (text && payload.replace) {
      v.activityLabel = text;
      v.activityLabelSource = "engine";
    }
    refreshRunningActivityLabel(v);
    syncTurnProgressImpl(v);
    if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
    scrollToBottom(false, v.panel);
  }

  const shouldToast =
    payload.toast ||
    payload.level === "stderr" ||
    (payload.level === "warning" && payload.code === "permissionTimeout");

  if (shouldToast && isActiveSession(sessionId)) {
    if (payload.code === "permissionTimeout") {
      showToast(t("permission.timeout"), "warning");
    } else if (text) {
      showToast(text, payload.level === "warning" ? "warning" : "info");
    }
  } else if (payload.level === "warning" && payload.message && isActiveSession(sessionId)) {
    showToast(payload.message, "warning");
  }

  if (payload.level === "progress" && payload.toolName) {
    updateToolCardProgressImpl(view(sessionId), payload.toolName, payload.detail || text);
  }
}

function applyTurnState(payload) {
  if (!payload?.sessionId) return;
  storeTurnState(payload);
  const sessionId = payload.sessionId;
  const phase = getTurnPhase(sessionId);

  if (!canSend(sessionId) && !hasLiveTurn(sessionId)) {
    beginAssistantTurn(sessionId, eventTurnId(payload));
  }

  if (phase === "streaming" && view(sessionId).activeBubble) {
    view(sessionId).activeBubble.classList.add("pending");
  }

  if (phase === "idle" || phase === "stopping") {
    clearBusyHeartbeat(sessionId);
    const bubble = view(sessionId).activeBubble;
    if (bubble && phase === "idle") {
      bubble.classList.remove("pending");
    }
    view(sessionId).activeTurn?.article?.classList.remove("is-running");
  }

  if (sessionId && !canSend(sessionId)) {
    refreshBusyIndicators(sessionId);
  }

  if (isActiveSession(sessionId)) {
    syncComposerForActiveSession();
  }
  updateSessionRunningIndicators();
}

function startTurnStateWatchdog() {
  if (turnStateWatchdog || !window.assistantClient?.getTurnState) return;
  turnStateWatchdog = setInterval(async () => {
    const sessionId = store.get("activeSessionId");
    if (!sessionId) return;
    if (canSend(sessionId) && !hasLiveTurn(sessionId)) return;
    try {
      const snap = await window.assistantClient.getTurnState(sessionId);
      if (snap?.ok) {
        applyTurnState(snap);
        if (isActiveSession(sessionId)) syncComposerForActiveSession();
      }
    } catch {
      // Best-effort UI calibration only.
    }
  }, 10000);
}

export function wireMessageIpc() {
  startTurnStateWatchdog();

  window.assistantClient.onFileDiff?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    import("./diff-panel.js").then((m) => m.addDiffEntry(sessionId, payload));
  });

  window.assistantClient.onTurnState?.(applyTurnState);

  window.assistantClient.onSessionEvents?.((payload) => {
    applySessionEventBatch(payload);
    const sessionId = payload?.sessionId;
    if (sessionId && isActiveSession(sessionId)) {
      syncActiveStoreFromView(sessionId);
      syncComposerForActiveSession();
    }
  });

  window.assistantClient.onQueueState?.((payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    setQueuedMessageCount(sessionId, payload.queueLength || 0);
    setQueuedMessageItems(sessionId, payload.items || []);
    if (!canSend(sessionId) && !hasLiveTurn(sessionId)) {
      beginAssistantTurn(sessionId, eventTurnId(payload));
    }
    renderInlineTurnQueue(sessionId, payload.items || []);
    renderMessageQueue(sessionId, payload.items || []);
    if (isActiveSession(sessionId)) syncComposerForActiveSession();
  });

  window.assistantClient.onQueueDispatchFailed?.((payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    showToast(payload.detail || payload.error || t("send.error.GENERIC"), "error");
    if (isActiveSession(sessionId)) syncComposerForActiveSession();
  });

  window.assistantClient.onAutoRecover?.((payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;

    clearBusyHeartbeat(sessionId);
    view(sessionId).activityLabel = "";
    view(sessionId).activityLabelSource = "";
    clearToolCards(sessionId);
    finishActiveTurn(sessionId);

    if (isActiveSession(sessionId)) {
      showToast(
        t("engine.autoRecover", {
          attempt: payload.attempt ?? 1,
          maxRetries: payload.maxRetries ?? 2,
        }),
        "info",
      );
      syncComposerForActiveSession();
    }
  });

  // Full tool_use from assistant event
  window.assistantClient.onTool((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    const v = view(sessionId);
    if (!v.activeTurn) {
      import("./diff-panel.js").then((m) => m.clearDiffEntries(sessionId));
    }
    // If a placeholder card already exists (from content_block_start), finalize it
    if (v.toolCards.has(payload.id)) {
      finalizeToolCardInputImpl(v, payload.id, payload.input);
    } else {
      addToolCard(
        sessionId,
        payload.id,
        payload.name,
        payload.input,
        payload.parentToolUseId,
        eventTurnId(payload),
      );
    }
  });

  // Placeholder card from content_block_start (name/id only, no input yet)
  window.assistantClient.onToolUpcoming?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    const v = view(sessionId);
    if (!v.activeTurn) beginAssistantTurn(sessionId, eventTurnId(payload));
    v.turnHadToolUse = true;
    addToolCardPlaceholderImpl(v, payload.id, payload.name, payload.parentToolUseId);
  });

  // Streaming tool input from input_json_delta
  window.assistantClient.onToolInputDelta?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    updateToolCardInputImpl(view(sessionId), payload.id, payload.partialJson);
  });

  // Tool input complete (from assistant event, for pre-created cards)
  window.assistantClient.onToolInputDone?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    finalizeToolCardInputImpl(view(sessionId), payload.id, payload.input);
  });

  window.assistantClient.onToolDone((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    updateToolCard(sessionId, payload.id, payload.status, payload.result);
  });

  window.assistantClient.onPermissionRequest((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    showPermissionPrompt(sessionId, payload);
  });

  window.assistantClient.onUserQuestion?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    showUserQuestionPrompt(sessionId, payload);
  });

  window.assistantClient.onPermissionCancelled((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId || !payload.requestId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    dismissPermissionPrompt(sessionId, payload.requestId);
  });

  window.assistantClient.onHookRequest?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    showHookPrompt(sessionId, payload);
  });

  window.assistantClient.onHookResolved?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId || !payload.requestId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    dismissHookPrompt(sessionId, payload.requestId);
  });

  window.assistantClient.onEngineNotice((payload) => {
    if (payload?.sessionId && !acceptLiveTurnEvent(payload.sessionId, payload)) return;
    handleEngineNotice(payload.sessionId, payload);
  });

  window.assistantClient.onChunk((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, payload)) return;
    const v = view(sessionId);

    if (!v.activeTurn) {
      beginAssistantTurn(sessionId, eventTurnId(payload));
      if (!v.activeTurn) return;
    }
    v.turnHadToolUse = true;
    v.activeTurn?.article?.classList.add("is-running");

    // Accumulate full markdown string
    v.activeMarkdown = appendStreamText(v.activeMarkdown, payload.text);

    // Stream into the timeline as a live text entry
    if (v.activeMarkdown.length === (payload.text || "").length) {
      addTextEntry(v);
    }
    updateTextEntry(v, v.activeMarkdown);

    scrollToBottomThrottled(false, v.panel);

    if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
  });

  window.assistantClient.onDone(async (payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;

    clearBusyHeartbeat(sessionId);
    const v = view(sessionId);
    v.activityLabel = "";
    v.activityLabelSource = "";

    // Finalize: render full reply with syntax highlighting into the timeline
    if (v.activeMarkdown) {
      finalizeTextEntry(v, softenStreamGlue(v.activeMarkdown));
    }
    if (v.activeTurn?.article) {
      v.activeTurn.article.classList.remove("is-running");
    }
    finishEngineNotices(v);
    collapseToolCards(sessionId);

    // Clean up legacy bubble if it exists
    if (v.activeBubble) {
      v.activeBubble.classList.remove("pending");
      v.activeBubble.hidden = true;
    }

    if (payload.stalled && isActiveSession(sessionId) && !payload.hadOutput) {
      showToast(t("message.stalledHint"), "info");
    }

    if (isActiveSession(sessionId)) {
      syncComposerForActiveSession();
    }

    await refreshStateLight({ reRenderActive: false });

    if (isActiveSession(sessionId)) {
      $("promptInput")?.focus();
      syncComposerForActiveSession();
    }
  });

  window.assistantClient.onStatus((status) => {
    const sessionId = status.sessionId;
    if (!sessionId) return;
    if (!acceptLiveTurnEvent(sessionId, status)) return;
    if (status.state === "thinking") {
      if (!view(sessionId).activeBubble) beginAssistantTurn(sessionId, eventTurnId(status));
      refreshBusyIndicators(sessionId);
    }
    if (isActiveSession(sessionId)) syncComposerForActiveSession();
    updateSessionRunningIndicators();
  });

  window.assistantClient.onError(async (error) => {
    const sessionId = error.sessionId;
    if (!sessionId) return;

    clearBusyHeartbeat(sessionId);

    if (isActiveSession(sessionId)) syncComposerForActiveSession();

    await refreshStateLight({ reRenderActive: false });

    if (isActiveSession(sessionId)) {
      $("promptInput")?.focus();
      syncComposerForActiveSession();
    }
  });

  window.assistantClient.onFocusSession(async (payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    try {
      const sw = await window.assistantClient.switchSession(sessionId);
      const { applySessionSwitch } = await import("./session-chrome.js");
      await applySessionSwitch(sw, sessionId, sw?.projectId);
    } catch (err) {
      console.warn("[focus-session]", err);
      store.set("activeSessionId", sessionId);
      showSessionMessages(sessionId);
      renderConversation(sessionId);
      updateTopbarTitles();
    }
  });
}

export function setBusyUI(busy) {
  const sid = store.get("activeSessionId");
  const interruptBtn = $("interruptBtn");
  if (interruptBtn) interruptBtn.hidden = !canInterrupt(sid);

  updateSessionRunningIndicators();

  if (busy && sid) {
    syncTurnProgress(sid);
    const meta = $("sessionMeta");
    if (meta) meta.textContent = t("message.processing");
  } else if (sid) {
    view(sid).activityLabel = "";
    view(sid).activityLabelSource = "";
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
