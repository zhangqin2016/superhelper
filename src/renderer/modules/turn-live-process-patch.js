import { t } from "../i18n/index.js";
import {
  partitionTimeline,
  timelineForProcessView,
} from "./turn-process-timeline-model.js";
import { processGroupSummary } from "./turn-process-summary-model.js";
import { isSubagentEntry } from "./turn-process-view-model.js";
import {
  isTodoTool,
  toolEntryToRenderTool,
  toolRowPreview,
} from "./turn-tool-model.js";
import {
  buildThinkingSummaryLabel,
  buildToolDurationSuffix,
  buildToolStatusLabel,
} from "./turn-view-status.js";

export function patchLiveProcessDom(root, liveTurn, ctx, {
  translate = t,
  timelineForProcess = timelineForProcessView,
  partition = partitionTimeline,
  processSummary = (tools, notices) => processGroupSummary(tools, notices, translate),
  isTodo = isTodoTool,
  isSubagent = isSubagentEntry,
  rowPreview = toolRowPreview,
  toRenderTool = toolEntryToRenderTool,
  toolStatus = (tool) => buildToolStatusLabel(tool, translate),
  toolDuration = (entry) => buildToolDurationSuffix(entry, Date.now(), translate),
  thinkingSummary = (entry, live) => buildThinkingSummaryLabel(entry, live, translate),
} = {}) {
  const { sealed = Boolean(liveTurn.final) } = ctx;
  const timeline = timelineForProcess(liveTurn, sealed);
  const { notices, tools } = partition(timeline);
  const summary = root.querySelector(".assistant-process-group summary");
  if (summary) {
    const next = processSummary(tools.filter((entry) => !isTodo(entry.name) && !isSubagent(entry)), notices);
    if (summary.textContent !== next) summary.textContent = next;
  }
  for (const entry of timeline) {
    if (entry.kind === "tool" && isTodo(entry.name)) {
      continue;
    } else if (entry.kind === "tool" && isSubagent(entry)) {
      continue;
    } else if (entry.kind === "toolGroup") {
      return false;
    } else if (entry.kind === "tool") {
      const row = root.querySelector(`.assistant-tool-row[data-tool-id="${CSS.escape(entry.id)}"]`);
      if (!row) return false;
      const preview = rowPreview(entry);
      const cmd = row.querySelector(".assistant-tool-command");
      const statusEl = row.querySelector(".assistant-tool-status");
      const tool = toRenderTool(entry);
      const statusLabel = toolStatus(tool) + toolDuration(entry);
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
      const summaryEl = group.querySelector(".assistant-process-thinking-summary");
      const nextSummary = thinkingSummary(entry, isLive);
      if (summaryEl && summaryEl.textContent !== nextSummary) {
        summaryEl.textContent = nextSummary;
      }
      if (pre.textContent !== text) {
        pre.textContent = text;
        pre.scrollTop = pre.scrollHeight;
      }
    } else if (entry.kind === "text") {
      const node = root.querySelector(`.assistant-turn-inline-text[data-text-id="${CSS.escape(entry.id || "")}"]`);
      if (!node) return false;
    }
  }
  return true;
}
