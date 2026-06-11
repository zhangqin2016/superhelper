"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

/**
 * Workspace-learned context for session guides:
 *  - L2: conventions the user's repo already carries (.cursorrules, AGENTS.md
 *    — CLAUDE.md is skipped because the engine reads it natively from cwd)
 *  - L1: conventions the user explicitly asked us to remember ("记住：…"),
 *    stored app-side per project so we never write into the user's folders.
 * Both sections are injected into the per-session AGENT.md; the signature
 * keeps the guide cache honest when any source changes.
 */

const MAX_SECTION_CHARS = 4000;
const WORKSPACE_RULE_FILES = [".cursorrules", "AGENTS.md", ".windsurfrules"];

function clip(text, limit = MAX_SECTION_CHARS) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断）`;
}

function safeProjectFile(projectId) {
  return `${String(projectId || "default").replace(/[^a-zA-Z0-9._-]/g, "_")}.md`;
}

function learnedConventionsPath(projectId) {
  return userDataPath("learned-conventions", safeProjectFile(projectId));
}

function readLearnedConventions(projectId) {
  try {
    return fs.readFileSync(learnedConventionsPath(projectId), "utf8");
  } catch {
    return "";
  }
}

/** Appends one remembered convention with provenance; returns the entry. */
function appendLearnedConvention(projectId, text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  const filePath = learnedConventionsPath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entry = `- ${value}  <!-- ${new Date().toISOString().slice(0, 10)} -->\n`;
  fs.appendFileSync(filePath, entry, "utf8");
  return entry;
}

function buildLearnedSection(projectId) {
  const text = readLearnedConventions(projectId).trim();
  if (!text) return "";
  return `\n## 已学约定（用户明确要求记住的，必须遵循）\n\n${clip(text)}\n`;
}

function buildWorkspaceRulesSection(workspacePath) {
  if (!workspacePath) return "";
  const parts = [];
  for (const name of WORKSPACE_RULE_FILES) {
    const filePath = path.join(workspacePath, name);
    try {
      if (!fs.existsSync(filePath)) continue;
      const text = fs.readFileSync(filePath, "utf8").trim();
      if (text) parts.push(`### 来自 ${name}\n${clip(text)}`);
    } catch {
      // unreadable workspace file: skip silently
    }
  }
  if (!parts.length) return "";
  return `\n## 工作区已有约定（用户仓库自带，必须遵循）\n\n${parts.join("\n\n")}\n`;
}

/** Cache key fragment: changes whenever any learned/workspace source changes. */
function contextSignature(projectId, workspacePath) {
  const pieces = [readLearnedConventions(projectId)];
  if (workspacePath) {
    for (const name of WORKSPACE_RULE_FILES) {
      try {
        const stat = fs.statSync(path.join(workspacePath, name));
        pieces.push(`${name}:${stat.mtimeMs}:${stat.size}`);
      } catch {
        pieces.push(`${name}:absent`);
      }
    }
  }
  return pieces.join("\0");
}

module.exports = {
  appendLearnedConvention,
  buildLearnedSection,
  buildWorkspaceRulesSection,
  contextSignature,
  learnedConventionsPath,
  readLearnedConventions,
};
