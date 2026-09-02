import { t } from "../i18n/index.js";
import {
  buildToolDurationSuffix,
  buildToolStatusLabel,
} from "./turn-view-status.js";

export function renderToolGroup(entry, sealed, ctx = {}, {
  translate = t,
  statusLabel = (toolOrStatus) => buildToolStatusLabel(toolOrStatus, t),
  durationSuffix = buildToolDurationSuffix,
  renderTool,
} = {}) {
  const tools = Array.isArray(entry.tools) ? entry.tools : [];
  if (!tools.length) return null;
  const row = document.createElement("details");
  row.className = "assistant-tool-row assistant-tool-group-row";
  row.dataset.toolId = entry.id || "";
  row.dataset.status = entry.status || "";
  row.open = false;

  const summary = document.createElement("summary");
  summary.className = "assistant-tool-summary";
  const head = document.createElement("div");
  head.className = "assistant-tool-row-head";
  const cmd = document.createElement("span");
  cmd.className = "assistant-tool-command";
  cmd.textContent = translate("timeline.readGroup", { count: tools.length });
  const status = document.createElement("span");
  status.className = "assistant-tool-status";
  status.textContent = statusLabel(entry.status || "done") + durationSuffix(entry, Date.now(), translate);
  head.append(cmd, status);
  summary.appendChild(head);
  row.appendChild(summary);

  const body = document.createElement("div");
  body.className = "assistant-tool-group-body";
  for (const tool of tools) {
    const child = renderTool?.(tool, sealed, ctx);
    if (child) body.appendChild(child);
  }
  row.appendChild(body);
  return row;
}
