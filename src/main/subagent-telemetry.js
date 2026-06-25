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
    const durationMs = Number(tool.durationMs || 0);
    return {
      id: tool.id || "",
      title: subagentTitle(tool),
      status: tool.status || "",
      durationMs,
      slow: durationMs >= SLOW_SUBAGENT_MS,
      verySlow: durationMs >= VERY_SLOW_SUBAGENT_MS,
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
