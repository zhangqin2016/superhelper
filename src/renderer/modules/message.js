/**
 * Chat UI — runtime-event driven Assistant Turn Article renderer.
 */

import store from "./state.js";
import {
  $,
  bindPanelScroll,
  cssEscape,
  detachAutoFollowForUserNavigation,
  initScrollToBottom,
  isNearBottom,
  isUserScrollDetached,
  scrollToBottom,
  scrollToBottomAfterLayout,
} from "./dom.js";
import { elementScrollTargetTop, revealScrollIntent, shouldLoadOlderOnScroll } from "./scroll-geometry.js";
import { t } from "../i18n/index.js";
import { buildDiagnoseAction } from "./diagnose-action.js";
import {
  buildMinimapItems,
  COMMITTED_INITIAL_WINDOW,
  COMMITTED_RENDER_CHUNK,
  committedMessagesForRender,
  copyActionText,
  formatScheduledDraftDateTime,
  isCommittedRenderCurrent,
  isCurrentRetryTarget,
  liveInsertAnchorTurnId,
  mergeSwitchNotices,
  rewindActionTarget,
  scheduledDraftPreviewModel,
  shouldShowRetryAction,
  shouldSkipCommittedAssistantForLiveTurn,
} from "./message-committed-render-model.js";
import {
  applyRuntimeBatch,
  getRuntimeSession,
  syncCommittedMessages,
  subscribeRuntime,
  canSend,
  canInterrupt,
} from "./session-runtime-store.js";
import {
  renderSealedTurnArticle,
  renderLiveTurnArticle,
} from "./turn-view-renderer.js";
import {
  legacyLiveTurnFromMessage,
  liveTurnFromRecord,
} from "./turn-view-model.js";
import { createLiveTurnArticleShell } from "./turn-article-shell.js";
import { refreshLiveTurnStatusDisplay } from "./turn-article-frame.js";
import { patchLiveToolClocks } from "./turn-live-clock-patch.js";
import { updateSessionRunningIndicators } from "./project-tree.js";
import { updateTopbarTitles } from "./session-chrome.js";
import { renderMessageQueue, refreshSendEnabled } from "./composer.js";
import { addDiffEntry } from "./diff-panel.js";
import { syncWorkbenchEmptyState } from "./workbench-empty.js";
import { appendSwitchNoticeArticle } from "./character-switch-notices.js";
import { collectUnrenderedCommittedMessages, collectEvictedMessageKeys, removeCommittedArticlesByKeys } from "./message-render-keys.js";
import {
  liveTurnRenderMode,
  runtimeVisualSig,
  shouldFollowLiveRender,
  shouldThrottleLiveRender,
  shouldUpdateConversationMinimap,
} from "./message-live-render-model.js";
import { confirmDialog } from "./confirm-dialog.js";
import { renderLiveTaskStrip } from "./live-task-strip.js";
import { showToast } from "./toast.js";
import {
  createScheduledDraftFromMessage,
  rejectScheduledDraftFromMessage,
} from "./scheduled-draft-actions.js";

const sessionViews = new Map();
const renderedMessageKeys = new Map();
const liveRenderTimers = new Map();
const LIVE_RENDER_THROTTLE_MS = 150;
let runtimeHeartbeat = null;
const lastRuntimeVisualSig = new Map();
const promptedMemoryProposals = new Set();

function scheduleLiveRender(sessionId) {
  if (!sessionId || liveRenderTimers.has(sessionId)) return;
  liveRenderTimers.set(sessionId, setTimeout(() => {
    liveRenderTimers.delete(sessionId);
    renderRuntimeSession(sessionId);
  }, LIVE_RENDER_THROTTLE_MS));
}

function renderRuntimeForSession(sessionId) {
  if (shouldThrottleLiveRender(getRuntimeSession(sessionId))) scheduleLiveRender(sessionId);
  else renderRuntimeSession(sessionId);
}

function stackEl() {
  return $("sessionMessagesStack");
}

function clearStackMinimaps() {
  const root = stackEl();
  if (!root?.querySelectorAll) return;
  for (const old of root.querySelectorAll(":scope > .conversation-minimap")) old.remove();
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
      savedScrollTop: null,
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
      v.savedScrollTop = panel.scrollTop;
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
  clearStackMinimaps();
  syncWorkbenchEmptyState(view(sessionId).listEl);
  const v = view(sessionId);
  requestAnimationFrame(() => {
    if (!v.panel) return;
    const intent = revealScrollIntent({
      savedScrollTop: v.savedScrollTop,
      hasRenderedContent: Boolean(v.listEl?.firstChild),
    });
    if (intent.mode === "restore") {
      v.panel.scrollTop = intent.scrollTop;
    } else {
      scrollToBottom(true, v.panel);
    }
  });
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

// Whether the session's panel is currently pinned to the bottom (showing the
// latest). Used by the background official-history refresh to decide between
// "stick to bottom" (the user is at the latest — keep them there even though the
// refreshed content changed height) and "preserve position" (the user scrolled
// up to read older messages — don't yank them to the bottom). No panel yet =
// treat as bottom, since a fresh open scrolls to the latest.
export function isSessionViewAtBottom(sessionId) {
  const panel = sessionViews.get(sessionId)?.panel;
  if (!panel) return true;
  return !isUserScrollDetached(panel) && isNearBottom(panel);
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
    ...opts,
    allowEvict: true,
    onComplete: opts.forceScrollBottom ? () => scrollToBottomAfterLayout(v.panel, true) : null,
  });
  renderRuntimeSession(sessionId, { preserveScroll: Boolean(opts.preserveScroll) });
  syncWorkbenchEmptyState(v.listEl);
  if (opts.forceScrollBottom && pendingCount === 0) {
    scrollToBottomAfterLayout(v.panel, true);
  }
}

/**
 * True when the session's panel already shows exactly the current committed-message
 * window — so a session switch can just reveal it instead of tearing it down and
 * re-parsing every message (the costly `force` rebuild). Conservative: any
 * pending (added) message, or a count mismatch (removed message / shifted window),
 * returns false so the caller still does a clean rebuild.
 */
export function isConversationRenderCurrent(sessionId) {
  const hasSessionView = sessionViews.has(sessionId);
  const v = sessionViews.get(sessionId);
  const keys = renderedMessageKeys.get(sessionId);
  const runtime = getRuntimeSession(sessionId);
  const renderMessages = committedMessagesForRender(mergeSwitchNotices(runtime.committedMessages, runtime.switchNotices), { sessionId });
  const unrendered = keys
    ? collectUnrenderedCommittedMessages(renderMessages, new Set(keys)).length
    : renderMessages.length;
  return isCommittedRenderCurrent({
    hasSessionView,
    hasRenderedContent: Boolean(v?.listEl?.firstChild),
    renderedKeyCount: keys?.size || 0,
    renderMessageCount: renderMessages.length,
    unrenderedCount: unrendered,
  });
}

function scheduleCommittedRenderPump(fn) {
  if (typeof requestAnimationFrame === "function" && !document.hidden) {
    requestAnimationFrame(fn);
  } else {
    setTimeout(fn, 0);
  }
}

function scrollPanelToElement(panel, el) {
  if (!panel || !el) return;
  const panelRect = panel.getBoundingClientRect();
  const elementRect = el.getBoundingClientRect();
  const top = elementScrollTargetTop({
    panelTop: panelRect.top,
    elementTop: elementRect.top,
    scrollTop: panel.scrollTop,
    scrollHeight: panel.scrollHeight,
    clientHeight: panel.clientHeight,
  });
  detachAutoFollowForUserNavigation(panel);
  panel.scrollTo({ top, behavior: "smooth" });
}

// Scroll to a prompt by turnId, loading older history on demand when it isn't in
// the rendered (windowed) DOM yet. Bounded + fail-safe: gives up quietly rather
// than ever breaking scroll.
async function jumpToTurnForSession(sessionId, panel, turnId) {
  if (!panel || !turnId) return;
  const selector = `.messages [data-turn-id="${cssEscape(turnId)}"]`;
  const find = () => panel.querySelector(selector);
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  try {
    let el = find();
    let guard = 0;
    while (!el && guard < 40) {
      const loaded = await import("./session-chrome.js")
        .then((m) => m.loadOlderConversationForSession?.(sessionId, panel))
        .catch(() => false);
      await frame(); // older messages render (possibly chunked) over the next frames
      el = find();
      if (el || !loaded) break; // found, or nothing more to load
      guard += 1;
    }
    if (!el) { await frame(); el = find(); } // one more tick for the chunked renderer
    if (el) scrollPanelToElement(panel, el);
  } catch {
    /* leave the scroll position unchanged on any failure */
  }
}

function appendCommittedMessage(sessionId, runtime, message, key) {
  const anchor = committedInsertAnchor(sessionId, runtime);
  if (message.role === "user") appendUserMessage(sessionId, message, anchor, key);
  else if (message.role === "notice") appendSwitchNoticeArticle(view(sessionId).listEl, message, anchor, key);
  else if (message.role === "assistant") {
    if (shouldSkipCommittedAssistantForLiveTurn(runtime, message)) return;
    appendFinalAssistantArticle(sessionId, message, anchor, key);
  }
}

function committedInsertAnchor(sessionId, runtime) {
  // Only an active live turn may anchor committed history. After a turn has
  // completed, the next user.committed event can arrive before turn.started;
  // using the previous final article as the anchor would insert the new user
  // message before the old assistant answer.
  const turnId = liveInsertAnchorTurnId(runtime);
  if (!turnId) return null;
  const article = view(sessionId).liveArticles.get(turnId);
  return article?.isConnected ? article : null;
}

function renderCommittedMessages(sessionId, opts = {}) {
  const runtime = getRuntimeSession(sessionId);
  const keys = renderedMessageKeys.get(sessionId) || new Set();
  renderedMessageKeys.set(sessionId, keys);

  const renderMessages = committedMessagesForRender(mergeSwitchNotices(runtime.committedMessages, runtime.switchNotices), { sessionId, windowCount: opts.windowCount });
  const pending = collectUnrenderedCommittedMessages(renderMessages, keys);
  if (opts.allowEvict) removeCommittedArticlesByKeys(view(sessionId).listEl, collectEvictedMessageKeys(renderMessages, keys));
  if (pending.length === 0) return 0;

  if (pending.length <= COMMITTED_RENDER_CHUNK || renderMessages.length <= COMMITTED_INITIAL_WINDOW || opts.preserveScroll) {
    for (const { key, message } of pending) {
      appendCommittedMessage(sessionId, runtime, message, key);
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
      const { key, message } = pending[cursor];
      appendCommittedMessage(sessionId, runtime, message, key);
    }
    if (cursor < pending.length) {
      scheduleCommittedRenderPump(pump);
    } else {
      syncWorkbenchEmptyState(ensurePanel(sessionId).listEl);
      opts.onComplete?.();
    }
  };
  pump();
  return pending.length;
}

function appendUserMessage(sessionId, message, beforeNode = null, key = "") {
  const v = ensurePanel(sessionId);
  const article = document.createElement("article");
  article.className = "runtime-user-message";
  if (message.turnId) article.dataset.turnId = message.turnId; // lets the minimap locate this prompt
  if (key) article.dataset.messageKey = key; // lets window eviction locate this article

  const label = document.createElement("p");
  label.className = "runtime-user-label";
  label.textContent = t("message.userTaskLabel");
  if (message.steer || message.meta?.steer) {
    article.classList.add("is-steer");
    const badge = document.createElement("span");
    badge.className = "runtime-user-steer-badge";
    badge.textContent = t("message.steerBadge");
    article.appendChild(badge);
  }

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

function appendFinalAssistantArticle(sessionId, message, beforeNode = null, key = "") {
  if (message?.meta?.scheduledDraft) {
    appendScheduledDraftArticle(sessionId, message, beforeNode, key);
    return;
  }
  const v = ensurePanel(sessionId);
  const liveTurn = message.record
    ? liveTurnFromRecord(message.record)
    : legacyLiveTurnFromMessage(message);
  const article = renderSealedTurnArticle(liveTurn, Boolean(message.failed), sessionId);
  if (key) article.dataset.messageKey = key; // lets window eviction locate this article
  appendArticleActions(article, sessionId, message);
  if (beforeNode && v.listEl?.contains(beforeNode)) v.listEl.insertBefore(article, beforeNode);
  else v.listEl?.appendChild(article);
}

const COPY_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5h-6a1 1 0 0 0-1 1v6"/></svg>';
const COPIED_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>';
const REWIND_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 0 1.5-3.5"/><path d="M3 2.5V5h2.5"/></svg>';

// "Rewind to here": undo this turn and everything after — in the engine session
// (files + dropped context) and Lily's transcript together. Only offered when the
// turn carries an engine anchor (engineMessageId), and never mid-turn.
function buildRewindAction(sessionId, message) {
  const target = rewindActionTarget(message);
  if (!target) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "assistant-icon-btn assistant-rewind-btn";
  btn.title = t("message.rewind");
  btn.setAttribute("aria-label", t("message.rewind"));
  btn.innerHTML = REWIND_ICON_SVG;
  btn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: t("message.rewindTitle"),
      message: t("message.rewindConfirm"),
      confirmText: t("message.rewind"),
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      const res = await window.assistantClient.rewindSession(sessionId, target.turnId, target.engineMessageId);
      if (res?.ok) {
        syncCommittedMessages(sessionId, res.conversation || []);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
      } else {
        showToast(res?.error === "BUSY" ? t("message.rewindBusy") : t("message.rewindFailed"), "warning");
      }
    } catch (err) {
      showToast(err?.message || t("message.rewindFailed"), "warning");
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });
  return btn;
}

// A small right-aligned icon row under the answer (room for export-PDF etc.
// later). Always visible but visually muted — hover discovery does not work
// for non-technical users.
function appendArticleActions(article, sessionId, message) {
  const actions = document.createElement("div");
  actions.className = "assistant-article-actions";
  if (shouldShowRetryAction(message)) actions.append(buildRetryAction(sessionId, message), buildDiagnoseAction());
  const copyText = copyActionText(message);
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
        showToast(t("common.copyFailed"), "warning");
      }
    });
    actions.appendChild(copy);
  }
  const rewind = buildRewindAction(sessionId, message);
  if (rewind) actions.appendChild(rewind);
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
    if (!isCurrentRetryTarget(committed, message)) {
      showToast(t("turn.retryStale"), "warning");
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
        showToast(result?.detail || result?.error || t("turn.retryFailed"), "error");
      }
    } catch (err) {
      retry.disabled = false;
      showToast(err?.message || t("turn.retryFailed"), "error");
    }
  });
  return retry;
}

function appendScheduledDraftArticle(sessionId, message, beforeNode = null, key = "") {
  const v = ensurePanel(sessionId);
  const preview = scheduledDraftPreviewModel(message);

  const article = document.createElement("article");
  article.className = "assistant-turn-article scheduled-draft-article";
  article.dataset.messageId = preview.messageId;
  if (key) article.dataset.messageKey = key; // lets window eviction locate this article

  const shell = document.createElement("div");
  shell.className = "scheduled-draft-chat-card";

  const title = document.createElement("div");
  title.className = "scheduled-draft-title";
  title.textContent = preview.created
    ? t("scheduled.cardCreatedTitle")
    : preview.rejected
      ? t("scheduled.cardRejectedTitle")
      : t("scheduled.cardTitle");
  shell.appendChild(title);

  const rows = document.createElement("div");
  rows.className = "scheduled-draft-rows";
  appendScheduledDraftRow(rows, t("scheduled.previewTitle"), preview.title || t("scheduled.untitled"));
  appendScheduledDraftRow(rows, t("scheduled.previewSchedule"), preview.scheduleText);
  appendScheduledDraftRow(rows, t("scheduled.previewNextRun"), formatScheduledDraftDateTime(preview.nextRunAt));
  appendScheduledDraftRow(rows, t("scheduled.previewScope"), t("scheduled.previewScopeValue"));
  shell.appendChild(rows);

  const actions = document.createElement("div");
  actions.className = "scheduled-draft-actions";

  if (preview.created || preview.rejected) {
    const pill = document.createElement("span");
    pill.className = "scheduled-draft-pill";
    pill.textContent = preview.created ? t("scheduled.created") : t("scheduled.cardRejected");
    actions.appendChild(pill);
  } else {
    const create = document.createElement("button");
    create.type = "button";
    create.className = "button-primary";
    create.textContent = t("scheduled.cardCreate");
    create.addEventListener("click", () => void createScheduledDraftFromMessage({
      sessionId, messageId: message.id, button: create, syncCommittedMessages, renderConversation,
    }));
    actions.appendChild(create);
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "button-secondary";
    reject.disabled = preview.rejecting;
    reject.textContent = preview.rejecting ? t("scheduled.cardRejecting") : t("scheduled.cardReject");
    reject.addEventListener("click", () => void rejectScheduledDraftFromMessage({
      sessionId, messageId: message.id, button: reject, syncCommittedMessages, renderConversation,
    }));
    actions.appendChild(reject);
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
  // Keep the pinned task strip current for the active session even when the
  // visual-signature dedup skips the heavier render below (to-do progress can
  // change without changing that signature).
  if (isActiveSession(sessionId)) renderLiveTaskStrip(runtime.liveTurn || null);
  const sig = runtimeVisualSig(runtime);
  if (!opts.force && lastRuntimeVisualSig.get(sessionId) === sig) return;
  lastRuntimeVisualSig.set(sessionId, sig);

  const panel = view(sessionId).panel;
  const shouldFollow = shouldFollowLiveRender({
    preserveScroll: Boolean(opts.preserveScroll),
    activeSession: isActiveSession(sessionId),
    userScrollDetached: isUserScrollDetached(panel),
    nearBottom: isNearBottom(panel),
  });
  renderCommittedMessages(sessionId, { allowEvict: shouldFollow });
  const liveMode = liveTurnRenderMode(runtime);
  if (runtime.liveTurn) {
    if (liveMode === "remove-duplicate") {
      // The committed card already represents this turn — drop the duplicate
      // live text article instead of rendering it after the card.
      const v = view(sessionId);
      const stale = v.liveArticles.get(runtime.liveTurn.turnId);
      if (stale?.isConnected) stale.remove();
      v.liveArticles.delete(runtime.liveTurn.turnId);
    } else if (liveMode === "render") {
      renderLiveTurn(sessionId, runtime.liveTurn, runtime.queue);
    }
  }
  syncWorkbenchEmptyState(view(sessionId).listEl);
  syncComposerForActiveSession();
  updateSessionRunningIndicators();
  updateTopbarTitles();
  // Minimap is a non-essential overlay: load it lazily and swallow any failure so it
  // can NEVER break conversation rendering (a missing/failed module must not blank the
  // chat). CAPABILITY-GATE Rule 13 — degrade to "no minimap", never to "no chat".
  if (isActiveSession(sessionId) && panel) {
    const minimapItems = buildMinimapItems(runtime);
    import("./conversation-minimap.js")
      .then((m) => {
        if (!shouldUpdateConversationMinimap({
          activeSession: isActiveSession(sessionId),
          panelConnected: panel.isConnected,
          panelActive: panel.classList.contains("is-active"),
          samePanel: view(sessionId).panel === panel,
        })) return;
        m.updateMinimap?.(panel, {
          items: minimapItems,
          jumpToTurn: (turnId) => jumpToTurnForSession(sessionId, panel, turnId),
        });
      })
      .catch(() => {});
  }
  if (shouldFollow) scrollToBottomAfterLayout(panel, true);
}

function renderLiveTurn(sessionId, liveTurn, queue) {
  const article = ensureLiveArticle(sessionId, liveTurn);
  renderLiveTurnArticle(article, liveTurn, { sessionId, queue });
}

function findProjectIdForSession(sessionId) {
  for (const project of store.get("projects") || []) {
    if ((project.sessions || []).some((session) => session.id === sessionId)) return project.id;
  }
  return "";
}

async function focusSessionFromNotification(sessionId) {
  if (!sessionId) return;
  try {
    const sw = await window.assistantClient.switchSession(sessionId);
    const { applySessionSwitch } = await import("./session-chrome.js");
    await applySessionSwitch(sw, sessionId, findProjectIdForSession(sessionId));
  } catch (err) {
    const { showToast } = await import("./toast.js");
    showToast(err?.message || t("toast.switchSessionFailed"), "error");
  }
}

function refreshLiveStatusOnly(sessionId) {
  const runtime = getRuntimeSession(sessionId);
  const live = runtime.liveTurn;
  if (!live || live.final) return;
  const article = view(sessionId).liveArticles.get(live.turnId);
  if (!article?.isConnected) return;
  // Heartbeat tick: status line + running tool clocks only. Full renders stay
  // event-driven (visual signature) so a long-running tool never costs a
  // whole-timeline morphdom pass per second.
  refreshLiveTurnStatusDisplay(article, live);
  patchLiveToolClocks(article, live);
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
  const interrupt = $("interruptBtn");
  if (input) {
    input.placeholder = busy
      ? (canInterrupt(sid) ? t("composer.placeholderBusy") : t("composer.placeholderWaiting"))
      : t("composer.placeholder");
  }
  refreshSendEnabled();
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
        else refreshLiveStatusOnly(s);
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
    void handleMemoryProposalEvents(batch);
    handleSelfHealRetryEvents(batch);
    applyRuntimeBatch(batch);
  });
  window.assistantClient.onFocusSession?.((data) => {
    void focusSessionFromNotification(data?.sessionId || "");
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

// Runtime model self-heal / tool-call rescue fired a silent retry of the
// failed message: tell the user why a "failed" turn is suddenly running again.
function handleSelfHealRetryEvents(batch) {
  for (const event of batch?.events || []) {
    if (event.type === "turn.self_heal_notice") {
      if (event.payload?.kind === "probe_no_change") {
        showToast(t("toast.selfHealProbeNoChange"), "info", 7000);
      }
      continue;
    }
    if (event.type !== "turn.self_heal_retry") continue;
    const kind = event.payload?.kind || "";
    const key = kind === "tool_call_rescue"
      ? "toast.toolCallRescueRetry"
      : kind === "empty_completion_retry"
        ? "toast.emptyCompletionRetry"
        : kind === "truncated_turn_retry"
          ? "toast.truncatedTurnRetry"
          : kind === "micro_completion_retry"
            ? "toast.microCompletionRetry"
            : kind === "runner_terminated_retry"
              ? "toast.runnerTerminatedRetry"
              : kind === "runner_start_retry"
                ? "toast.runnerStartRetry"
                : "toast.modelSelfHealRetry";
    showToast(t(key), "info", 6000);
  }
}

async function handleMemoryProposalEvents(batch) {
  for (const event of batch?.events || []) {
    if (event.type !== "memory.proposal") continue;
    const proposal = event.payload?.proposal;
    const key = String(proposal?.key || "");
    if (!key || promptedMemoryProposals.has(key)) continue;
    promptedMemoryProposals.add(key);
    const shouldRemember = await confirmDialog({
      title: t("memory.proposalTitle"),
      message: t("memory.proposalMessage", { text: proposal.text || "" }),
      confirmText: t("memory.proposalApprove"),
      cancelText: t("memory.proposalDismiss"),
    });
    try {
      const result = shouldRemember
        ? await window.assistantClient.approveMemoryProposal(event.sessionId, key)
        : await window.assistantClient.dismissMemoryProposal(event.sessionId, key);
      if (!result?.ok) {
        showToast(t("memory.proposalActionFailed"), "error");
      } else if (shouldRemember) {
        showToast(t("memory.proposalApproved"), "success");
      }
    } catch {
      showToast(t("memory.proposalActionFailed"), "error");
    }
  }
}
