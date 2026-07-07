/**
 * Compatibility barrel for process layout helpers.
 *
 * New renderer code should import the narrower modules directly.
 */

export {
  collectFileToolBodies,
  hasCliResult,
  lastTimelineText,
  normalizeForDedup,
  resolveAssistantStreamText,
  resolveFinalText,
  shouldShowFinal,
  shouldShowNarrative,
  textMatchesFileToolBody,
} from "./turn-narrative-policy.js";

export {
  collapseRepeatedReadTools,
  partitionTimeline,
  shouldCollapseProcessGroups,
  timelineForProcessView,
} from "./turn-process-timeline-model.js";

export {
  categorySummaryKey,
  groupToolsByCategory,
  processGroupSummary,
} from "./turn-process-summary-model.js";

export {
  buildChildToolsMap,
  collectSubagentEntries,
  isSubagentEntry,
  shouldAppendCollapsedProcessGroupFallback,
  shouldRenderEntryInCollapsedProcess,
  shouldRenderThinkingStackForEntry,
  shouldSkipProcessTimelineEntry,
} from "./turn-process-view-model.js";

export {
  classifyToolCategory,
  isFileWriteCategory,
  isTodoTool,
  parseTodoEntries,
  toolEntryToRenderTool,
  toolRowPreview,
} from "./turn-tool-model.js";

export {
  prepareProcessRenderView,
  processStructureSignature,
} from "./turn-process-render-view.js";
