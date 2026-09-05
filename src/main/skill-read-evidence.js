"use strict";

const path = require("node:path");
function normalizePath(value) { return String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/"); }
function toolGuidePath(tool) {
  if (!["read", "notebookread"].includes(String(tool?.name || tool?.tool || "").toLowerCase())) return "";
  const input = tool.input || {};
  const file = normalizePath(input.file_path || input.filePath || input.path || input.notebook_path);
  return path.posix.basename(file).toLowerCase() === "skill.md" ? file : "";
}
function readOutcome(tool) {
  if (tool?.completionObserved === false) return "unknown";
  if (tool?.isError || tool?.result?.isError || tool?.result?.ok === false || ["failed", "error", "cancelled", "canceled"].includes(tool?.status)) return "failed";
  return ["done", "completed"].includes(tool?.status) ? "success" : "unknown";
}
function collectSkillGuideReadEvidence(tools = [], workspacePath = "") {
  return (Array.isArray(tools) ? tools : []).flatMap(tool => {
    let file = toolGuidePath(tool);
    if (!file) return [];
    if (workspacePath && !path.isAbsolute(file) && !/^[a-z]:\//i.test(file)) file = normalizePath(path.resolve(workspacePath, file));
    return [{ path: file, outcome: readOutcome(tool) }];
  });
}
function matchesGuide(file, guide) {
  // A bare SKILL.md must never claim every skill was read.
  return normalizePath(file) === normalizePath(guide);
}
module.exports = { collectSkillGuideReadEvidence, matchesGuide };
