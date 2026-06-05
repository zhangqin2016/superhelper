/**
 * Chat UI — runtime-event driven Assistant Turn Article renderer.
 */

import store from "./state.js";
import { $, scrollToBottom, scrollToBottomAfterLayout, bindPanelScroll, initScrollToBottom, isNearBottom } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";
import { processDetailCounts, summarizeTurnProcess } from "./process-summary.js";
import {
  applyRuntimeBatch,
  getRuntimeSession,
  subscribeRuntime,
  canSend,
  canInterrupt,
} from "./session-runtime-store.js";
import { updateSessionRunningIndicators } from "./project-tree.js";
import { updateTopbarTitles } from "./session-chrome.js";
import { renderMessageQueue } from "./composer.js";

const sessionViews = new Map();
const renderedMessageKeys = new Map();
let runtimeHeartbeat = null;

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
  return Boolean(view(sessionId).listEl?.childElementCount);
}

export function resumeLiveSessionUi(sessionId) {
  renderRuntimeSession(sessionId);
  void refreshRuntimeSnapshot(sessionId);
  syncComposerForActiveSession();
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
  return message.id || message.turnId || `${message.role}:${message.timestamp || index}:${index}`;
}

export function renderConversation(sessionId, opts = {}) {
  const v = ensurePanel(sessionId);
  if (!v.listEl) return;
  if (opts.force) {
    v.listEl.replaceChildren();
    v.liveArticles.clear();
    renderedMessageKeys.set(sessionId, new Set());
  }

  renderCommittedMessages(sessionId);
  renderRuntimeSession(sessionId);
}

function renderCommittedMessages(sessionId) {
  const runtime = getRuntimeSession(sessionId);
  const keys = renderedMessageKeys.get(sessionId) || new Set();
  renderedMessageKeys.set(sessionId, keys);

  for (const [index, message] of runtime.committedMessages.entries()) {
    const key = messageKey(message, index);
    if (keys.has(key)) continue;
    keys.add(key);
    if (message.role === "user") appendUserMessage(sessionId, message);
    else if (message.role === "assistant") {
      if (message.turnId && runtime.liveTurn?.turnId === message.turnId) continue;
      appendFinalAssistantArticle(sessionId, message);
    }
  }
}

function appendUserMessage(sessionId, message) {
  const v = ensurePanel(sessionId);
  const article = document.createElement("article");
  article.className = "msg msg-user runtime-user-message";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble runtime-user-bubble";
  bubble.textContent = message.content || "";
  renderFiles(bubble, message.files || []);

  article.appendChild(bubble);
  v.listEl?.appendChild(article);
}

function appendFinalAssistantArticle(sessionId, message) {
  const v = ensurePanel(sessionId);
  const article = document.createElement("article");
  article.className = "assistant-turn-article is-sealed";
  if (message.failed) article.dataset.failed = "true";

  const header = document.createElement("div");
  header.className = "assistant-turn-status";
  header.textContent = message.failed ? "处理失败" : "已完成";
  article.appendChild(header);

  const final = document.createElement("div");
  final.className = "assistant-turn-final markdown-body";
  renderMarkdown(final, message.content || "");
  article.appendChild(final);

  v.listEl?.appendChild(article);
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

  article = document.createElement("article");
  article.className = "assistant-turn-article is-live";
  article.dataset.turnId = liveTurn.turnId;

  const status = document.createElement("div");
  status.className = "assistant-turn-status";
  status.dataset.role = "status";
  status.textContent = "正在启动...";

  const narrative = document.createElement("div");
  narrative.className = "assistant-turn-narrative markdown-body";
  narrative.dataset.role = "narrative";

  const process = document.createElement("div");
  process.className = "assistant-turn-process";
  process.dataset.role = "process";

  const prompts = document.createElement("div");
  prompts.className = "assistant-turn-prompts";
  prompts.dataset.role = "prompts";

  const queue = document.createElement("div");
  queue.className = "assistant-turn-queue";
  queue.dataset.role = "queue";

  article.append(status, narrative, process, prompts, queue);
  v.liveArticles.set(liveTurn.turnId, article);
  v.listEl?.appendChild(article);
  return article;
}

function renderRuntimeSession(sessionId) {
  const runtime = getRuntimeSession(sessionId);
  const panel = view(sessionId).panel;
  const shouldFollow = isActiveSession(sessionId) && isNearBottom(panel);
  renderCommittedMessages(sessionId);
  if (runtime.liveTurn) renderLiveTurn(sessionId, runtime.liveTurn, runtime.queue);
  syncComposerForActiveSession();
  updateSessionRunningIndicators();
  updateTopbarTitles();
  if (shouldFollow) scrollToBottomAfterLayout(panel, true);
}

function renderLiveTurn(sessionId, liveTurn, queue) {
  const article = ensureLiveArticle(sessionId, liveTurn);
  article.classList.toggle("is-sealed", Boolean(liveTurn.final));
  article.classList.toggle("is-live", !liveTurn.final);

  const status = article.querySelector('[data-role="status"]');
  if (status) status.textContent = statusText(liveTurn);

  const narrative = article.querySelector('[data-role="narrative"]');
  if (narrative) {
    renderMarkdown(narrative, liveTurn.assistantText || " ");
    narrative.hidden = Boolean(liveTurn.final) || !liveTurn.assistantText;
  }

  renderProcess(article.querySelector('[data-role="process"]'), liveTurn);
  renderPrompts(article.querySelector('[data-role="prompts"]'), sessionId, liveTurn);
  renderQueue(article.querySelector('[data-role="queue"]'), sessionId, queue);

  if (liveTurn.final && !liveTurn.finalRendered) {
    renderFinal(article, liveTurn);
    liveTurn.finalRendered = true;
  }
}

function statusText(liveTurn) {
  const elapsed = Math.max(1, Math.round(((liveTurn.final?.ts || Date.now()) - (liveTurn.startedAt || Date.now())) / 1000));
  if (liveTurn.final) {
    if (liveTurn.final.type === "turn.failed") return "处理失败";
    if (liveTurn.final.type === "turn.interrupted") return "已中断";
    if (liveTurn.final.type === "turn.stalled") return "已停止等待";
    return `Worked for ${elapsed}s`;
  }
  if (liveTurn.phase === "awaiting_user") return "等待你确认";
  if (liveTurn.phase === "tool_running") return `深度思考 · ${elapsed}s · 正在使用工具`;
  if (liveTurn.phase === "streaming") return `深度思考 · ${elapsed}s`;
  return "正在启动...";
}

function renderProcess(root, liveTurn) {
  if (!root) return;
  root.replaceChildren();
  const tools = [...liveTurn.tools.values()];
  const notices = liveTurn.notices || [];
  root.hidden = false;

  const details = document.createElement("details");
  details.className = "assistant-process-group";
  details.open = true;

  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "assistant-process-summary-title";
  title.textContent = summarizeTurnProcess(liveTurn);
  const counts = processDetailCounts(liveTurn);
  const meta = document.createElement("span");
  meta.className = "assistant-process-summary-meta";
  meta.textContent = counts.tools || counts.notices ? `工具 ${counts.tools} · 过程 ${counts.notices}` : "";
  summary.append(title);
  if (meta.textContent) summary.append(meta);
  details.appendChild(summary);

  const explored = countExploredFiles(tools);
  if (explored > 0) {
    const row = document.createElement("div");
    row.className = "assistant-process-notice";
    row.textContent = `已探索 ${explored} 文件`;
    details.appendChild(row);
  }

  if (liveTurn.thinkingText) {
    const thinking = document.createElement("pre");
    thinking.className = "assistant-process-thinking";
    thinking.textContent = liveTurn.thinkingText.trim();
    details.appendChild(thinking);
  }

  for (const event of liveTurn.processEvents || []) {
    const row = renderProcessEventRow(event, liveTurn);
    if (row) details.appendChild(row);
  }
  for (const tool of tools) {
    details.appendChild(renderToolRow(tool));
  }
  for (const notice of notices) {
    const row = document.createElement("div");
    row.className = "assistant-process-notice";
    row.textContent = noticeText(notice);
    details.appendChild(row);
  }
  root.appendChild(details);
}

function renderProcessEventRow(event, liveTurn = null) {
  const payload = event.payload || {};
  if (isTokenOnlyProcessEvent(payload)) return null;
  if (liveTurn?.thinkingText && isThinkingProcessEvent(payload)) return null;
  if (!shouldShowProcessEvent(payload, liveTurn)) return null;
  const row = document.createElement("details");
  row.className = "assistant-process-event";

  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "assistant-process-event-label";
  label.textContent = processEventLabel(payload);
  const kind = document.createElement("span");
  kind.className = "assistant-process-event-kind";
  kind.textContent = processEventKindText(payload);
  summary.append(label, kind);
  row.appendChild(summary);

  const detail = document.createElement("pre");
  detail.className = "assistant-process-event-detail";
  detail.textContent = processEventDetail(payload);
  row.appendChild(detail);
  return row;
}

function isTokenOnlyProcessEvent(payload) {
  if (payload.rawSubtype !== "thinking_tokens") return false;
  const actions = payload.actions || [];
  return actions.length === 1 && actions[0]?.kind === "system_notice";
}

function isThinkingProcessEvent(payload) {
  const actions = payload.actions || [];
  return actions.length === 1 && actions[0]?.kind === "assistant_thinking";
}

function shouldShowProcessEvent(payload, liveTurn = null) {
  const actions = payload.actions || [];
  return actions.some((action) => {
    const kind = action?.kind || "";
    const id = action?.id || "";
    if (
      (kind === "stream_tool_start" || kind === "assistant_tool_use" || kind === "tool_result") &&
      (!liveTurn || (id && liveTurn.tools?.has?.(id)))
    ) {
      return false;
    }
    return kind === "assistant_thinking" ||
      kind === "stream_tool_start" ||
      kind === "assistant_tool_use" ||
      kind === "tool_result" ||
      kind === "permission_check" ||
      kind === "ask_user_question" ||
      kind.startsWith("hook_");
  });
}

function processEventLabel(payload) {
  const action = (payload.actions || []).find((item) => item.kind) || {};
  if (action.kind === "assistant_thinking") return action.text || "Thought";
  if (action.kind === "assistant_text") return action.text || "Assistant text";
  if (action.kind === "assistant_tool_use" || action.kind === "stream_tool_start") {
    return action.name ? `Tool ${action.name}` : "Tool use";
  }
  if (action.kind === "stream_tool_input_delta") return "Tool input";
  if (action.kind === "stream_content_block_stop") return "Tool input complete";
  if (action.kind === "tool_result") return "Tool result";
  if (action.kind?.startsWith?.("hook_")) return action.name ? `Hook ${action.name}` : "Hook";
  if (action.kind === "permission_check") return action.name ? `Permission ${action.name}` : "Permission request";
  if (action.kind === "ask_user_question") return "Question requested";
  if (action.kind === "turn_result") return "Turn result";
  if (action.notice?.detail) return action.notice.detail;
  return payload.summary || payload.rawSubtype || payload.rawType || "Process event";
}

function processEventKindText(payload) {
  const raw = payload.rawSubtype || payload.rawType || "";
  if (!raw || raw === "assistant" || raw === "user") return "";
  if (raw === "content_block_start") return "";
  if (raw === "tool_result") return "";
  return raw;
}

function processEventDetail(payload) {
  const event = payload.event || {};
  const actions = payload.actions || [];
  const detail = {
    type: payload.rawType,
    subtype: payload.rawSubtype,
    actions,
    event,
  };
  return JSON.stringify(detail, null, 2);
}

function countExploredFiles(tools) {
  const paths = new Set();
  for (const tool of tools) {
    const input = tool.input || {};
    const name = String(tool.name || "").toLowerCase();
    if (!/(read|grep|glob|ls)/.test(name)) continue;
    const value = input.path || input.file_path || input.pattern || input.preview;
    if (value) paths.add(String(value));
  }
  return paths.size;
}

function renderToolRow(tool) {
  const row = document.createElement("details");
  row.className = "assistant-tool-row";
  row.dataset.toolId = tool.id || "";
  const filePath = toolFilePath(tool);
  if (filePath) row.dataset.toolFilePath = filePath;
  row.dataset.status = tool.status || "";
  const summary = document.createElement("summary");
  summary.className = "assistant-tool-summary";
  const head = document.createElement("div");
  head.className = "assistant-tool-row-head";
  const cmd = document.createElement("span");
  cmd.className = "assistant-tool-command";
  cmd.textContent = toolPreview(tool);
  const status = document.createElement("span");
  status.className = "assistant-tool-status";
  status.textContent = tool.status === "failed" ? "失败" : tool.status === "running" ? "运行中" : "终端已运行";
  head.append(cmd, status);
  summary.appendChild(head);
  row.appendChild(summary);
  const detail = toolDetail(tool);
  if (detail) {
    const pre = document.createElement("pre");
    pre.className = "assistant-tool-detail";
    pre.textContent = detail;
    row.appendChild(pre);
  }
  return row;
}

function toolFilePath(tool) {
  const input = tool.input || {};
  const name = String(tool.name || "").toLowerCase();
  if (!["write", "edit", "multiedit"].includes(name)) return "";
  return input.file_path || input.path || input.target_file || "";
}

function toolDetail(tool) {
  const parts = [];
  if (tool.input && Object.keys(tool.input).length) {
    const input = { ...tool.input };
    delete input.preview;
    parts.push(JSON.stringify(input, null, 2));
  } else if (tool.partialJson) {
    parts.push(tool.partialJson);
  }
  if (tool.result) {
    const content = typeof tool.result.content === "string"
      ? tool.result.content
      : JSON.stringify(tool.result, null, 2);
    if (content) parts.push(content);
  }
  return parts.join("\n\n");
}

function toolPreview(tool) {
  const input = tool.input || {};
  const name = tool.name || "工具调用";
  const lowerName = String(name).toLowerCase();
  if (lowerName === "bash" && input.command) return `Bash ${input.command}`;
  if ((lowerName === "glob" || lowerName === "grep") && input.pattern) {
    return `${name} ${input.pattern}`;
  }
  if (lowerName === "read" && (input.file_path || input.path)) {
    return `Read ${input.file_path || input.path}`;
  }
  return input.preview || input.command || input.file_path || input.path || name;
}

function noticeText(event) {
  if (event.type === "permission.timeout") return t("permission.timeout");
  if (event.type === "recovery.scheduled") return `连接中断，准备自动重试 ${event.payload?.attempt || 1}/${event.payload?.maxAttempts || 1}`;
  if (event.type === "recovery.started") return "正在重新连接...";
  const payload = event.payload || {};
  const notice = payload.notice || payload;
  if (notice.code === "waitingForFirstResponse") return t("engine.waitingForFirstResponse");
  if (notice.code === "longWait") return t("engine.longWait");
  if (notice.code === "thinkingProgress") return notice.detail || "正在思考";
  if (notice.code === "taskProgress") return notice.detail || "正在处理";
  if (notice.code === "apiRetry") return notice.detail ? `正在重试：${notice.detail}` : "正在重试请求";
  if (notice.code === "permissionDenied") return notice.detail || "权限被拒绝";
  return notice.detail || notice.message || notice.code || event.type;
}

function renderPrompts(root, sessionId, liveTurn) {
  if (!root) return;
  root.replaceChildren();
  const entries = [
    ...liveTurn.permissions.values(),
    ...liveTurn.questions.values(),
    ...liveTurn.hooks.values(),
  ];
  root.hidden = entries.length === 0;
  for (const item of entries) {
    if (item.questions) root.appendChild(questionCard(sessionId, item));
    else if (item.hookName) root.appendChild(hookCard(sessionId, item));
    else root.appendChild(permissionCard(sessionId, item));
  }
}

function permissionCard(sessionId, item) {
  const card = promptCard("需要你的确认", item.toolName || item.title || "工具调用");
  const actions = actionRow();
  actions.append(
    button("批准", async () => window.assistantClient.respondPermission(sessionId, item.requestId, true)),
    button("拒绝", async () => window.assistantClient.respondPermission(sessionId, item.requestId, false)),
    button("批准并记住", async () => window.assistantClient.respondPermission(sessionId, item.requestId, true, { remember: true })),
  );
  card.appendChild(actions);
  return card;
}

function hookCard(sessionId, item) {
  const card = promptCard("需要确认 Hook", item.hookName || "Hook");
  const actions = actionRow();
  actions.append(
    button("允许", async () => window.assistantClient.respondHook(sessionId, item.requestId, true)),
    button("阻止", async () => window.assistantClient.respondHook(sessionId, item.requestId, false)),
  );
  card.appendChild(actions);
  return card;
}

function questionCard(sessionId, item) {
  const card = promptCard("助手需要你补充信息", "");
  const questions = item.questions || [];
  for (const question of questions) {
    const label = document.createElement("label");
    label.className = "assistant-question-label";
    label.textContent = question.question || "请补充你的回答";
    const input = document.createElement("textarea");
    input.className = "assistant-question-input";
    input.rows = 2;
    input.dataset.questionId = question.id || "answer";
    card.append(label, input);
  }
  const actions = actionRow();
  actions.appendChild(button("提交", async () => {
    const answers = {};
    for (const input of card.querySelectorAll(".assistant-question-input")) {
      answers[input.dataset.questionId] = input.value;
    }
    return window.assistantClient.respondUserQuestion(sessionId, item.requestId, answers, Object.values(answers).join("\n"));
  }));
  card.appendChild(actions);
  return card;
}

function promptCard(title, detail) {
  const card = document.createElement("section");
  card.className = "assistant-prompt-card";
  const h = document.createElement("strong");
  h.textContent = title;
  card.appendChild(h);
  if (detail) {
    const p = document.createElement("p");
    p.textContent = detail;
    card.appendChild(p);
  }
  return card;
}

function actionRow() {
  const row = document.createElement("div");
  row.className = "assistant-prompt-actions";
  return row;
}

function button(label, action) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "assistant-action-btn";
  btn.textContent = label;
  btn.addEventListener("click", async () => {
    try {
      const result = await action();
      if (!result?.ok) showToast(result?.detail || result?.error || "操作失败", "warning");
    } catch (err) {
      showToast(err?.message || "操作失败", "error");
    }
  });
  return btn;
}

function renderQueue(root, sessionId, queue) {
  if (!root) return;
  root.replaceChildren();
  root.hidden = !queue?.length;
  if (!queue?.length) return;
  const title = document.createElement("div");
  title.className = "assistant-queue-title";
  title.textContent = `队列中 ${queue.length} 条`;
  root.appendChild(title);
  for (const item of queue) {
    const row = document.createElement("div");
    row.className = "assistant-queue-item";
    const text = document.createElement("span");
    text.textContent = item.text || "附件消息";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", async () => {
      const result = await window.assistantClient.cancelQueuedMessage(sessionId, item.id);
      if (!result?.ok) showToast(t("toast.queueCancelFailed"), "warning");
    });
    row.append(text, remove);
    root.appendChild(row);
  }
}

function renderFinal(article, liveTurn) {
  if (article.querySelector(".assistant-turn-separator")) return;
  const separator = document.createElement("div");
  separator.className = "assistant-turn-separator";
  const final = document.createElement("div");
  final.className = "assistant-turn-final markdown-body";
  renderMarkdown(final, liveTurn.final?.payload?.assistant || liveTurn.assistantText || "");
  article.append(separator, final);
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

export function syncComposerForActiveSession() {
  const sid = store.get("activeSessionId");
  const busy = sid ? !canSend(sid) : false;
  store.set("isBusy", busy);
  store.set("runningSessionId", busy ? sid : null);
  const input = $("promptInput");
  const submit = $("sendBtn");
  const interrupt = $("interruptBtn");
  if (input) {
    input.placeholder = busy
      ? canInterrupt(sid) ? "助手正在处理，继续发送会加入队列..." : "等待处理中..."
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
      if (runtime.liveTurn && !runtime.liveTurn.final) renderRuntimeSession(sid);
    }, 1000);
  }
}

export function wireMessageIpc() {
  window.assistantClient.onRuntimeEvents?.((batch) => {
    applyRuntimeBatch(batch);
  });
  window.assistantClient.onFileDiff?.(() => {
    const sid = store.get("activeSessionId");
    if (sid) renderRuntimeSession(sid);
  });
  subscribeRuntime(() => {
    for (const sessionId of sessionViews.keys()) renderRuntimeSession(sessionId);
    const active = store.get("activeSessionId");
    if (active) renderRuntimeSession(active);
  });
}
