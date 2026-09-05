import {
  partitionTimeline,
  shouldCollapseProcessGroups,
  timelineForProcessView,
} from "./turn-process-timeline-model.js";
import {
  buildChildToolsMap,
  collectSubagentEntries,
  isSubagentEntry,
} from "./turn-process-view-model.js";
import { isTodoTool } from "./turn-tool-model.js";
import { shouldGroupFinishedThinking } from "./turn-view-status.js";

export function prepareProcessRenderView(liveTurn = {}, sealed = false, {
  diffEntries = [],
  sessionId = "",
} = {}) {
  const timeline = timelineForProcessView(liveTurn, sealed);
  const { thinking, notices, tools } = partitionTimeline(timeline);
  const collapsed = shouldCollapseProcessGroups(liveTurn, sealed);
  const groupThinking = shouldGroupFinishedThinking(thinking, sealed);
  const childTools = buildChildToolsMap(tools);
  const childToolIds = new Set([...childTools.values()].flat().map((entry) => entry.id));
  const processTools = tools.filter(
    (entry) => !isTodoTool(entry.name) && !childToolIds.has(entry.id) && !isSubagentEntry(entry),
  );
  const latestTodoId = [...timeline].reverse()
    .find((entry) => entry.kind === "tool" && isTodoTool(entry.name))?.id || null;
  return {
    timeline,
    thinking,
    notices,
    tools,
    collapsed,
    groupThinking,
    childTools,
    childToolIds,
    processTools,
    latestTodoId,
    entryCtx: {
      latestTodoId,
      childTools,
      sessionId,
      // Plan-progress overlay for the todo card (live: runtime taskRun; sealed:
      // the reconciled taskRun stored in record.meta by the finalizer).
      taskRun: liveTurn?.taskRun || liveTurn?.final?.payload?.record?.meta?.taskRun || null,
    },
    diffEntries,
    diffKey: String(diffEntries.length),
    hasDiffs: diffEntries.length > 0,
    hasContent: timeline.length > 0 || diffEntries.length > 0,
    subagents: collectSubagentEntries(timeline, liveTurn),
  };
}

export function processStructureSignature(liveTurn = {}, sealed = false, { diffCount = 0 } = {}) {
  const timeline = timelineForProcessView(liveTurn, sealed);
  const subagentSig = collectSubagentEntries(timeline, liveTurn)
    .map((entry) => {
      const meta = entry.metadata || {};
      return [
        entry.id,
        entry.status || "",
        meta.sessionId || meta.sessionID || "",
        meta.toolcalls || meta.toolCalls || meta.calls || "",
        entry.subagent?.textFull?.length || 0,
        entry.subagent?.pendingPermissions?.length || 0,
        entry.subagent?.pendingQuestions?.length || 0,
        entry.subagent?.phase || "",
        entry.subagent?.phaseDetail || "",
        entry.subagent?.stats?.totalTools || 0,
        entry.subagent?.stats?.runningTools || 0,
        entry.title || "",
      ].join(".");
    })
    .join(",");
  const collapsed = shouldCollapseProcessGroups(liveTurn, sealed);
  const { thinking } = partitionTimeline(timeline);
  const groupedThinking = shouldGroupFinishedThinking(thinking, sealed);
  const parts = [
    collapsed ? "collapsed" : "flat",
    groupedThinking ? "thinking-grouped" : "thinking-flat",
    String(diffCount),
    `subagents:${subagentSig}`,
  ];
  if (collapsed) {
    const { notices, tools, texts } = partitionTimeline(timeline);
    parts.push(`thinking:${thinking.map((entry) => `${entry.id || ""}.${entry.status || ""}`).join(",")}`);
    parts.push(`texts:${texts.map((entry) => entry.id || "").join(",")}`);
    parts.push(`notices:${notices.length}`);
    for (const entry of tools) {
      parts.push(`tool:${entry.id}:${entry.status || ""}`);
    }
  } else {
    for (const entry of timeline) {
      parts.push(`${entry.kind}:${entry.id || entry.code || ""}:${entry.status || ""}`);
    }
  }
  return parts.join("|");
}
