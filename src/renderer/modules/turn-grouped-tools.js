import { t } from "../i18n/index.js";
import {
  categorySummaryKey,
  groupToolsByCategory,
} from "./turn-process-summary-model.js";
import { renderNoticeEntry } from "./turn-notice-entry.js";

export function renderGroupedTools(
  container,
  tools,
  notices,
  sealed,
  childTools,
  ctx = {},
  {
    groupTools = groupToolsByCategory,
    categorySummary = categorySummaryKey,
    translate = t,
    renderTool,
    renderNotice = renderNoticeEntry,
  } = {},
) {
  const catGroups = groupTools(tools);
  const categories = [...catGroups.entries()].filter(([, items]) => items.length);

  if (categories.length <= 1) {
    for (const entry of tools) {
      const node = renderTool?.(entry, sealed, childTools, ctx);
      if (node) container.appendChild(node);
    }
  } else {
    for (const [category, categoryTools] of categories) {
      const sub = document.createElement("details");
      sub.className = "assistant-process-subgroup";
      sub.open = false;
      const summary = document.createElement("summary");
      const [key, params] = categorySummary(category, categoryTools.length);
      summary.textContent = translate(key, params);
      sub.appendChild(summary);
      const body = document.createElement("div");
      body.className = "assistant-process-subgroup-body";
      for (const entry of categoryTools) {
        const node = renderTool?.(entry, sealed, childTools, ctx);
        if (node) body.appendChild(node);
      }
      sub.appendChild(body);
      container.appendChild(sub);
    }
  }

  for (const notice of notices) {
    const node = renderNotice(notice);
    if (node) container.appendChild(node);
  }
}
