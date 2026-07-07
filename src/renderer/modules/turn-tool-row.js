import { t } from "../i18n/index.js";
import { toolPreview } from "./turn-tool-preview.js";
import { buildToolStatusLabel } from "./turn-view-status.js";
import { toolFilePath } from "./tool-payload-renderer.js";
import { appendToolResultBlock } from "./turn-tool-result-block.js";

export function renderToolRow(tool, previewText = "", sealed = false, statusSuffix = "", ctx = {}, {
  filePath = toolFilePath,
  preview = toolPreview,
  statusLabel = (toolOrStatus) => buildToolStatusLabel(toolOrStatus, t),
  appendResult = appendToolResultBlock,
} = {}) {
  const row = document.createElement("details");
  row.className = "assistant-tool-row";
  row.dataset.toolId = tool.id || "";
  const path = filePath(tool);
  if (path) row.dataset.toolFilePath = path;
  row.dataset.status = tool.status || "";
  // Tool details stay collapsed by default; restoreDetailsOpenState preserves user choice.
  row.open = false;
  const summary = document.createElement("summary");
  summary.className = "assistant-tool-summary";
  const head = document.createElement("div");
  head.className = "assistant-tool-row-head";
  const cmd = document.createElement("span");
  cmd.className = "assistant-tool-command";
  cmd.textContent = previewText || preview(tool);
  const status = document.createElement("span");
  status.className = "assistant-tool-status";
  status.textContent = statusLabel(tool) + statusSuffix;
  head.append(cmd, status);
  summary.appendChild(head);
  row.appendChild(summary);
  appendResult(row, tool, sealed, ctx);
  return row;
}
