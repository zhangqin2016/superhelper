"use strict";

function sourceLabel(pointer = {}) {
  if (pointer.type === "turn" && pointer.turnId) return `turn:${pointer.turnId}`;
  if (pointer.type === "file" && pointer.filePath) return `file:${pointer.filePath}`;
  if (pointer.type === "directory" && pointer.filePath) return `directory:${pointer.filePath}`;
  if (pointer.type === "runtime_compaction") {
    return `compaction:${pointer.summaryMessageId || pointer.engineSessionId || "runtime"}`;
  }
  if (pointer.type === "learned_conventions") return `learned:${pointer.projectId || "project"}`;
  return "";
}

function explainMemoryItem(item = {}) {
  const parts = [];
  const kind = item.kind || item.id || "memory";
  parts.push(`${kind}: ${item.reason || "selected as context"}`);
  if (Number.isFinite(item.relevance) && item.relevance > 0) {
    parts.push(`relevance ${Math.round(item.relevance * 100)}%`);
  }
  if (item.trust) parts.push(`trust ${item.trust}`);
  if (item.proof === false) parts.push("not proof");
  const sources = (Array.isArray(item.sourcePointers) ? item.sourcePointers : [])
    .map(sourceLabel)
    .filter(Boolean);
  if (sources.length) parts.push(`source ${sources.slice(0, 3).join(", ")}`);
  return parts.join("; ");
}

function explainContextMemory(trace = {}) {
  const items = Array.isArray(trace.items) ? trace.items : [];
  const skipped = Array.isArray(trace.skipped) ? trace.skipped : [];
  return {
    injected: Boolean(trace.injected),
    deduped: Boolean(trace.deduped),
    contextEpoch: Number(trace.contextEpoch || 0),
    selected: items.map(explainMemoryItem),
    skipped: skipped.map((item) => `${item.kind || item.id || "memory"}: ${item.skipReason || "skipped"}`),
  };
}

module.exports = {
  explainContextMemory,
  explainMemoryItem,
};
