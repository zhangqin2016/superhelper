"use strict";

const SLOW_SUBAGENT_MS = 45_000;
const VERY_SLOW_SUBAGENT_MS = 90_000;

function isSubagentTool(tool = {}) {
  return String(tool.name || tool.tool || "").toLowerCase() === "task";
}

function compactText(value = "", limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function subagentTitle(tool = {}) {
  const input = tool.input || {};
  return compactText(input.description || input.prompt || tool.name || "Subtask", 120);
}

function buildSubagentTelemetry(record = {}) {
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const subagents = tools.filter(isSubagentTool).map((tool) => {
    const childTools = tools.filter((child) => child.parentToolUseId && child.parentToolUseId === tool.id);
    // Depth-1 cap audit: a subagent (Task) must never have a Task among its own
    // children — the engine injects task:deny into every spawned child. If one
    // shows up, the cap leaked (cf. upstream disallowedTools-override bugs) and we
    // surface it loudly rather than trusting the deny silently held.
    const nestedTasks = childTools.filter(isSubagentTool);
    const durationMs = Number(tool.durationMs || 0);
    return {
      id: tool.id || "",
      title: subagentTitle(tool),
      status: tool.status || "",
      durationMs,
      slow: durationMs >= SLOW_SUBAGENT_MS,
      verySlow: durationMs >= VERY_SLOW_SUBAGENT_MS,
      nestedTaskCount: nestedTasks.length,
      nestedTaskBreach: nestedTasks.length > 0,
      childToolCount: childTools.length,
      childTools: childTools.slice(0, 20).map((child) => ({
        id: child.id || "",
        name: child.name || "",
        status: child.status || "",
        durationMs: Number(child.durationMs || 0),
      })),
      inputPreview: compactText(tool.input?.prompt || tool.input?.description || "", 500),
      resultPreview: compactText(
        typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result || ""),
        700,
      ),
    };
  });
  const totalDurationMs = subagents.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
  return {
    schemaVersion: 1,
    count: subagents.length,
    slowCount: subagents.filter((item) => item.slow).length,
    verySlowCount: subagents.filter((item) => item.verySlow).length,
    // 0 in a healthy run: the depth-1 cap holds. Any breach means a grandchild
    // subagent ran — the runaway "subtask spawns subtasks" failure mode.
    nestedTaskBreaches: subagents.filter((item) => item.nestedTaskBreach).length,
    totalDurationMs,
    subagents,
  };
}

module.exports = {
  SLOW_SUBAGENT_MS,
  VERY_SLOW_SUBAGENT_MS,
  isSubagentTool,
  buildSubagentTelemetry,
  subagentTitle,
};
