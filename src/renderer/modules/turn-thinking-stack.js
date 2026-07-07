import { t } from "../i18n/index.js";
import { renderableThinkingEntries, buildThinkingGroupSummary } from "./turn-view-status.js";
import { renderThinkingEntry } from "./turn-thinking-entry.js";

export function renderThinkingStack(thinkingEntries = [], {
  groupSummary = (entries) => buildThinkingGroupSummary(entries, t),
  renderEntry = renderThinkingEntry,
} = {}) {
  const entries = renderableThinkingEntries(thinkingEntries);
  if (!entries.length) return null;
  const details = document.createElement("details");
  details.className = "assistant-process-thinking-group assistant-process-thinking-stack";
  details.dataset.thinkingGroup = "true";
  details.open = false;
  const summary = document.createElement("summary");
  summary.className = "assistant-process-thinking-summary";
  summary.textContent = groupSummary(entries);
  details.appendChild(summary);
  const body = document.createElement("div");
  body.className = "assistant-process-thinking-stack-body";
  for (const entry of entries) {
    const node = renderEntry(entry, false);
    if (node) body.appendChild(node);
  }
  details.appendChild(body);
  return details;
}
