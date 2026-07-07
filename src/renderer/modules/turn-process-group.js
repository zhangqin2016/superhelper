import { t } from "../i18n/index.js";
import { processGroupSummary } from "./turn-process-summary-model.js";
import { renderGroupedTools } from "./turn-grouped-tools.js";
import { renderToolWithChildren } from "./turn-timeline-entry.js";

export function renderProcessGroup({
  processTools = [],
  notices = [],
  sealed = false,
  childTools = new Map(),
  entryCtx = {},
} = {}, {
  processSummary = (tools, processNotices) => processGroupSummary(tools, processNotices, t),
  renderGrouped = renderGroupedTools,
  renderTool = renderToolWithChildren,
} = {}) {
  const group = document.createElement("details");
  group.className = "assistant-process-group";
  group.open = false;
  const summary = document.createElement("summary");
  summary.textContent = processSummary(processTools, notices);
  group.appendChild(summary);
  const body = document.createElement("div");
  body.className = "assistant-process-group-body";
  renderGrouped(body, processTools, notices, sealed, childTools, entryCtx, { renderTool });
  group.appendChild(body);
  return group;
}
