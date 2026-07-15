"use strict";

// Compact, renderer-friendly summary of which memories a turn actually used.
// Pure transform over the per-turn contextMemory trace (turn-orchestrator builds
// it). Read-only + fail-open: any bad input → null (the UI simply shows nothing),
// so this can never affect a turn's answer — it only surfaces what memory recall
// already did. Kept small and bounded so it's cheap to persist per message.

// Human labels + scope for each memory kind. Scope answers "is this session-level
// or workspace-level (cross-session)?" — see [[memory-semantic-embeddings]].
const KIND_META = {
  session_summary: { label: "会话摘要", labelEn: "Session summary", scope: "session" },
  compaction_state: { label: "压缩状态", labelEn: "Compaction state", scope: "session" },
  evidence_gap: { label: "证据缺口", labelEn: "Evidence gap", scope: "session" },
  project_identity: { label: "项目标识", labelEn: "Project identity", scope: "workspace" },
  project_memory: { label: "工作区记忆", labelEn: "Workspace memory", scope: "workspace" },
  workspace_digest: { label: "工作区结构", labelEn: "Workspace structure", scope: "workspace" },
  learned_conventions: { label: "学到的约定", labelEn: "Learned conventions", scope: "workspace" },
};

const MAX_ITEMS = 12;
const MAX_REASON = 80;

function kindMeta(kind) {
  return KIND_META[kind] || { label: String(kind || "记忆"), labelEn: String(kind || "memory"), scope: "workspace" };
}

// Best human-readable source pointer (file path or originating turn), if any.
function sourceLabel(item) {
  const pointer = Array.isArray(item?.sourcePointers) ? item.sourcePointers[0] : null;
  if (!pointer) return "";
  if (pointer.filePath) {
    const parts = String(pointer.filePath).split(/[\\/]/);
    return parts[parts.length - 1] || String(pointer.filePath);
  }
  if (pointer.turnId) return "本会话较早的对话";
  return "";
}

function clampReason(reason) {
  const text = String(reason || "").trim().replace(/\s+/g, " ");
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 1)}…` : text;
}

// contextMemory: the trace object at turn-orchestrator (has injected/items/diagnostics).
// Returns null when nothing was injected, else a compact usage summary. NEVER throws.
function summarizeMemoryUsage(contextMemory) {
  try {
    // Kill switch: LILY_MEMORY_USAGE=0 → never compute the summary → chip never
    // renders anywhere (source-level off). Default on.
    if (typeof process !== "undefined" && process.env && process.env.LILY_MEMORY_USAGE === "0") return null;
    if (!contextMemory || !contextMemory.injected) return null;
    const rawItems = Array.isArray(contextMemory.items) ? contextMemory.items : [];
    if (!rawItems.length) return null;

    // "semantic" only when real-embedding ranking drove this turn (else lexical).
    const mode = contextMemory?.diagnostics?.semanticIndex === "embedding" ? "semantic" : "lexical";

    const items = rawItems.slice(0, MAX_ITEMS).map((item) => {
      const meta = kindMeta(item.kind);
      return {
        kind: item.kind,
        label: meta.label,
        labelEn: meta.labelEn,
        scope: meta.scope,
        reason: clampReason(item.reason),
        source: sourceLabel(item),
        trust: item.trust || "unknown",
        relevance: Number(item.relevance || 0),
        semanticRelevance: Number(item.semanticRelevance || 0),
      };
    });

    return {
      used: true,
      count: rawItems.length,
      truncated: rawItems.length > items.length,
      mode, // "semantic" | "lexical"
      scopes: {
        session: items.filter((i) => i.scope === "session").length,
        workspace: items.filter((i) => i.scope === "workspace").length,
      },
      items,
    };
  } catch {
    return null;
  }
}

module.exports = { summarizeMemoryUsage, KIND_META };
