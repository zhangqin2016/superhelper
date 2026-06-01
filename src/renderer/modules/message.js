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
  canSend,
  canInterrupt,
  getTurnPhase,
  applyTurnState as storeTurnState,
  syncRunningFromState,
} from "./session-busy.js";
import { showToast } from "./toast.js";
import { renderMessageQueue } from "./composer.js";
import { updateSessionRunningIndicators } from "./project-tree.js";
import {
  addToolCard as addToolCardImpl,
  addToolCardPlaceholder as addToolCardPlaceholderImpl,
  updateToolCardInput as updateToolCardInputImpl,
  finalizeToolCardInput as finalizeToolCardInputImpl,
  updateToolCard as updateToolCardImpl,
  clearToolCards as clearToolCardsImpl,
  collapseToolCards as collapseToolCardsImpl,
  updateToolCardProgress as updateToolCardProgressImpl,
  syncTurnProgress as syncTurnProgressImpl,
  refreshRunningActivityLabel,
  countRunningTools,
  toolSummary,
  syncActivityVisibility,
} from "./tool-cards.js";
import {
  addOrUpdateEngineNotice,
  engineNoticeText,
} from "./engine-notices.js";

const stackEl = () => $("sessionMessagesStack");

/** @type {Map<string, {
 *   panel: HTMLElement,
 *   listEl: HTMLElement,
 *   activeTurn: { article: HTMLElement, activity: HTMLElement, bubble: HTMLElement } | null,
 *   toolCards: Map<string, { card: HTMLElement, name: string, input: object, status: string }>,
 *   engineNotices: Map<string, { card: HTMLElement, code: string, status: string }>,
 *   activeMarkdown: string,
 *   activeBubble: HTMLElement | null,
 *   activityLabel: string,
 * }>} */
const sessionViews = new Map();

/** @type {Map<string, ReturnType<typeof setInterval>>} */
const busyHeartbeats = new Map();

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

/** Keep visible “still working” cues when the engine is silent (tools/subagents). */
function refreshBusyIndicators(sessionId) {
  if (!sessionId || canSend(sessionId)) {
    clearBusyHeartbeat(sessionId);
    return;
  }

  const phase = getTurnPhase(sessionId);
  if (
    ["streaming", "tool", "permission"].includes(phase) &&
    !hasLiveTurn(sessionId)
  ) {
    beginAssistantTurn(sessionId);
  }

  const v = view(sessionId);
  if (v.activeBubble) {
    v.activeBubble.classList.add("pending");
  }
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

function view(sessionId) {
  if (!sessionViews.has(sessionId)) {
    sessionViews.set(sessionId, {
      panel: null,
      listEl: null,
      activeTurn: null,
      toolCards: new Map(),
      engineNotices: new Map(),
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
  const awaitingPermission = Boolean(sid && pendingPermissionBySession.has(sid));
  const queueCount = sid ? getQueuedMessageCount(sid) : 0;
  store.set("isBusy", busy);
  setBusyUI(busy);

  const promptInput = $("promptInput");
  const blocked = !hasProject || !sid;
  for (const id of ["sendBtn", "promptInput", "attachBtn"]) {
    const el = $(id);
    if (el) el.disabled = blocked;
  }
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

// --- Tool card wrappers (delegate to tool-cards.js) ---

function addToolCard(sessionId, id, name, input, parentToolUseId) {
  if (!view(sessionId).activeTurn) beginAssistantTurn(sessionId);
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

export function beginAssistantTurn(sessionId) {
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

  const divider = document.createElement("div");
  divider.className = "turn-section-divider";
  divider.hidden = true;
  const dividerSpan = document.createElement("span");
  dividerSpan.textContent = t("turn.reply");
  divider.appendChild(dividerSpan);

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble pending";

  body.append(activity, divider, bubble);
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
  collapseToolCards(sessionId);
  if (v.activeTurn?.activity) {
    v.activeTurn.activity.hidden = false;
  }
  v._lastRenderedLength = 0;
  v.activeTurn = null;
  v.activeBubble = null;
  v.activeMarkdown = "";
  v.turnHadToolUse = false;
  if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
}

/** Collapse the in-flight assistant turn before appending a user bubble (queue flush / IPC race). */
function finalizeTurnUi(sessionId) {
  const v = view(sessionId);
  if (!v.activeTurn && !v.activeBubble) return;

  const hadReply =
    v.activeMarkdown.trim().length > 0 ||
    (v.activeBubble?.textContent?.trim().length > 0);
  if (v.activeBubble) {
    v.activeBubble.classList.remove("pending");
    if (!hadReply) {
      v.activeBubble.remove();
      v.activeBubble = null;
    }
  }
  finishActiveTurn(sessionId);
  sealLastTurnArticle(sessionId);
}

function sealLastTurnArticle(sessionId) {
  const listEl = view(sessionId).listEl;
  if (!listEl) return;
  const turn = listEl.querySelector(".msg-turn:last-of-type");
  if (!turn) return;

  const activity = turn.querySelector(".tool-activity");
  if (!activity) return;

  activity.querySelector(".turn-progress-slot")?.replaceChildren();
  activity.querySelectorAll(".turn-progress").forEach((el) => el.remove());

  const hasCards = activity.querySelector(".tool-card");
  const hasEngine = activity.querySelector(".engine-notice-card");
  const bar = activity.querySelector(".tool-summary-bar");
  const barVisible = bar && !bar.hidden;
  if (!hasCards && !hasEngine && !barVisible) {
    activity.hidden = true;
  }
}

function appendCommittedUserMessage(sessionId, text, files) {
  if (hasLiveTurn(sessionId)) {
    finalizeTurnUi(sessionId);
  }
  createMessage(sessionId, "user", text, files);
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

function showPermissionPrompt(sessionId, payload) {
  if (!sessionId || !payload?.requestId) return;

  beginAssistantTurn(sessionId);
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

function handleEngineNotice(sessionId, payload) {
  if (!sessionId || !payload) return;

  const showPanel = payload.panel !== false;
  const text = engineNoticeText(payload);

  if (showPanel) {
    if (!hasLiveTurn(sessionId)) beginAssistantTurn(sessionId);
    addOrUpdateEngineNotice(view(sessionId), payload);
    const v = view(sessionId);
    // Meaningful progress (compaction, retry) updates the single activity line;
    // do not overwrite tool-card-driven labels for generic engine codes.
    if (text && payload.replace) v.activityLabel = text;
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

  if (["streaming", "tool", "permission"].includes(phase) && !hasLiveTurn(sessionId)) {
    beginAssistantTurn(sessionId);
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
  }

  if (sessionId && !canSend(sessionId)) {
    refreshBusyIndicators(sessionId);
  }

  if (isActiveSession(sessionId)) {
    syncComposerForActiveSession();
  }
  updateSessionRunningIndicators();
}

export function wireMessageIpc() {
  window.assistantClient.onFileDiff?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    import("./diff-panel.js").then((m) => m.addDiffEntry(sessionId, payload));
  });

  window.assistantClient.onTurnState?.(applyTurnState);

  window.assistantClient.onQueueState?.((payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    setQueuedMessageCount(sessionId, payload.queueLength || 0);
    setQueuedMessageItems(sessionId, payload.items || []);
    renderMessageQueue(sessionId, payload.items || []);
    if (isActiveSession(sessionId)) syncComposerForActiveSession();
  });

  window.assistantClient.onUserMessage?.((payload) => {
    const sessionId = payload?.sessionId;
    if (!sessionId) return;
    appendCommittedUserMessage(sessionId, payload.text || "", payload.files || null);
    if (isActiveSession(sessionId)) syncActiveStoreFromView(sessionId);
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
    const v = view(sessionId);
    if (!v.activeTurn) {
      import("./diff-panel.js").then((m) => m.clearDiffEntries(sessionId));
    }
    // If a placeholder card already exists (from content_block_start), finalize it
    if (v.toolCards.has(payload.id)) {
      finalizeToolCardInputImpl(v, payload.id, payload.input);
    } else {
      addToolCard(sessionId, payload.id, payload.name, payload.input, payload.parentToolUseId);
    }
  });

  // Placeholder card from content_block_start (name/id only, no input yet)
  window.assistantClient.onToolUpcoming?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    const v = view(sessionId);
    if (!v.activeTurn) beginAssistantTurn(sessionId);
    v.turnHadToolUse = true;
    addToolCardPlaceholderImpl(v, payload.id, payload.name, payload.parentToolUseId);
  });

  // Streaming tool input from input_json_delta
  window.assistantClient.onToolInputDelta?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    updateToolCardInputImpl(view(sessionId), payload.id, payload.partialJson);
  });

  // Tool input complete (from assistant event, for pre-created cards)
  window.assistantClient.onToolInputDone?.((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    finalizeToolCardInputImpl(view(sessionId), payload.id, payload.input);
  });

  window.assistantClient.onToolDone((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    updateToolCard(sessionId, payload.id, payload.status, payload.result);
  });

  window.assistantClient.onPermissionRequest((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    showPermissionPrompt(sessionId, payload);
  });

  window.assistantClient.onPermissionCancelled((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId || !payload.requestId) return;
    dismissPermissionPrompt(sessionId, payload.requestId);
  });

  window.assistantClient.onEngineNotice((payload) => {
    handleEngineNotice(payload.sessionId, payload);
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

    // Show divider between tool steps and reply on first text
    if (v.turnHadToolUse && v.activeTurn) {
      const divider = v.activeTurn.article.querySelector(".turn-section-divider");
      if (divider) divider.hidden = false;
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
  });

  window.assistantClient.onDone(async (payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;

    clearBusyHeartbeat(sessionId);
    view(sessionId).activityLabel = "";

    const v = view(sessionId);
    const hadReply =
      v.activeMarkdown.trim().length > 0 ||
      (v.activeBubble?.textContent?.trim().length > 0);
    finalizeTurnUi(sessionId);

    if (payload.stalled && isActiveSession(sessionId) && !hadReply) {
      showToast(t("message.stalledHint"), "info");
    }

    // Unblock composer immediately, before the async refresh
    if (isActiveSession(sessionId)) {
      syncComposerForActiveSession();
    }

    await refreshStateLight({ reRenderActive: isActiveSession(sessionId) });

    if (isActiveSession(sessionId)) {
      $("promptInput")?.focus();
      syncComposerForActiveSession();
    }
  });

  window.assistantClient.onStatus((status) => {
    const sessionId = status.sessionId;
    if (!sessionId) return;
    if (status.state === "thinking") {
      if (!view(sessionId).activeBubble) beginAssistantTurn(sessionId);
      refreshBusyIndicators(sessionId);
    }
    if (isActiveSession(sessionId)) syncComposerForActiveSession();
    updateSessionRunningIndicators();
  });

  window.assistantClient.onError(async (error) => {
    const sessionId = error.sessionId;
    if (!sessionId) return;

    clearBusyHeartbeat(sessionId);
    clearToolCards(sessionId);

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

    if (isActiveSession(sessionId)) syncComposerForActiveSession();

    await refreshStateLight({ reRenderActive: isActiveSession(sessionId) });

    if (isActiveSession(sessionId)) {
      $("promptInput")?.focus();
      syncComposerForActiveSession();
    }
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
