"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

/**
 * Workspace-learned context for session guides:
 *  - L2: conventions the user's repo already carries (.cursorrules, AGENTS.md
 *    — AGENTS.md/CLAUDE.md are skipped because the engine reads them natively from cwd)
 *  - L1: conventions the user explicitly asked us to remember ("记住：…"),
 *    stored app-side per project so we never write into the user's folders.
 * Both sections are injected into the per-session AGENT.md; the signature
 * keeps the guide cache honest when any source changes.
 */

const MAX_SECTION_CHARS = 4000;
const WORKSPACE_RULE_FILES = [".cursorrules", "AGENTS.md", ".windsurfrules"];

/** Guide sections follow the app locale: a Chinese-language system prompt
 * nudges the model into Chinese replies for English users. */
function isZh() {
  try {
    return String(require("./locale-settings").getLocale() || "").startsWith("zh");
  } catch {
    return false;
  }
}

function clip(text, limit = MAX_SECTION_CHARS) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n${isZh() ? "…（已截断）" : "… (truncated)"}`;
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

function normalizeConventionText(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[-*\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function conventionKey(value) {
  return normalizeConventionText(value)
    .toLowerCase()
    .replace(/[。.!！?？,，;；:：\s]+/g, "");
}

function listLearnedConventions(projectId) {
  const text = readLearnedConventions(projectId);
  return text
    .split(/\r?\n/)
    .map((line, index) => {
      const value = normalizeConventionText(line);
      if (!value) return null;
      const dateMatch = String(line || "").match(/<!--\s*([^>]+?)\s*-->/);
      return {
        key: conventionKey(value),
        text: value,
        createdAt: dateMatch?.[1] || "",
        line: index + 1,
      };
    })
    .filter(Boolean);
}

function writeConventionEntries(projectId, entries) {
  const filePath = learnedConventionsPath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const text = normalizeConventionText(entry?.text || entry);
      if (!text) return "";
      const date = entry?.createdAt ? String(entry.createdAt).slice(0, 10) : new Date().toISOString().slice(0, 10);
      return `- ${text}  <!-- ${date} -->`;
    })
    .filter(Boolean);
  if (!lines.length) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
    return true;
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return true;
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

function removeLearnedConvention(projectId, key) {
  const target = String(key || "");
  if (!target) return null;
  const entries = listLearnedConventions(projectId);
  const next = entries.filter((entry) => entry.key !== target);
  if (next.length === entries.length) return null;
  writeConventionEntries(projectId, next);
  return { removed: entries.length - next.length, key: target };
}

function clearLearnedConventions(projectId) {
  return writeConventionEntries(projectId, []);
}

/** Replace a project's learned conventions wholesale (used by pack import). */
function writeLearnedConventions(projectId, text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const filePath = learnedConventionsPath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${value}\n`, "utf8");
  return true;
}

function buildLearnedSection(projectId) {
  const text = readLearnedConventions(projectId).trim();
  if (!text) return "";
  const title = isZh()
    ? "已学约定（用户明确要求记住的，必须遵循）"
    : "Learned conventions (the user explicitly asked to remember these — follow them)";
  return `\n## ${title}\n\n${clip(text)}\n`;
}

function buildWorkspaceRulesSection(workspacePath) {
  if (!workspacePath) return "";
  const parts = [];
  for (const name of WORKSPACE_RULE_FILES) {
    const filePath = path.join(workspacePath, name);
    try {
      if (!fs.existsSync(filePath)) continue;
      const text = fs.readFileSync(filePath, "utf8").trim();
      if (text) parts.push(`### ${isZh() ? "来自" : "From"} ${name}\n${clip(text)}`);
    } catch {
      // unreadable workspace file: skip silently
    }
  }
  if (!parts.length) return "";
  const title = isZh()
    ? "工作区已有约定（用户仓库自带，必须遵循）"
    : "Existing workspace conventions (from the user's repo — follow them)";
  return `\n## ${title}\n\n${parts.join("\n\n")}\n`;
}

// --- Workspace digest (L0 map: the model wakes up knowing the terrain) ------
const DIGEST_SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "release", "bundles", "__pycache__",
  ".git", ".lily-work", "venv", ".venv",
]);
const DIGEST_MAX_ENTRIES = 50;
const DIGEST_RECENT_FILES = 8;
const DIGEST_SCAN_CAP = 2000;

/** Bounded two-level tree summary plus the most recently modified files. */
function buildWorkspaceDigest(workspacePath) {
  let rootEntries;
  try {
    rootEntries = fs.readdirSync(workspacePath, { withFileTypes: true });
  } catch {
    return "";
  }
  const treeLines = [];
  const recent = [];
  let scanned = 0;
  let truncated = false;

  const noteRecent = (filePath, mtimeMs) => {
    recent.push({ filePath, mtimeMs });
    if (recent.length > DIGEST_RECENT_FILES * 4) {
      recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
      recent.length = DIGEST_RECENT_FILES;
    }
  };

  for (const entry of rootEntries) {
    if (entry.name.startsWith(".") && entry.name !== ".cursorrules") continue;
    if (treeLines.length >= DIGEST_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const full = path.join(workspacePath, entry.name);
    scanned += 1;
    if (entry.isDirectory()) {
      if (DIGEST_SKIP_DIRS.has(entry.name)) continue;
      let children = [];
      try {
        children = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      treeLines.push(`- ${entry.name}/ (${children.length})`);
      for (const child of children) {
        if (scanned > DIGEST_SCAN_CAP) break;
        scanned += 1;
        if (child.name.startsWith(".")) continue;
        if (child.isDirectory()) {
          if (treeLines.length < DIGEST_MAX_ENTRIES) treeLines.push(`  - ${entry.name}/${child.name}/`);
          else truncated = true;
        } else {
          try {
            noteRecent(path.join(entry.name, child.name), fs.statSync(path.join(full, child.name)).mtimeMs);
          } catch {
            // unreadable child: skip
          }
        }
      }
    } else {
      treeLines.push(`- ${entry.name}`);
      try {
        noteRecent(entry.name, fs.statSync(full).mtimeMs);
      } catch {
        // unreadable file: skip
      }
    }
  }

  if (!treeLines.length) return "";
  const zh = isZh();
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recentLines = recent.slice(0, DIGEST_RECENT_FILES).map((item) => {
    const day = new Date(item.mtimeMs).toISOString().slice(0, 10);
    return `- ${item.filePath} (${day})`;
  });
  const parts = [zh ? "目录结构：" : "Directory structure:", ...treeLines];
  if (truncated) parts.push(zh ? "…（已截断）" : "… (truncated)");
  if (recentLines.length) {
    parts.push("", zh ? "最近修改：" : "Recently modified:", ...recentLines);
  }
  return parts.join("\n");
}

function buildWorkspaceDigestSection(workspacePath) {
  if (!workspacePath) return "";
  const digest = buildWorkspaceDigest(workspacePath);
  if (!digest) return "";
  const title = isZh()
    ? "工作区概览（自动生成的快照，定位文件先看这里）"
    : "Workspace overview (auto-generated snapshot — check here before searching)";
  return `\n## ${title}\n\n${clip(digest)}\n`;
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
    pieces.push(buildWorkspaceDigest(workspacePath));
  }
  return pieces.join("\0");
}

module.exports = {
  appendLearnedConvention,
  buildLearnedSection,
  buildWorkspaceDigest,
  buildWorkspaceDigestSection,
  buildWorkspaceRulesSection,
  clearLearnedConventions,
  conventionKey,
  contextSignature,
  learnedConventionsPath,
  listLearnedConventions,
  readLearnedConventions,
  removeLearnedConvention,
  writeLearnedConventions,
};
