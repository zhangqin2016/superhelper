"use strict";

// Cross-session memory injection for native compaction (#1). Lily writes a small,
// curated "navigation memory" file per engine session; the OpenCode plugin
// resources/opencode-plugins/compaction-memory.js reads it at compaction time and
// injects it into the summary so long sessions don't forget durable facts.
//
// The two sides run in DIFFERENT processes (Lily main vs the OpenCode/Bun serve),
// so the contract is a file:
//   <COMPACTION_MEMORY_DIRNAME>/<engineSessionID>.json = { schemaVersion, blocks: string[] }
// Keyed by the ENGINE session id because that is all the plugin's hook input knows.

const fs = require("node:fs");
const path = require("node:path");

// Both the writer (here / opencode-agent-session) and the serve env
// (LILY_COMPACTION_MEMORY_DIR in session-runner-pool) must resolve to this same
// dir. Centralized so the two sides can never drift.
const COMPACTION_MEMORY_DIRNAME = "opencode-compaction-memory";
// Bound the injection so we never re-bloat the very context compaction is freeing.
const DEFAULT_MAX_CHARS = 1500;

function trim(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Curated, priority-ordered, char-bounded navigation blocks from a Lily session
 * summary. Most-durable first so the budget keeps what matters when space is tight.
 * PURE — unit-tested without the engine. Returns string[] (each entry is one
 * `context` string the engine's buildPrompt will fold into the compaction prompt).
 */
function buildCompactionMemoryBlocks(summary, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!summary || typeof summary !== "object") return [];
  const candidates = [];
  if (summary.pendingTask) candidates.push(`未完成/待办：${trim(summary.pendingTask, 400)}`);
  if (summary.lastUserIntent) candidates.push(`最近用户意图：${trim(summary.lastUserIntent, 400)}`);
  if (summary.lastAssistantResult) candidates.push(`最近助手结论：${trim(summary.lastAssistantResult, 400)}`);
  if (Array.isArray(summary.recentEvidenceGaps) && summary.recentEvidenceGaps.length) {
    const gaps = summary.recentEvidenceGaps
      .slice(-3)
      .map((gap) => trim(gap && gap.reason, 180))
      .filter(Boolean)
      .join("；");
    if (gaps) candidates.push(`待补证据：${gaps}`);
  }
  if (Array.isArray(summary.recentFiles) && summary.recentFiles.length) {
    const files = summary.recentFiles.filter(Boolean).slice(-8).join(", ");
    if (files) candidates.push(`近期文件：${files}`);
  }

  const blocks = [];
  let used = 0;
  for (const block of candidates) {
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks;
}

/** Engine session ids are like `ses_…`; reject anything not filename-safe. */
function safeSessionId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || "")) ? String(id) : "";
}

function compactionMemoryFilePath(dir, engineSessionId) {
  const id = safeSessionId(engineSessionId);
  if (!dir || !id) return "";
  return path.join(dir, `${id}.json`);
}

/**
 * Write the handoff file the plugin reads. Fail-safe: returns "" on any error or
 * when there is nothing worth injecting (so the plugin then leaves compaction
 * untouched and the engine uses its default — never a regression).
 */
function writeCompactionMemoryFile(dir, engineSessionId, summary, opts = {}) {
  try {
    const file = compactionMemoryFilePath(dir, engineSessionId);
    if (!file) return "";
    const blocks = buildCompactionMemoryBlocks(summary, opts);
    if (!blocks.length) return "";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, blocks }));
    return file;
  } catch {
    return "";
  }
}

module.exports = {
  COMPACTION_MEMORY_DIRNAME,
  DEFAULT_MAX_CHARS,
  buildCompactionMemoryBlocks,
  compactionMemoryFilePath,
  writeCompactionMemoryFile,
};
