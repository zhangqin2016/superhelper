"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SAFE_GENERATED_TOP_LEVEL = new Set([
  ".lily-work",
  "generated-assets",
  "tmp",
  "temp",
]);

function normalizeTargetPath(projectPath, targetPath) {
  if (!projectPath || !targetPath || typeof targetPath !== "string") return "";
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return resolved;
}

function firstPathSegment(projectPath, targetPath) {
  const resolved = normalizeTargetPath(projectPath, targetPath);
  if (!resolved) return "";
  const relative = path.relative(path.resolve(projectPath), resolved);
  return relative.split(path.sep).filter(Boolean)[0] || "";
}

function parentExists(targetPath) {
  try {
    return fs.existsSync(path.dirname(targetPath));
  } catch {
    return false;
  }
}

function topLevelExists(projectPath, segment) {
  try {
    return Boolean(segment) && fs.existsSync(path.join(path.resolve(projectPath), segment));
  } catch {
    return false;
  }
}

function extractWriteTarget(toolName, input = {}) {
  const tool = String(toolName || "").toLowerCase();
  const direct =
    input.filePath ||
    input.path ||
    input.file ||
    input.targetPath ||
    input.dest ||
    input.destination ||
    input.filename;
  if ((tool === "edit" || tool === "write" || tool === "patch") && direct) return String(direct);
  if (tool !== "bash") return direct ? String(direct) : "";

  const command = String(input.command || input.cmd || "");
  const mkdir = command.match(/\bmkdir\s+(?:-[^\s]+\s+)*["']?([^"';&|<>]+)["']?/);
  if (mkdir) return mkdir[1].trim();
  const redirect = command.match(/(?:>|>>)\s*["']?([^"';&|<>]+)["']?/);
  if (redirect) return redirect[1].trim();
  const touch = command.match(/\btouch\s+["']?([^"';&|<>]+)["']?/);
  if (touch) return touch[1].trim();
  return "";
}

function assessWorkspaceWrite({ projectPath, toolName, input = {}, groundingPolicy = null } = {}) {
  if (!groundingPolicy?.required) return { verdict: "allow", reason: "grounding_not_required" };
  if (groundingPolicy.allowNewTopLevel) return { verdict: "allow", reason: "greenfield_allowed" };

  const target = extractWriteTarget(toolName, input);
  if (!target) return { verdict: "allow", reason: "no_write_target" };
  const resolved = normalizeTargetPath(projectPath, target);
  if (!resolved) return { verdict: "ask", reason: "target_outside_workspace", target };

  const top = firstPathSegment(projectPath, resolved);
  if (SAFE_GENERATED_TOP_LEVEL.has(top)) return { verdict: "allow", reason: "safe_generated_workspace", target: resolved };
  if (!topLevelExists(projectPath, top)) {
    return {
      verdict: "ask",
      reason: "new_top_level_without_grounding",
      target: resolved,
      message:
        "This turn is grounded to the existing workspace. Creating a new top-level directory needs explicit user confirmation or evidence that no existing target fits.",
    };
  }
  if (!parentExists(resolved)) {
    return {
      verdict: "ask",
      reason: "new_nested_parent_without_grounding",
      target: resolved,
      message:
        "The write target's parent directory does not exist. Reuse an existing target or confirm the new structure before creating it.",
    };
  }
  return { verdict: "allow", reason: "existing_workspace_target", target: resolved };
}

module.exports = {
  assessWorkspaceWrite,
  extractWriteTarget,
  normalizeTargetPath,
};
