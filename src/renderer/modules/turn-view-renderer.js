import { renderMarkdown, renderStreamingMarkdown } from "./markdown.js";
import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";
import { confirmDialog } from "./confirm-dialog.js";
import {
  appendToolPayloadDetail,
  parseGeneratedMedia,
  parseToolResult,
  toolInputHasRenderableDetail,
} from "./tool-payload-renderer.js";
import {
  getRenderableTimeline,
  resolveNoticeDetail,
  toolPreview,
} from "./turn-timeline.js";
import {
  classifyToolCategory,
  groupToolsByCategory,
  isTodoTool,
  parseTodoEntries,
  partitionTimeline,
  processGroupSummary,
  categorySummaryKey,
  shouldCollapseProcessGroups,
  resolveAssistantStreamText,
  shouldShowFinal,
  shouldShowNarrative,
  toolEntryToRenderTool,
  toolRowPreview,
} from "./turn-process-layout.js";
import {
  getSessionDiffEntries,
  reapplySessionInlineDiffs,
} from "./diff-panel.js";
import {
  buildLiveStatusText,
  buildStatusFooterText,
  buildStatusText,
  buildThinkingSummaryLabel,
  timelineForView,
} from "./turn-view-status.js";

const narrativeRenderState = new Map();
const questionDrafts = new Map();
const LIVE_STATUS_STYLE = "15px";

function questionDraftKey(sessionId, requestId) {
  return `${sessionId || ""}:${requestId || ""}`;
}

function getQuestionDraft(sessionId, requestId) {
  const key = questionDraftKey(sessionId, requestId);
  if (!questionDrafts.has(key)) {
    questionDrafts.set(key, {
      selections: new Map(),
      text: new Map(),
    });
  }
  return questionDrafts.get(key);
}

function pruneQuestionDrafts(sessionId, activeRequestIds) {
  const prefix = `${sessionId || ""}:`;
  for (const key of questionDrafts.keys()) {
    if (!key.startsWith(prefix)) continue;
    const requestId = key.slice(prefix.length);
    if (!activeRequestIds.has(requestId)) questionDrafts.delete(key);
  }
}

function setQuestionSelection(draft, questionId, value, { multiSelect }) {
  const current = new Set(draft.selections.get(questionId) || []);
  if (multiSelect) {
    if (current.has(value)) current.delete(value);
    else current.add(value);
  } else {
    current.clear();
    current.add(value);
  }
  if (current.size) draft.selections.set(questionId, current);
  else draft.selections.delete(questionId);
  return current;
}

function thinkingSummaryLabel(text, live = false) {
  return buildThinkingSummaryLabel(text, live, t);
}

function applyStatusDisplay(statusEl, text, { sealed = false, live = false } = {}) {
  if (!statusEl) return;
  statusEl.hidden = !text;
  if (!text) return;
  statusEl.classList.toggle("is-sealed-duration", sealed && live === false);
  if (live) {
    statusEl.style.fontSize = LIVE_STATUS_STYLE;
    statusEl.style.fontWeight = "500";
    statusEl.style.lineHeight = "1.65";
  } else {
    statusEl.style.fontSize = "";
    statusEl.style.fontWeight = "";
    statusEl.style.lineHeight = "";
  }
  if (statusEl.dataset.lastText === text) return;
  statusEl.textContent = text;
  statusEl.dataset.lastText = text;
}

function resolveTurnDiffEntries(liveTurn, sessionId) {
  if (Array.isArray(liveTurn.fileChanges) && liveTurn.fileChanges.length) {
    return liveTurn.fileChanges;
  }
  if (sessionId && liveTurn.turnId) {
    return getSessionDiffEntries(sessionId, liveTurn.turnId);
  }
  return [];
}

function scheduleNarrativeMarkdown(textEl, text, turnId) {
  if (!textEl || !turnId) return;
  const key = turnId;
  let state = narrativeRenderState.get(key);
  if (!state) {
    state = { timer: null, pending: text };
    narrativeRenderState.set(key, state);
  } else {
    state.pending = text;
  }

  if (textEl.dataset.streamText === text) return;

  if (!textEl.dataset.streamText) {
    renderStreamingMarkdown(textEl, text);
    textEl.dataset.streamText = text;
    return;
  }

  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    const next = state.pending || "";
    if (!next || textEl.dataset.streamText === next) return;
    renderStreamingMarkdown(textEl, next);
    textEl.dataset.streamText = next;
  }, 120);
}

function narrativeImageKey(contentBlocks = []) {
  return contentBlocks
    .filter((b) => b.blockType === "image" && b.data)
    .map((b) => `${b.mediaType || "image/png"}:${b.data.length}`)
    .join("|");
}

/** Minimal liveTurn for assistant messages saved before TurnRecord existed. */
export function legacyLiveTurnFromMessage(message) {
  const ts = message?.timestamp ? Date.parse(message.timestamp) : Date.now();
  const safeTs = Number.isFinite(ts) ? ts : Date.now();
  const terminal = message?.failed
    ? "turn.failed"
    : message?.meta?.terminal || "turn.completed";
  return {
    turnId: message?.turnId || message?.id || `legacy_${safeTs}`,
    phase: "done",
    assistantText: message?.content || "",
    thinkingText: "",
    contentBlocks: [],
    protocolUnknown: [],
    processEvents: [],
    timeline: [],
    activityLabel: null,
    durationMs: null,
    totalCostUsd: null,
    usage: null,
    tools: new Map(),
    notices: [],
    permissions: new Map(),
    questions: new Map(),
    hooks: new Map(),
    startedAt: safeTs,
    updatedAt: safeTs,
    final: {
      type: terminal,
      payload: { assistant: message?.content || "" },
      ts: safeTs,
    },
    finalRendered: false,
  };
}

export function liveTurnFromRecord(record) {
  const tools = new Map();
  for (const tool of record?.tools || []) {
    if (tool?.id) tools.set(tool.id, tool);
  }
  const processEvents = (record?.processEvents || []).map((payload) => ({
    type: "process.event",
    payload: payload?.payload || payload,
  }));
  const notices = (record?.notices || []).map((event) => (
    event?.type ? event : { type: "engine.notice", payload: { notice: event } }
  ));
  return {
    turnId: record.turnId,
    phase: "done",
    assistantText: record.assistantText || "",
    thinkingText: record.thinkingText || "",
    contentBlocks: record.contentBlocks || [],
    protocolUnknown: record.protocolUnknown || [],
    processEvents,
    timeline: record.timeline || [],
    activityLabel: record.activityLabel || null,
    durationMs: record.durationMs ?? null,
    totalCostUsd: record.totalCostUsd ?? null,
    usage: record.usage ?? null,
    tools,
    fileChanges: record.fileChanges || [],
    notices,
    permissions: new Map(),
    questions: new Map(),
    hooks: new Map(),
    startedAt: record.startedAt || Date.now(),
    updatedAt: record.endedAt || Date.now(),
    final: {
      type: record.terminal || "turn.completed",
      payload: { assistant: record.assistantText || "" },
      ts: record.endedAt || Date.now(),
    },
    finalRendered: false,
  };
}

export function createLiveTurnArticleShell(liveTurn) {
  const article = document.createElement("article");
  article.className = "assistant-turn-article is-live";
  article.dataset.turnId = liveTurn.turnId || "";

  const header = document.createElement("header");
  header.className = "assistant-turn-header";
  header.dataset.role = "header";

  const status = document.createElement("div");
  status.className = "assistant-turn-status";
  status.dataset.role = "status";
  status.textContent = liveStatusText(liveTurn);

  header.append(status);

  const narrative = document.createElement("div");
  narrative.className = "assistant-turn-narrative markdown-body";
  narrative.dataset.role = "narrative";

  const process = document.createElement("div");
  process.className = "assistant-turn-process";
  process.dataset.role = "process";

  const footer = document.createElement("div");
  footer.className = "assistant-turn-footer";
  footer.dataset.role = "footer";
  footer.hidden = true;

  const prompts = document.createElement("div");
  prompts.className = "assistant-turn-prompts";
  prompts.dataset.role = "prompts";

  article.append(header, narrative, process, footer, prompts);
  return article;
}

export function renderLiveTurnArticle(article, liveTurn, ctx = {}) {
  const { sessionId, failed = false } = ctx;
  const sealed = Boolean(liveTurn.final) || ctx.sealed;
  article.classList.toggle("is-sealed", sealed);
  article.classList.toggle("is-live", !sealed);
  article.classList.toggle("is-working", !sealed && liveTurn.phase === "starting");

  const status = article.querySelector('[data-role="status"]');
  const header = article.querySelector('[data-role="header"]');
  if (status) {
    const text = statusText(liveTurn, failed, sealed);
    applyStatusDisplay(status, text, { sealed: sealed && Boolean(liveTurn.final), live: !sealed });
  }
  if (header) header.hidden = !status?.textContent;

  renderFooter(article.querySelector('[data-role="footer"]'), liveTurn, sealed);

  const narrativeKey = [
    resolveAssistantStreamText(liveTurn),
    liveTurn.final?.type || "",
    (liveTurn.contentBlocks || []).length,
    narrativeImageKey(liveTurn.contentBlocks || []),
  ].join("|");
  if (article.dataset.narrativeKey !== narrativeKey) {
    renderNarrative(article.querySelector('[data-role="narrative"]'), liveTurn);
    article.dataset.narrativeKey = narrativeKey;
  }
  renderProcess(article.querySelector('[data-role="process"]'), liveTurn, { sessionId, sealed });
  if (sessionId) {
    renderPrompts(article.querySelector('[data-role="prompts"]'), sessionId, liveTurn);
  }

  if (liveTurn.final && !liveTurn.finalRendered) {
    renderFinal(article, liveTurn);
    liveTurn.finalRendered = true;
  }
}

export function renderSealedTurnArticle(liveTurn, failed = false) {
  const article = createLiveTurnArticleShell(liveTurn);
  article.className = "assistant-turn-article is-sealed";
  if (failed) article.dataset.failed = "true";
  renderLiveTurnArticle(article, liveTurn, { failed, sealed: true });
  return article;
}

function syncNarrativeImages(root, contentBlocks = []) {
  const images = contentBlocks.filter((b) => b.blockType === "image" && b.data);
  const imageKey = images.map((b) => `${b.mediaType || "image/png"}:${b.data.length}`).join("|");
  if (root.dataset.imageKey === imageKey) return;
  root.dataset.imageKey = imageKey;
  root.querySelectorAll(".assistant-content-image").forEach((node) => node.remove());
  for (const block of images) {
    const img = document.createElement("img");
    img.className = "assistant-content-image";
    img.alt = "Assistant image";
    img.src = `data:${block.mediaType || "image/png"};base64,${block.data}`;
    root.appendChild(img);
  }
}

function renderNarrative(root, liveTurn) {
  if (!root) return;
  const text = resolveAssistantStreamText(liveTurn);
  const hasImages = (liveTurn.contentBlocks || []).some((b) => b.blockType === "image" && b.data);
  const show = shouldShowNarrative(liveTurn);
  root.hidden = !show && !hasImages;
  if (root.hidden) {
    root.replaceChildren();
    delete root.dataset.imageKey;
    return;
  }

  let textEl = root.querySelector(".assistant-turn-narrative-text");
  if (text) {
    if (!textEl) {
      textEl = document.createElement("div");
      textEl.className = "assistant-turn-narrative-text markdown-body";
      root.prepend(textEl);
    }
    scheduleNarrativeMarkdown(textEl, text, liveTurn.turnId || "live");
  } else if (textEl) {
    textEl.remove();
    if (liveTurn.turnId) narrativeRenderState.delete(liveTurn.turnId);
  }

  syncNarrativeImages(root, liveTurn.contentBlocks || []);
}

function renderFooter(root, liveTurn, sealed) {
  if (!root) return;
  root.textContent = "";
  root.hidden = true;
}

function liveStatusText(liveTurn) {
  return buildLiveStatusText(liveTurn, t);
}

function statusText(liveTurn, failed = false, sealed = false) {
  return buildStatusText(liveTurn, { failed, sealed }, t);
}

function statusFooterText(liveTurn) {
  return buildStatusFooterText(liveTurn, t);
}

function processStructureSig(liveTurn, sealed, sessionId) {
  const timeline = timelineForView(liveTurn, sealed);
  const diffCount = resolveTurnDiffEntries(liveTurn, sessionId).length;
  const collapsed = shouldCollapseProcessGroups(liveTurn, sealed);
  const parts = [collapsed ? "collapsed" : "flat", String(diffCount)];
  if (collapsed) {
    const { thinking, notices, tools, texts } = partitionTimeline(timeline);
    parts.push(`thinking:${thinking.map((entry) => `${entry.id || ""}.${entry.status || ""}`).join(",")}`);
    parts.push(`texts:${texts.map((entry) => entry.id || "").join(",")}`);
    parts.push(`notices:${notices.length}`);
    for (const entry of tools) {
      parts.push(`tool:${entry.id}:${entry.status || ""}`);
    }
  } else {
    for (const entry of timeline) {
      parts.push(`${entry.kind}:${entry.id || entry.code || ""}:${entry.status || ""}`);
    }
  }
  return parts.join("|");
}

function detailsOpenStateKey(details) {
  if (details.dataset.toolId) return details.dataset.toolId;
  if (details.dataset.thinkingId) return `thinking:${details.dataset.thinkingId}`;
  return details.className;
}

function collectDetailsOpenState(root) {
  const map = new Map();
  for (const details of root.querySelectorAll("details")) {
    map.set(detailsOpenStateKey(details), details.open);
  }
  return map;
}

function restoreDetailsOpenState(root, openState, { live = false } = {}) {
  for (const details of root.querySelectorAll("details")) {
    if (live && details.classList.contains("is-live") &&
        details.classList.contains("assistant-process-thinking-group")) {
      details.open = true;
      continue;
    }
    const key = detailsOpenStateKey(details);
    if (openState.has(key)) details.open = openState.get(key);
  }
}

function patchLiveProcessDom(root, liveTurn, ctx) {
  const { sealed = Boolean(liveTurn.final) } = ctx;
  const timeline = timelineForView(liveTurn, sealed);
  const { thinking, notices, tools } = partitionTimeline(timeline);
  const summary = root.querySelector(".assistant-process-group summary");
  if (summary) {
    const next = processGroupSummary(tools.filter((entry) => !isTodoTool(entry.name)), notices, t);
    if (summary.textContent !== next) summary.textContent = next;
  }
  for (const entry of timeline) {
    if (entry.kind === "tool" && isTodoTool(entry.name)) {
      const card = root.querySelector(`.assistant-todo-card[data-tool-id="${CSS.escape(entry.id)}"]`);
      if (!card) return false;
      const todos = parseTodoEntries(entry);
      const done = todos.filter((todo) => todo.status === "completed").length;
      const summaryEl = card.querySelector(".assistant-todo-summary");
      const nextSummary = t("todo.summary", { done, total: todos.length });
      if (summaryEl && summaryEl.textContent !== nextSummary) summaryEl.textContent = nextSummary;
      renderTodoItems(card.querySelector(".assistant-todo-items"), todos);
    } else if (entry.kind === "tool") {
      const row = root.querySelector(`.assistant-tool-row[data-tool-id="${CSS.escape(entry.id)}"]`);
      if (!row) return false;
      const preview = toolRowPreview(entry);
      const cmd = row.querySelector(".assistant-tool-command");
      const statusEl = row.querySelector(".assistant-tool-status");
      const tool = toolEntryToRenderTool(entry);
      const statusLabel = toolStatusLabel(tool) + toolDurationSuffix(entry);
      if (cmd && cmd.textContent !== preview) cmd.textContent = preview;
      if (statusEl && statusEl.textContent !== statusLabel) statusEl.textContent = statusLabel;
      if (row.dataset.status !== (entry.status || "")) row.dataset.status = entry.status || "";
    } else if (entry.kind === "thinking") {
      const selector = `.assistant-process-thinking-group[data-thinking-id="${CSS.escape(entry.id || "")}"]`;
      const group = root.querySelector(selector);
      const pre = group?.querySelector(".assistant-process-thinking");
      const text = entry.text?.trim() || "";
      if (!pre || !group) return false;
      const isLive = !sealed && entry.status !== "done";
      if (isLive) group.open = true;
      const summaryEl = group.querySelector(".assistant-process-thinking-summary");
      const nextSummary = thinkingSummaryLabel(entry, isLive);
      if (summaryEl && summaryEl.textContent !== nextSummary) {
        summaryEl.textContent = nextSummary;
      }
      if (pre.textContent !== text) {
        pre.textContent = text;
        pre.scrollTop = pre.scrollHeight;
      }
    } else if (entry.kind === "text") {
      // Inline prose blocks are immutable once renderable; a missing node
      // means the structure changed and a full re-render is needed.
      const node = root.querySelector(`.assistant-turn-inline-text[data-text-id="${CSS.escape(entry.id || "")}"]`);
      if (!node) return false;
    }
  }
  return true;
}

function renderProcess(root, liveTurn, ctx = {}) {
  if (!root) return;
  const { sessionId, sealed = Boolean(liveTurn.final) } = ctx;
  const structureSig = processStructureSig(liveTurn, sealed, sessionId);
  if (!sealed && root.dataset.processSig === structureSig && patchLiveProcessDom(root, liveTurn, ctx)) {
    const timeline = timelineForView(liveTurn, sealed);
    const diffEntries = resolveTurnDiffEntries(liveTurn, sessionId);
    root.hidden = timeline.length === 0 && diffEntries.length === 0;
    const diffKey = String(diffEntries.length);
    if (sessionId && root.dataset.diffKey !== diffKey) {
      root.dataset.diffKey = diffKey;
      reapplySessionInlineDiffs(sessionId, liveTurn.turnId || null);
    }
    return;
  }

  const openState = collectDetailsOpenState(root);
  root.replaceChildren();
  root.dataset.processSig = structureSig;
  const timeline = timelineForView(liveTurn, sealed);
  const { notices, tools } = partitionTimeline(timeline);
  // Todo checklists are the plan, not process — they render chronologically
  // outside the collapsed tool group. Subagent children nest under their
  // parent Task card and leave the main flow.
  const childTools = buildChildToolsMap(tools);
  const childToolIds = new Set([...childTools.values()].flat().map((entry) => entry.id));
  const processTools = tools.filter(
    (entry) => !isTodoTool(entry.name) && !childToolIds.has(entry.id),
  );
  const latestTodoId = [...timeline].reverse()
    .find((entry) => entry.kind === "tool" && isTodoTool(entry.name))?.id || null;
  const entryCtx = { latestTodoId, childTools };
  const diffEntries = resolveTurnDiffEntries(liveTurn, sessionId);
  const hasContent = timeline.length > 0 || diffEntries.length > 0;
  root.hidden = !hasContent;
  if (!hasContent) return;

  const list = document.createElement("div");
  list.className = "assistant-turn-timeline";

  if (shouldCollapseProcessGroups(liveTurn, sealed)) {
    // Thinking and prose keep their chronological spots; tools and notices
    // collapse into one group anchored where the first of them happened.
    const group = document.createElement("details");
    group.className = "assistant-process-group";
    group.open = false;
    const summary = document.createElement("summary");
    summary.textContent = processGroupSummary(processTools, notices, t);
    group.appendChild(summary);
    const body = document.createElement("div");
    body.className = "assistant-process-group-body";
    renderGroupedTools(body, processTools, notices, sealed, childTools);
    group.appendChild(body);
    let groupInserted = false;
    for (const entry of timeline) {
      if (entry.kind === "tool" && childToolIds.has(entry.id)) continue;
      const inPlace = entry.kind === "thinking" || entry.kind === "text" ||
        (entry.kind === "tool" && isTodoTool(entry.name));
      if (inPlace) {
        const node = renderTimelineEntry(entry, sealed, entryCtx);
        if (node) list.appendChild(node);
      } else if (!groupInserted) {
        list.appendChild(group);
        groupInserted = true;
      }
    }
    if (!groupInserted && (processTools.length || notices.length)) list.appendChild(group);
  } else {
    for (const entry of timeline) {
      if (entry.kind === "tool" && childToolIds.has(entry.id)) continue;
      const node = renderTimelineEntry(entry, sealed, entryCtx);
      if (node) list.appendChild(node);
    }
  }

  if (diffEntries.length) {
    const changes = renderChangedFilesGroup(diffEntries, sealed, {
      sessionId,
      turnId: liveTurn.turnId || null,
    });
    if (changes) list.appendChild(changes);
  }

  root.appendChild(list);
  restoreDetailsOpenState(root, openState, { live: !sealed });
  if (sessionId) reapplySessionInlineDiffs(sessionId, liveTurn.turnId || null);
}

function renderGroupedTools(container, tools, notices, sealed, childTools) {
  const catGroups = groupToolsByCategory(tools);
  const categories = [...catGroups.entries()].filter(([, items]) => items.length);

  if (categories.length <= 1) {
    for (const entry of tools) {
      container.appendChild(renderToolWithChildren(entry, sealed, childTools));
    }
  } else {
    for (const [category, categoryTools] of categories) {
      const sub = document.createElement("details");
      sub.className = "assistant-process-subgroup";
      sub.open = false;
      const summary = document.createElement("summary");
      const [key, params] = categorySummaryKey(category, categoryTools.length);
      summary.textContent = t(key, params);
      sub.appendChild(summary);
      const body = document.createElement("div");
      body.className = "assistant-process-subgroup-body";
      for (const entry of categoryTools) {
        body.appendChild(renderToolWithChildren(entry, sealed, childTools));
      }
      sub.appendChild(body);
      container.appendChild(sub);
    }
  }

  for (const notice of notices) {
    const node = renderNoticeEntry(notice);
    if (node) container.appendChild(node);
  }
}

function renderChangedFilesGroup(entries, sealed, ctx = {}) {
  const details = document.createElement("details");
  details.className = "assistant-process-group assistant-process-group-changes";
  details.open = false;
  const summary = document.createElement("summary");
  summary.textContent = t("timeline.changedFiles", { count: entries.length });
  details.appendChild(summary);
  const list = document.createElement("div");
  list.className = "assistant-process-changes-list";
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "assistant-process-change-row";
    row.textContent = entry.fileName || entry.filePath || "";
    row.title = entry.filePath || "";
    list.appendChild(row);
  }
  details.appendChild(list);
  if (ctx.sessionId && ctx.turnId) {
    const revertBtn = document.createElement("button");
    revertBtn.className = "assistant-turn-revert-btn";
    revertBtn.textContent = t("timeline.revertTurn");
    revertBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      // Toggle: after a revert the same button undoes it (one-shot stash).
      if (revertBtn.dataset.reverted === "true") {
        const undo = await window.assistantClient.unrevertTurn(ctx.sessionId, ctx.turnId);
        if (undo?.ok) {
          revertBtn.dataset.reverted = "false";
          revertBtn.textContent = t("timeline.revertTurn");
          showToast(t("timeline.revertTurnUndone"), "success");
        } else {
          showToast(t("timeline.revertTurnUndoFailed"), "error");
        }
        return;
      }
      const confirmed = await confirmDialog({
        title: t("timeline.revertTurnConfirmTitle"),
        message: t("timeline.revertTurnConfirmMessage", { count: entries.length }),
        danger: true,
      });
      if (!confirmed) return;
      const result = await window.assistantClient.revertTurn(ctx.sessionId, ctx.turnId);
      if (result?.ok) {
        revertBtn.dataset.reverted = "true";
        revertBtn.textContent = t("timeline.revertTurnUndo");
        showToast(t("timeline.revertTurnDone"), "success");
      } else {
        const failedNames = (result?.failed || []).map((item) => item.filePath).join(", ");
        showToast(t("timeline.revertTurnFailed", { files: failedNames }), "error");
      }
    });
    details.appendChild(revertBtn);
  }
  return details;
}

function renderTimelineEntry(entry, sealed, ctx = {}) {
  if (entry.kind === "thinking") return renderThinkingEntry(entry, !sealed);
  if (entry.kind === "tool") {
    if (isTodoTool(entry.name)) {
      return renderTodoEntry(entry, entry.id === ctx.latestTodoId);
    }
    return renderToolWithChildren(entry, sealed, ctx.childTools);
  }
  if (entry.kind === "notice") return renderNoticeEntry(entry);
  if (entry.kind === "text") return renderInlineTextEntry(entry);
  return null;
}

// Subagent (Task) tool calls nest their own tool activity inside the parent
// card instead of flooding the main timeline.
function buildChildToolsMap(toolEntries = []) {
  const ids = new Set(toolEntries.map((entry) => entry.id));
  const children = new Map();
  for (const entry of toolEntries) {
    const parent = entry.parentToolUseId;
    if (!parent || !ids.has(parent) || parent === entry.id) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
  }
  return children;
}

function renderToolWithChildren(entry, sealed, childTools) {
  const row = renderToolRowFromEntry(entry, sealed);
  const children = childTools?.get(entry.id);
  if (row && children?.length) {
    const nest = document.createElement("div");
    nest.className = "assistant-subagent-tools";
    for (const child of children) {
      const childRow = renderToolWithChildren(child, sealed, childTools);
      if (childRow) nest.appendChild(childRow);
    }
    row.appendChild(nest);
  }
  return row;
}

// The model's TodoWrite plan renders as a checklist card. Only the newest
// snapshot stays expanded — earlier ones collapse to a progress line.
function renderTodoEntry(entry, isLatest = true) {
  const todos = parseTodoEntries(entry);
  if (!todos.length) return null;
  const details = document.createElement("details");
  details.className = "assistant-todo-card";
  details.dataset.toolId = entry.id || "";
  details.open = isLatest;
  const summary = document.createElement("summary");
  summary.className = "assistant-todo-summary";
  const done = todos.filter((todo) => todo.status === "completed").length;
  summary.textContent = t("todo.summary", { done, total: todos.length });
  details.appendChild(summary);
  const list = document.createElement("ul");
  list.className = "assistant-todo-items";
  renderTodoItems(list, todos);
  details.appendChild(list);
  return details;
}

function renderTodoItems(list, todos) {
  if (!list) return;
  list.replaceChildren();
  for (const todo of todos) {
    const item = document.createElement("li");
    item.className = `assistant-todo-item is-${todo.status}`;
    const icon = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▸" : "○";
    item.textContent = `${icon} ${todo.content}`;
    list.appendChild(item);
  }
}

// Prose the assistant wrote before its final answer (between tool calls).
// These blocks are sealed by the time they reach the renderable timeline,
// so their content is immutable — render once, no patching.
function renderInlineTextEntry(entry) {
  const text = String(entry.text || "").trim();
  if (!text) return null;
  const node = document.createElement("div");
  node.className = "assistant-turn-inline-text markdown-body";
  node.dataset.textId = entry.id || "";
  renderStreamingMarkdown(node, text);
  return node;
}

function renderThinkingEntry(entry, live = false) {
  if (!entry.text?.trim()) return null;
  // A sealed thinking block collapses even while the turn is still live —
  // only the block that is actively streaming stays forced open.
  const isLive = live && entry.status !== "done";
  const details = document.createElement("details");
  details.className = "assistant-process-thinking-group";
  details.dataset.thinkingId = entry.id || "";
  if (isLive) {
    details.classList.add("is-live");
    details.open = true;
  } else if (entry.collapsed !== false) {
    details.open = false;
  }
  const summary = document.createElement("summary");
  summary.className = "assistant-process-thinking-summary";
  summary.textContent = thinkingSummaryLabel(entry, isLive);
  details.appendChild(summary);
  const pre = document.createElement("pre");
  pre.className = "assistant-process-thinking";
  pre.textContent = entry.text.trim();
  details.appendChild(pre);
  return details;
}

function renderNoticeEntry(entry) {
  const detail = resolveNoticeDetail(entry);
  if (!detail) return null;
  const row = document.createElement("div");
  row.className = `assistant-process-notice is-${entry.level || "info"}`;
  row.textContent = detail;
  return row;
}

// A finished tool shows how long it ran (sub-100ms reads as instant — omit).
function toolDurationSuffix(entry) {
  if (entry.status !== "done" && entry.status !== "failed") return "";
  const start = Number(entry.startTs);
  const end = Number(entry.ts);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 100) return "";
  return ` · ${((end - start) / 1000).toFixed(1)}s`;
}

function renderToolRowFromEntry(entry, sealed = false) {
  const tool = toolEntryToRenderTool(entry);
  return renderToolRow(tool, toolRowPreview(entry), sealed, toolDurationSuffix(entry));
}

function renderToolRow(tool, previewText = "", sealed = false, statusSuffix = "") {
  const row = document.createElement("details");
  row.className = "assistant-tool-row";
  row.dataset.toolId = tool.id || "";
  const filePath = toolFilePath(tool);
  if (filePath) row.dataset.toolFilePath = filePath;
  row.dataset.status = tool.status || "";
  // Tool details stay collapsed by default — the preview line tells the story;
  // users expand on click and restoreDetailsOpenState keeps their choice.
  row.open = false;
  const summary = document.createElement("summary");
  summary.className = "assistant-tool-summary";
  const head = document.createElement("div");
  head.className = "assistant-tool-row-head";
  const cmd = document.createElement("span");
  cmd.className = "assistant-tool-command";
  cmd.textContent = previewText || toolPreview(tool);
  const status = document.createElement("span");
  status.className = "assistant-tool-status";
  status.textContent = toolStatusLabel(tool) + statusSuffix;
  head.append(cmd, status);
  summary.appendChild(head);
  row.appendChild(summary);
  appendToolResultBlock(row, tool, sealed);
  return row;
}

function toolStatusLabel(toolOrStatus) {
  const status = typeof toolOrStatus === "string"
    ? toolOrStatus
    : (toolOrStatus?.status || "done");
  const name = typeof toolOrStatus === "string"
    ? ""
    : String(toolOrStatus?.name || "").toLowerCase();
  if (status === "failed") return t("tool.status.failed");
  if (status === "running") return t("tool.status.running");
  if (name === "bash") return t("tool.status.commandDone");
  return t("tool.status.done");
}

function appendToolResultBlock(row, tool, sealed = false) {
  const compactFileContent = sealed && classifyToolCategory(tool.name) === "write";
  if (toolInputHasRenderableDetail(tool)) {
    appendToolPayloadDetail(row, tool, { role: "input", compactFileContent });
  }
  if (!tool.result) return;

  const parsed = parseToolResult(tool.result);
  const generatedMediaText = typeof parsed?.content === "string" ? parsed.content : "";
  if (generatedMediaText && parseGeneratedMedia(generatedMediaText).length) {
    appendToolPayloadDetail(row, tool, { role: "result" });
    return;
  }
  const resultKeys = parsed && typeof parsed === "object"
    ? Object.keys(parsed).filter((k) => k !== "truncated" && k !== "fullText")
    : [];
  const hasStructuredResult = resultKeys.length > 1 ||
    (resultKeys.length === 1 && resultKeys[0] !== "content");
  if (hasStructuredResult && parsed) {
    appendToolPayloadDetail(row, tool, { role: "result" });
    return;
  }

  const result = normalizeToolResult(tool.result);
  if (!result?.content) return;

  const pre = document.createElement("pre");
  pre.className = "assistant-tool-detail assistant-tool-result";
  pre.textContent = result.content;
  row.appendChild(pre);

  if (!result.truncated || !result.fullText) return;
  const actions = document.createElement("div");
  actions.className = "assistant-tool-detail-actions";

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "assistant-action-btn";
  expandBtn.textContent = t("tool.expand");
  expandBtn.addEventListener("click", () => {
    const expanded = pre.dataset.expanded === "true";
    pre.textContent = expanded ? result.content : result.fullText;
    pre.dataset.expanded = expanded ? "false" : "true";
    expandBtn.textContent = expanded ? t("tool.expand") : t("tool.collapse");
  });

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "assistant-action-btn";
  copyBtn.textContent = t("common.copy");
  copyBtn.addEventListener("click", async () => {
    const text = pre.dataset.expanded === "true" ? result.fullText : result.content;
    try {
      await navigator.clipboard.writeText(text);
      showToast(t("common.copied"), "success");
    } catch {
      showToast(t("common.copyFailed"), "warning");
    }
  });

  actions.append(expandBtn, copyBtn);
  row.appendChild(actions);
}

function normalizeToolResult(result) {
  if (!result) return null;
  const parsed = parseToolResult(result);
  if (parsed && typeof parsed.content === "string") {
    return {
      content: parsed.content,
      truncated: Boolean(parsed.truncated ?? result.truncated),
      fullText: typeof parsed.fullText === "string" ? parsed.fullText : (result.fullText || ""),
    };
  }
  if (typeof result === "string") return { content: result, truncated: false, fullText: "" };
  const content = typeof result.content === "string" ? result.content : JSON.stringify(result, null, 2);
  return {
    content,
    truncated: Boolean(result.truncated),
    fullText: typeof result.fullText === "string" ? result.fullText : "",
  };
}

function toolFilePath(tool) {
  const input = tool.input || {};
  const name = String(tool.name || "").toLowerCase();
  if (!["write", "edit", "multiedit"].includes(name)) return "";
  return input.file_path || input.path || input.target_file || "";
}

function renderPrompts(root, sessionId, liveTurn) {
  if (!root) return;
  root.replaceChildren();
  const entries = [
    ...liveTurn.permissions.values(),
    ...liveTurn.questions.values(),
    ...liveTurn.hooks.values(),
  ];
  pruneQuestionDrafts(
    sessionId,
    new Set(entries.filter((item) => item.questions).map((item) => String(item.requestId || ""))),
  );
  root.hidden = entries.length === 0;
  for (const item of entries) {
    if (item.questions) root.appendChild(questionCard(sessionId, item));
    else if (item.hookName) root.appendChild(hookCard(sessionId, item));
    else root.appendChild(permissionCard(sessionId, item));
  }
}

function permissionCard(sessionId, item) {
  if (String(item.toolName || "") === "ExitPlanMode") {
    return planApprovalCard(sessionId, item);
  }
  const card = promptCard(
    t("permission.approveActionTitle"),
    item.toolName || item.title || t("turn.permission.toolFallback"),
  );
  const actions = actionRow();
  actions.append(
    button(t("permission.approve"), async () => window.assistantClient.respondPermission(sessionId, item.requestId, true)),
    button(t("permission.deny"), async () => window.assistantClient.respondPermission(sessionId, item.requestId, false)),
    button(t("permission.approveRememberShort"), async () => window.assistantClient.respondPermission(sessionId, item.requestId, true, { remember: true })),
  );
  card.appendChild(actions);
  return card;
}

// Plan-mode review: the model finished planning and asks to start executing.
// Show the plan itself, not a generic tool-permission prompt.
function planApprovalCard(sessionId, item) {
  const card = promptCard(t("plan.readyTitle"), "");
  const planText = String(item.planPreview || item.input?.plan || "").trim();
  if (planText) {
    const body = document.createElement("div");
    body.className = "assistant-plan-body markdown-body";
    renderStreamingMarkdown(body, planText);
    if (item.planPreviewTruncated) {
      const more = document.createElement("p");
      more.className = "assistant-plan-truncated";
      more.textContent = t("plan.truncated");
      body.appendChild(more);
    }
    card.appendChild(body);
  }
  const actions = actionRow();
  actions.append(
    button(t("plan.approve"), async () => window.assistantClient.respondPermission(sessionId, item.requestId, true)),
    button(t("plan.keepPlanning"), async () =>
      window.assistantClient.respondPermission(sessionId, item.requestId, false, {
        message: t("plan.keepPlanningMessage"),
      })),
  );
  card.appendChild(actions);
  return card;
}

function hookCard(sessionId, item) {
  const card = promptCard(
    t("turn.hook.confirmTitle"),
    item.hookName || t("hook.title"),
  );
  const actions = actionRow();
  actions.append(
    button(t("hook.allowTool"), async () => window.assistantClient.respondHook(sessionId, item.requestId, true)),
    button(t("hook.denyTool"), async () => window.assistantClient.respondHook(sessionId, item.requestId, false)),
  );
  card.appendChild(actions);
  return card;
}

function questionCard(sessionId, item) {
  const card = promptCard(t("turn.question.cardTitle"), "");
  const draft = getQuestionDraft(sessionId, item.requestId);
  const questions = item.questions || [];
  const requiresExplicitSubmit =
    questions.length > 1 || questions.some((question) => Boolean(question.multiSelect));
  let needsSubmit = false;
  for (const question of questions) {
    const block = document.createElement("div");
    block.className = "assistant-question-block";
    const label = document.createElement("label");
    label.className = "assistant-question-label";
    label.textContent = question.question || t("question.freeAnswerPrompt");
    block.appendChild(label);

    const options = Array.isArray(question.options) ? question.options.filter((o) => o?.label) : [];
    if (options.length) {
      if (requiresExplicitSubmit) needsSubmit = true;
      const optionsEl = document.createElement("div");
      optionsEl.className = "assistant-question-options";
      for (const option of options) {
        const questionId = question.id || question.question || "answer";
        const selectedValues = draft.selections.get(questionId) || new Set();
        const selected = selectedValues.has(option.label);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `assistant-question-option${selected ? " is-selected" : ""}`;
        btn.textContent = option.label;
        btn.dataset.questionId = questionId;
        btn.dataset.value = option.label;
        btn.setAttribute("aria-pressed", selected ? "true" : "false");
        if (option.description) btn.title = option.description;
        if (requiresExplicitSubmit) {
          btn.addEventListener("click", () => {
            const nextSelected = setQuestionSelection(draft, questionId, option.label, {
              multiSelect: Boolean(question.multiSelect),
            });
            if (question.multiSelect) {
              const isSelected = nextSelected.has(option.label);
              btn.classList.toggle("is-selected", isSelected);
              btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
            } else {
              for (const sibling of optionsEl.querySelectorAll(".assistant-question-option")) {
                const isSelected = sibling.dataset.value === option.label;
                sibling.classList.toggle("is-selected", isSelected);
                sibling.setAttribute("aria-pressed", isSelected ? "true" : "false");
              }
            }
          });
        } else {
          btn.addEventListener("click", async () => {
            try {
              const result = await window.assistantClient.respondUserQuestion(
                sessionId,
                item.requestId,
                { [question.id || question.question || "answer"]: option.label },
                option.label,
              );
              if (!result?.ok) showToast(result?.detail || result?.error || t("common.actionFailed"), "warning");
            } catch (err) {
              showToast(err?.message || t("common.actionFailed"), "error");
            }
          });
        }
        optionsEl.appendChild(btn);
      }
      block.appendChild(optionsEl);
    } else {
      needsSubmit = true;
      const input = document.createElement("textarea");
      input.className = "assistant-question-input";
      input.rows = 2;
      input.placeholder = t("question.otherPlaceholder");
      input.dataset.questionId = question.id || question.question || "answer";
      input.value = draft.text.get(input.dataset.questionId) || "";
      input.addEventListener("input", () => {
        draft.text.set(input.dataset.questionId, input.value);
      });
      block.appendChild(input);
    }
    card.appendChild(block);
  }
  if (needsSubmit) {
    const actions = actionRow();
    actions.appendChild(button(t("question.submit"), async () => {
      const answers = {};
      for (const question of questions) {
        const questionId = question.id || question.question || "answer";
        const selected = Array.from(draft.selections.get(questionId) || []);
        if (selected.length) {
          answers[questionId] = question.multiSelect ? selected : selected[0];
        }
      }
      for (const input of card.querySelectorAll(".assistant-question-input")) {
        const value = input.value;
        draft.text.set(input.dataset.questionId, value);
        answers[input.dataset.questionId] = value;
      }
      const result = await window.assistantClient.respondUserQuestion(
        sessionId,
        item.requestId,
        answers,
        Object.values(answers).flat().filter(Boolean).join("\n"),
      );
      if (!result?.ok) showToast(result?.detail || result?.error || t("common.actionFailed"), "warning");
      return result;
    }));
    card.appendChild(actions);
  }
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
    if (btn.disabled) return;
    // A double-click must not answer the same request twice — lock the whole
    // action row while the response is in flight; unlock only on failure
    // (success re-renders the card away).
    const row = btn.closest(".assistant-prompt-actions");
    const group = row ? [...row.querySelectorAll("button")] : [btn];
    for (const item of group) item.disabled = true;
    const unlock = () => {
      for (const item of group) item.disabled = false;
    };
    try {
      const result = await action();
      if (!result?.ok) {
        unlock();
        showToast(result?.detail || result?.error || t("common.actionFailed"), "warning");
      }
    } catch (err) {
      unlock();
      showToast(err?.message || t("common.actionFailed"), "error");
    }
  });
  return btn;
}

function renderFinal(article, liveTurn) {
  if (article.querySelector(".assistant-turn-report")) return;
  if (!shouldShowFinal(liveTurn)) return;
  if (liveTurn.turnId) narrativeRenderState.delete(liveTurn.turnId);
  const report = document.createElement("section");
  report.className = "assistant-turn-report";

  const label = document.createElement("p");
  label.className = "assistant-turn-report-label";
  label.textContent = t("message.resultLabel");

  const final = document.createElement("div");
  final.className = "assistant-turn-final markdown-body assistant-turn-report-body";
  const text = resolveAssistantStreamText(liveTurn);
  const sealed = article.classList.contains("is-sealed");
  if (sealed) {
    renderStreamingMarkdown(final, text);
    const upgrade = () => { void renderMarkdown(final, text); };
    if (typeof requestIdleCallback === "function") requestIdleCallback(upgrade);
    else setTimeout(upgrade, 200);
  } else {
    void renderMarkdown(final, text);
  }

  report.append(label, final);
  article.appendChild(report);
}
