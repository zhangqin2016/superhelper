import { t } from "../i18n/index.js";
import { processGroupSummary } from "./turn-process-summary-model.js";
import { renderGroupedTools } from "./turn-grouped-tools.js";
import { renderTimelineEntry, renderToolWithChildren } from "./turn-timeline-entry.js";
import { lazyDetails } from "./lazy-details.js";

export function renderProcessGroup({
  processTools = [],
  notices = [],
  narration = [],
  sealed = false,
  childTools = new Map(),
  entryCtx = {},
} = {}, {
  processSummary = (tools, processNotices) => processGroupSummary(tools, processNotices, t),
  renderGrouped = renderGroupedTools,
  renderTool = renderToolWithChildren,
  renderNarration = renderTimelineEntry,
} = {}) {
  const group = document.createElement("details");
  group.className = "assistant-process-group";
  group.open = false;
  const summary = document.createElement("summary");
  summary.textContent = processSummary(processTools, notices);
  group.appendChild(summary);
  const body = document.createElement("div");
  body.className = "assistant-process-group-body";
  group.appendChild(body);
  // Built when first opened: the summary says how many steps there were, and
  // the rows themselves are only worth building once someone looks.
  return lazyDetails(group, () => {
    // Folded narration leads the body in the order it was written: it is the
    // outline of the work, and the grouped steps below are its detail.
    for (const entry of narration) {
      const node = renderNarration(entry, sealed, entryCtx);
      if (node) body.appendChild(node);
    }
    renderGrouped(body, processTools, notices, sealed, childTools, entryCtx, { renderTool });
  });
}
