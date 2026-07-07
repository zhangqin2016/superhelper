import {
  shouldAppendCollapsedProcessGroupFallback,
  shouldRenderEntryInCollapsedProcess,
  shouldRenderThinkingStackForEntry,
  shouldSkipProcessTimelineEntry,
} from "./turn-process-view-model.js";
import { renderChangedFilesGroup } from "./turn-changed-files-group.js";
import { renderProcessGroup } from "./turn-process-group.js";
import { renderSubagentStatusPanel } from "./turn-subagent-panel.js";
import { renderThinkingStack } from "./turn-thinking-stack.js";
import { renderTimelineEntry } from "./turn-timeline-entry.js";

export function renderProcessTimeline(processView = {}, {
  sealed = false,
  sessionId = "",
  turnId = null,
  renderSubagents = renderSubagentStatusPanel,
  renderGroup = renderProcessGroup,
  renderThinking = renderThinkingStack,
  renderEntry = renderTimelineEntry,
  renderChanges = renderChangedFilesGroup,
} = {}) {
  const {
    timeline = [],
    thinking = [],
    notices = [],
    collapsed = false,
    groupThinking = false,
    childTools = new Map(),
    childToolIds = new Set(),
    processTools = [],
    entryCtx = {},
    hasDiffs = false,
    diffEntries = [],
    subagents = [],
  } = processView;
  const list = document.createElement("div");
  list.className = "assistant-turn-timeline";
  if (subagents.length) {
    const panel = renderSubagents(subagents, sealed);
    if (panel) list.appendChild(panel);
  }

  if (collapsed) {
    const group = renderGroup({ processTools, notices, sealed, childTools, entryCtx });
    let groupInserted = false;
    let thinkingInserted = false;
    for (const entry of timeline) {
      if (shouldSkipProcessTimelineEntry(entry, { childToolIds })) continue;
      if (shouldRenderThinkingStackForEntry(entry, { groupThinking })) {
        if (!thinkingInserted) {
          list.appendChild(renderThinking(thinking));
          thinkingInserted = true;
        }
        continue;
      }
      if (shouldRenderEntryInCollapsedProcess(entry)) {
        const node = renderEntry(entry, sealed, entryCtx);
        if (node) list.appendChild(node);
      } else if (!groupInserted) {
        list.appendChild(group);
        groupInserted = true;
      }
    }
    if (shouldAppendCollapsedProcessGroupFallback({ groupInserted, processTools, notices })) {
      list.appendChild(group);
    }
  } else {
    let thinkingInserted = false;
    for (const entry of timeline) {
      if (shouldSkipProcessTimelineEntry(entry, { childToolIds })) continue;
      if (shouldRenderThinkingStackForEntry(entry, { groupThinking })) {
        if (!thinkingInserted) {
          list.appendChild(renderThinking(thinking));
          thinkingInserted = true;
        }
        continue;
      }
      const node = renderEntry(entry, sealed, entryCtx);
      if (node) list.appendChild(node);
    }
  }

  if (hasDiffs) {
    const changes = renderChanges(diffEntries, sealed, { sessionId, turnId });
    if (changes) list.appendChild(changes);
  }
  return list;
}
