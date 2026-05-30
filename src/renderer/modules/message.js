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
  toolSummary,
  syncActivityVisibility,
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
  const awaitingPermission = Boolean(sid && pendingPermissionBySession.has(sid));
  store.set("isBusy", busy);
  setBusyUI(busy);
  syncPermissionDockForActiveSession();

  const promptInput = $("promptInput");
  const blocked = !hasProject || !sid;
  for (const id of ["sendBtn", "promptInput", "attachBtn"]) {
    const el = $(id);
    if (el) el.disabled = blocked || busy;
  }
  if (promptInput) {
    promptInput.placeholder = awaitingPermission
      ? t("composer.placeholderPermission")
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
  clearBusyHeartbeat(sessionId);
  clearToolCards(sessionId);
  view(sessionId).activityLabel = "";

  const v = view(sessionId);
  if (v.activeBubble) {
    v.activeBubble.classList.remove("pending");
  }
  finishActiveTurn(sessionId);
  syncComposerForActiveSession();
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

function getPermissionDock() {
  return $("permissionDock");
}

function hidePermissionDock() {
  const dock = getPermissionDock();
  if (!dock) return;
  dock.replaceChildren();
  dock.hidden = true;
}

function syncPermissionDockForActiveSession() {
  const sid = store.get("activeSessionId");
  const dock = getPermissionDock();
  if (!dock) return;
  const payload = sid ? pendingPermissionBySession.get(sid) : null;
  if (payload) {
    dock.replaceChildren(buildPermissionCard(sid, payload));
    dock.hidden = false;
  } else {
    hidePermissionDock();
  }
}

function dismissPermissionPrompt(sessionId, requestId) {
  if (sessionId) {
    const pending = pendingPermissionBySession.get(sessionId);
    if (!requestId || pending?.requestId === requestId) {
      pendingPermissionBySession.delete(sessionId);
    }
  }
  if (isActiveSession(sessionId)) {
    syncPermissionDockForActiveSession();
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
  refreshBusyIndicators(sessionId);

  pendingPermissionBySession.set(sessionId, payload);
  if (isActiveSession(sessionId)) {
    syncPermissionDockForActiveSession();
    syncComposerForActiveSession();
    showToast(
      payload.toolName === "ExitPlanMode"
        ? t("permission.approvePlanTitle")
        : t("permission.approveActionTitle"),
      "info",
    );
  }
}

function handleEngineNotice(sessionId, payload) {
  if (!sessionId || !payload) return;
  if (payload.level === "stderr" && payload.message) {
    if (isActiveSession(sessionId)) {
      showToast(payload.message, "warning");
    }
    return;
  }
  if (payload.message === "PERMISSION_TIMEOUT") {
    showToast(t("permission.timeout"), "warning");
    return;
  }
  if (payload.level === "progress" && payload.message) {
    view(sessionId).activityLabel = payload.message;
    if (isActiveSession(sessionId) && store.get("isBusy")) {
      updateBusyMeta(sessionId);
    }
  }
}

function applyTurnState(payload) {
  if (!payload?.sessionId) return;
  setSessionRunning(payload.sessionId, Boolean(payload.active));
  if (isActiveSession(payload.sessionId)) {
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

  window.assistantClient.onTool((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    // Clear previous turn diffs on first tool of a new turn
    const v = view(sessionId);
    if (!v.activeTurn) {
      import("./diff-panel.js").then((m) => m.clearDiffEntries(sessionId));
    }
    addToolCard(sessionId, payload.id, payload.name, payload.input);
  });

  window.assistantClient.onToolDone((payload) => {
    const sessionId = payload.sessionId;
    if (!sessionId) return;
    updateToolCard(sessionId, payload.id, payload.status);
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

    clearBusyHeartbeat(sessionId);
    clearToolCards(sessionId);
    view(sessionId).activityLabel = "";

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
