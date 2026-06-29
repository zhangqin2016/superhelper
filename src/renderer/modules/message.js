/**
 * Chat UI — runtime-event driven Assistant Turn Article renderer.
 */

import store from "./state.js";
import {
  $,
  bindPanelScroll,
  detachAutoFollowForUserNavigation,
  initScrollToBottom,
  isNearBottom,
  isUserScrollDetached,
  scrollToBottom,
  scrollToBottomAfterLayout,
} from "./dom.js";
import { revealScrollIntent, shouldLoadOlderOnScroll } from "./scroll-geometry.js";
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
  refreshLiveTurnStatusDisplay,
} from "./turn-view-renderer.js";
import { updateSessionRunningIndicators } from "./project-tree.js";
import { updateTopbarTitles } from "./session-chrome.js";
import { renderMessageQueue } from "./composer.js";
import { addDiffEntry } from "./diff-panel.js";
import { syncWorkbenchEmptyState } from "./workbench-empty.js";
import { collectUnrenderedCommittedMessages } from "./message-render-keys.js";
import { confirmDialog } from "./confirm-dialog.js";
import { renderLiveTaskStrip } from "./live-task-strip.js";
import { showToast } from "./toast.js";

const sessionViews = new Map();
const renderedMessageKeys = new Map();
const liveRenderTimers = new Map();
const LIVE_RENDER_THROTTLE_MS = 150;
let runtimeHeartbeat = null;
const lastRuntimeVisualSig = new Map();
const promptedMemoryProposals = new Set();

function runtimeVisualSig(runtime) {
  const live = runtime.liveTurn;
  if (!live) return `idle:${runtime.phase}:${runtime.committedMessages.length}`;
  const toolSig = [...(live.tools || new Map()).values()]
    .map((tool) => `${tool.id}:${tool.status || ""}`)
    .join(",");
  const subagentSig = [...(live.subagents || new Map()).values()]
    .map((item) => {
      const current = (item.tools || []).find((tool) => tool.id === item.currentToolId) || (item.tools || []).at?.(-1) || {};
      return [
        item.sessionId,
        item.status || "",
        item.phase || "",
        item.phaseDetail || "",
        current.id || "",
        current.status || "",
        current.name || "",
        item.textPreview?.length || 0,
        item.stats?.runningTools || 0,
        item.stats?.doneTools || 0,
        item.stats?.nestedTasks || 0,
      ].join(":");
    })
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
    subagentSig,
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

/**
 * True when the session's panel already shows exactly the current committed-message
 * window — so a session switch can just reveal it instead of tearing it down and
 * re-parsing every message (the costly `force` rebuild). Conservative: any
 * pending (added) message, or a count mismatch (removed message / shifted window),
 * returns false so the caller still does a clean rebuild.
 */
export function isConversationRenderCurrent(sessionId) {
  if (!sessionViews.has(sessionId)) return false;
  const v = sessionViews.get(sessionId);
  if (!v.listEl || !v.listEl.firstChild) return false;
  const keys = renderedMessageKeys.get(sessionId);
  if (!keys || keys.size === 0) return false;
  const runtime = getRuntimeSession(sessionId);
  const renderMessages = committedMessagesForRender(runtime.committedMessages);
  if (keys.size !== renderMessages.length) return false;
  return collectUnrenderedCommittedMessages(renderMessages, keys).length === 0;
}

const COMMITTED_RENDER_CHUNK = 5;
const COMMITTED_INITIAL_WINDOW = 80;
const COMMITTED_WINDOW_THRESHOLD = 160;

// Within a turn, the user message must come before the assistant message. Event
// timing can commit them out of order (e.g. a near-instant local-assistant turn
// where user.committed is dropped as "terminal" and the user message lands after
// the assistant card), which renders the card ABOVE the user. Stable-reorder by
// turn (first appearance) then role so display order is always user → assistant
// without disturbing cross-turn order or messages that have no turnId.
function orderCommittedMessages(messages) {
  const turnFirstSeen = new Map();
  messages.forEach((m, i) => {
    const key = m.turnId || `__i${i}`;
    if (!turnFirstSeen.has(key)) turnFirstSeen.set(key, i);
  });
  const roleRank = (role) => (role === "user" ? 0 : role === "assistant" ? 1 : 2);
  return messages
    .map((m, i) => ({ m, i, key: m.turnId || `__i${i}` }))
    .sort((a, b) => {
      const ta = turnFirstSeen.get(a.key);
      const tb = turnFirstSeen.get(b.key);
      if (ta !== tb) return ta - tb;
      const ra = roleRank(a.m.role);
      const rb = roleRank(b.m.role);
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map((entry) => entry.m);
}

function committedMessagesForRender(messages = [], opts = {}) {
  if (!Array.isArray(messages)) return [];
  const ordered = orderCommittedMessages(messages);
  if (opts.preserveScroll) return ordered;
  if (ordered.length <= COMMITTED_WINDOW_THRESHOLD) return ordered;
  return ordered.slice(-COMMITTED_INITIAL_WINDOW);
}

function cssEscapeId(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}

function scrollPanelToElement(panel, el) {
  if (!panel || !el) return;
  const top = Math.max(0, el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 12);
  detachAutoFollowForUserNavigation(panel);
  panel.scrollTo({ top: Math.min(top, panel.scrollHeight - panel.clientHeight), behavior: "smooth" });
}

// Full prompt list for the conversation minimap — sourced from the DATA model
// (every committed user message), not the windowed DOM, so the rail reflects the
// whole history. Each item carries turnId for on-demand jump.
function buildMinimapItems(runtime) {
  try {
    return orderCommittedMessages(runtime?.committedMessages || [])
      .filter((m) => m && m.role === "user")
      .map((m) => ({ role: "user", turnId: m.turnId || "", label: m.content || "" }));
  } catch {
    return [];
  }
}

// Scroll to a prompt by turnId, loading older history on demand when it isn't in
// the rendered (windowed) DOM yet. Bounded + fail-safe: gives up quietly rather
// than ever breaking scroll.
async function jumpToTurnForSession(sessionId, panel, turnId) {
  if (!panel || !turnId) return;
  const selector = `.messages [data-turn-id="${cssEscapeId(turnId)}"]`;
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

function appendCommittedMessage(sessionId, runtime, message) {
  const anchor = committedInsertAnchor(sessionId, runtime);
  if (message.role === "user") appendUserMessage(sessionId, message, anchor);
  else if (message.role === "assistant") {
    // A scheduled-task draft is shown as its committed CARD (appendFinalAssistantArticle),
    // and its live/streaming article (plain assistant text, no card) is suppressed in
    // renderRuntimeSession. So render the card here in normal committed order instead
    // of skipping it as a still-live turn — otherwise the user sees only the raw text.
    const isScheduledDraft = Boolean(message.meta?.scheduledDraft);
    if (!isScheduledDraft && message.turnId && runtime.liveTurn?.turnId === message.turnId) return;
    appendFinalAssistantArticle(sessionId, message, anchor);
  }
}

// A turn whose committed assistant message is a scheduled-task draft: it is shown as
// the card, so its live text article must not also render.
function committedScheduledDraftTurn(runtime, turnId) {
  return Boolean(turnId) && (runtime.committedMessages || []).some(
    (m) => m.turnId === turnId && m.role === "assistant" && m.meta?.scheduledDraft,
  );
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
  article.className = "runtime-user-message";
  if (message.turnId) article.dataset.turnId = message.turnId; // lets the minimap locate this prompt

  const label = document.createElement("p");
  label.className = "runtime-user-label";
  label.textContent = t("message.userTaskLabel");
  if (message.steer || message.meta?.steer) {
    article.classList.add("is-steer");
    const badge = document.createElement("span");
    badge.className = "runtime-user-steer-badge";
    badge.textContent = t("message.steerBadge");
    label.appendChild(badge);
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
const REWIND_ICON_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a5 5 0 1 0 1.5-3.5"/><path d="M3 2.5V5h2.5"/></svg>';

// "Rewind to here": undo this turn and everything after — in the engine session
// (files + dropped context) and Lily's transcript together. Only offered when the
// turn carries an engine anchor (engineMessageId), and never mid-turn.
function buildRewindAction(sessionId, message) {
  const turnId = message.turnId || message.record?.turnId || "";
  const engineMessageId = message.record?.engineMessageId || "";
  if (!turnId || !engineMessageId) return null;
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
      const res = await window.assistantClient.rewindSession(sessionId, turnId, engineMessageId);
      if (res?.ok) {
        syncCommittedMessages(sessionId, res.conversation || []);
        renderConversation(sessionId, { force: true, forceScrollBottom: true });
      } else {
        showScheduledToast(res?.error === "BUSY" ? t("message.rewindBusy") : t("message.rewindFailed"), "warning");
      }
    } catch (err) {
      showScheduledToast(err?.message || t("message.rewindFailed"), "warning");
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
  const retryable = message.failed || message.record?.terminal === "turn.stalled";
  if (retryable) actions.appendChild(buildRetryAction(sessionId, message));
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
  // Keep the pinned task strip current for the active session even when the
  // visual-signature dedup skips the heavier render below (to-do progress can
  // change without changing that signature).
  if (isActiveSession(sessionId)) renderLiveTaskStrip(runtime.liveTurn || null);
  const sig = runtimeVisualSig(runtime);
  if (!opts.force && lastRuntimeVisualSig.get(sessionId) === sig) return;
  lastRuntimeVisualSig.set(sessionId, sig);

  const panel = view(sessionId).panel;
  const shouldFollow =
    !opts.preserveScroll &&
    isActiveSession(sessionId) &&
    !isUserScrollDetached(panel) &&
    isNearBottom(panel);
  renderCommittedMessages(sessionId);
  if (runtime.liveTurn) {
    if (committedScheduledDraftTurn(runtime, runtime.liveTurn.turnId)) {
      // The committed card already represents this turn — drop the duplicate
      // live text article instead of rendering it after the card.
      const v = view(sessionId);
      const stale = v.liveArticles.get(runtime.liveTurn.turnId);
      if (stale?.isConnected) stale.remove();
      v.liveArticles.delete(runtime.liveTurn.turnId);
    } else {
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
        if (!isActiveSession(sessionId)) return;
        if (!panel.isConnected || !panel.classList.contains("is-active")) return;
        if (view(sessionId).panel !== panel) return;
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
  refreshLiveTurnStatusDisplay(article, live);
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
