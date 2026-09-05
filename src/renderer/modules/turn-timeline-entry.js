import { t } from "../i18n/index.js";
import {
  isTodoTool,
  toolEntryToRenderTool,
  toolRowPreview,
} from "./turn-tool-model.js";
import {
  buildToolDurationSuffix,
  buildToolStatusLabel,
} from "./turn-view-status.js";
import { renderThinkingEntry } from "./turn-thinking-entry.js";
import { renderToolGroup as renderToolGroupNode } from "./turn-tool-group.js";
import { renderToolRow } from "./turn-tool-row.js";
import { renderTodoEntry } from "./turn-todo-entry.js";
import { renderNoticeEntry } from "./turn-notice-entry.js";
import { renderInlineTextEntry } from "./turn-inline-text.js";

function renderToolRowFromEntry(entry, sealed = false, ctx = {}, deps = {}) {
  const {
    toRenderTool = toolEntryToRenderTool,
    rowPreview = toolRowPreview,
    durationSuffix = buildToolDurationSuffix,
    renderRow = renderToolRow,
  } = deps;
  const tool = toRenderTool(entry);
  return renderRow(tool, rowPreview(entry), sealed, durationSuffix(entry, Date.now(), t), ctx);
}

export function renderToolWithChildren(entry, sealed, childTools, ctx = {}, deps = {}) {
  const {
    renderToolGroup = renderToolGroupNode,
    statusLabel = (toolOrStatus) => buildToolStatusLabel(toolOrStatus, t),
    durationSuffix = buildToolDurationSuffix,
  } = deps;
  if (entry.kind === "toolGroup") return renderToolGroup(entry, sealed, ctx, {
    statusLabel,
    durationSuffix,
    renderTool: (toolEntry, isSealed, renderCtx) => renderToolRowFromEntry(toolEntry, isSealed, renderCtx, deps),
  });
  const row = deps.renderToolRow
    ? deps.renderToolRow(entry, sealed, ctx)
    : renderToolRowFromEntry(entry, sealed, ctx, deps);
  const children = childTools?.get(entry.id);
  if (row && children?.length) {
    const nest = document.createElement("div");
    nest.className = "assistant-subagent-tools";
    for (const child of children) {
      const childRow = renderToolWithChildren(child, sealed, childTools, ctx, deps);
      if (childRow) nest.appendChild(childRow);
    }
    row.appendChild(nest);
  }
  return row;
}

export function renderTimelineEntry(entry, sealed, ctx = {}, deps = {}) {
  const {
    isTodo = isTodoTool,
    renderThinking = renderThinkingEntry,
    renderToolGroup = renderToolGroupNode,
    renderTodo = renderTodoEntry,
    renderNotice = renderNoticeEntry,
    renderText = renderInlineTextEntry,
    statusLabel = (toolOrStatus) => buildToolStatusLabel(toolOrStatus, t),
    durationSuffix = buildToolDurationSuffix,
  } = deps;
  if (entry.kind === "thinking") return renderThinking(entry, !sealed);
  if (entry.kind === "toolGroup") return renderToolGroup(entry, sealed, ctx, {
    statusLabel,
    durationSuffix,
    renderTool: (toolEntry, isSealed, renderCtx) => renderToolRowFromEntry(toolEntry, isSealed, renderCtx, deps),
  });
  if (entry.kind === "tool") {
    if (isTodo(entry.name)) {
      if (!sealed) return null;
      return renderTodo(entry, { isLatest: entry.id === ctx.latestTodoId, taskRun: ctx.taskRun || null });
    }
    return renderToolWithChildren(entry, sealed, ctx.childTools, ctx, deps);
  }
  if (entry.kind === "notice") return renderNotice(entry);
  if (entry.kind === "text") return renderText(entry, !sealed);
  return null;
}
