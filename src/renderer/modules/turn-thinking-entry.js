import { t } from "../i18n/index.js";
import { buildThinkingSummaryLabel } from "./turn-view-status.js";

export function renderThinkingEntry(entry, live = false, {
  summaryLabel = (thinking, isLive) => buildThinkingSummaryLabel(thinking, isLive, t),
} = {}) {
  if (!entry.text?.trim()) return null;
  // Only the actively streaming block gets the live marker; all thinking stays collapsed.
  const isLive = live && entry.status !== "done";
  const details = document.createElement("details");
  details.className = "assistant-process-thinking-group";
  details.dataset.thinkingId = entry.id || "";
  if (isLive) details.classList.add("is-live");
  details.open = false;
  const summary = document.createElement("summary");
  summary.className = "assistant-process-thinking-summary";
  summary.textContent = summaryLabel(entry, isLive);
  details.appendChild(summary);
  const pre = document.createElement("pre");
  pre.className = "assistant-process-thinking";
  pre.textContent = entry.text.trim();
  details.appendChild(pre);
  return details;
}
