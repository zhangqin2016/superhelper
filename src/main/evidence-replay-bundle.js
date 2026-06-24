"use strict";

const MAX_PREVIEW = 900;
const MAX_DIFF_LINES = 80;

function compactText(value, limit = MAX_PREVIEW) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function summarizeInput(input = {}) {
  const keys = ["command", "cmd", "file_path", "path", "query", "pattern", "url", "prompt", "description", "instructions"];
  const out = {};
  for (const key of keys) {
    if (input?.[key] != null) out[key] = compactText(input[key], 240);
  }
  if (Object.keys(out).length) return out;
  return input && typeof input === "object"
    ? { preview: compactText(JSON.stringify(input), 360) }
    : {};
}

function diffPreview(diff = []) {
  return (Array.isArray(diff) ? diff : [])
    .slice(0, MAX_DIFF_LINES)
    .map((line) => {
      const type = line?.type || "ctx";
      const prefix = type === "add" ? "+" : type === "del" ? "-" : " ";
      return `${prefix}${String(line?.content || "")}`;
    });
}

function buildEvidenceReplayBundle(record = {}) {
  const items = [];
  const turnId = record.turnId || "";
  const subagentToolIds = new Set();

  for (const tool of record.tools || []) {
    if (String(tool.name || "").toLowerCase() === "task") {
      subagentToolIds.add(tool.id || "");
      items.push({
        id: `subagent:${tool.id || items.length}`,
        kind: "subagent_handoff",
        title: tool.input?.description || tool.input?.prompt || tool.name || "subagent",
        status: tool.status || "",
        sourceId: tool.id || "",
        replay: {
          type: "subagent_handoff",
          input: summarizeInput(tool.input || {}),
        },
      });
    }
    items.push({
      id: `tool:${tool.id || tool.name || items.length}`,
      kind: "tool",
      title: tool.name || "tool",
      status: tool.status || "",
      sourceId: tool.id || "",
      replay: {
        type: "tool_input",
        input: summarizeInput(tool.input || {}),
      },
    });
  }

  for (const tool of record.tools || []) {
    if (!tool.parentToolUseId) continue;
    if (!subagentToolIds.has(tool.parentToolUseId)) subagentToolIds.add(tool.parentToolUseId);
    items.push({
      id: `subagent_child:${tool.parentToolUseId}:${tool.id || items.length}`,
      kind: "subagent_child_tool",
      title: tool.name || tool.id || "tool",
      status: tool.status || "",
      sourceId: tool.id || "",
      replay: {
        type: "subagent_child_tool",
        parentToolUseId: tool.parentToolUseId,
        input: summarizeInput(tool.input || {}),
      },
    });
  }

  for (const change of record.fileChanges || []) {
    items.push({
      id: `file:${change.filePath || change.fileName || items.length}`,
      kind: "file_change",
      title: change.fileName || change.filePath || "file",
      status: change.status || "",
      sourceId: change.toolId || "",
      replay: {
        type: "file_checkpoint",
        filePath: change.filePath || "",
        fileName: change.fileName || "",
        stats: change.stats || null,
        originalAvailable: change.originalContent != null,
        originalPreview: compactText(change.originalContent, 500),
        diffPreview: diffPreview(change.diff),
        diffTruncated: Array.isArray(change.diff) && change.diff.length > MAX_DIFF_LINES,
      },
    });
  }

  for (const artifact of record.artifacts || []) {
    items.push({
      id: `artifact:${artifact.id || artifact.path || items.length}`,
      kind: "artifact",
      title: artifact.title || artifact.fileName || artifact.path || artifact.type || "artifact",
      status: "available",
      sourceId: artifact.id || "",
      replay: {
        type: "artifact_path",
        path: artifact.path || "",
        relativePath: artifact.relativePath || "",
        mimeType: artifact.mimeType || "",
        bytes: artifact.bytes || 0,
      },
    });
  }

  if (record.meta?.evidenceGate && record.meta.evidenceGate.ok === false) {
    items.push({
      id: `evidence_gap:${turnId || items.length}`,
      kind: "evidence_gap",
      title: record.meta.evidenceGate.reason || "evidence gap",
      status: "attention",
      replay: {
        type: "evidence_gap",
        reason: record.meta.evidenceGate.reason || "",
      },
    });
  }

  return {
    schemaVersion: 1,
    turnId,
    itemCount: items.length,
    items,
  };
}

module.exports = {
  buildEvidenceReplayBundle,
};
