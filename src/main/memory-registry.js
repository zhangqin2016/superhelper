"use strict";

const crypto = require("node:crypto");
const { rankWithDurableVectorIndex, entryKey, makeEmbeddingCaller, resolveEmbeddingConfig, semanticRelevanceMap } = require("./memory-vector-index");

const DEFAULT_MAX_CHARS = 3_000;

function compactText(value, limit = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function itemSize(item = {}) {
  return String(item.text || "").length + 32;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || "")).digest("hex");
}

function tokenizeForRetrieval(value) {
  const text = String(value || "").toLowerCase();
  const tokens = new Set();
  for (const match of text.matchAll(/[a-z0-9_.:/-]{3,}/g)) tokens.add(match[0]);
  const compact = text.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i += 1) {
    const pair = compact.slice(i, i + 2);
    if (/[\u4e00-\u9fff]/.test(pair)) tokens.add(pair);
  }
  return [...tokens].slice(0, 80);
}

function memoryRelevanceScore(item = {}, query = "") {
  const queryTokens = tokenizeForRetrieval(query);
  if (!queryTokens.length) return 0;
  const haystack = [
    item.id,
    item.kind,
    item.reason,
    item.text,
  ].map((value) => String(value || "").toLowerCase()).join("\n");
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / queryTokens.length;
}

// STABLE identity for reinforcement — id+kind+sourceVersion, NOT the text-hash
// entryKey. Selection can COMPACT an over-budget item's text, which would change
// entryKey; keying reinforcement off identity keeps record-time and load-time keys
// aligned so the boost actually applies (and survives cosmetic text changes).
function reinforcementKey(item = {}) {
  return `${item.id || ""}:${item.kind || ""}:${item.sourceVersion || ""}`;
}

function rankMemoryItemsWithDiagnostics(items = [], query = "", opts = {}) {
  const list = Array.isArray(items) ? items : [];
  // When a REAL-embedding semantic map is supplied (opts.semanticMap), use it for
  // semanticRelevance; otherwise fall back to the lexical hash vector index. The
  // keyword relevance score always applies on top, so both paths stay grounded.
  const semanticMap = opts.semanticMap instanceof Map ? opts.semanticMap : null;
  const ranked = semanticMap
    ? { items: list, diagnostics: { semanticIndex: "embedding", entries: semanticMap.size } }
    : rankWithDurableVectorIndex(list, query, { projectKey: opts.projectKey || "" });
  return {
    items: ranked.items.map((item) => {
    const relevance = memoryRelevanceScore(item, query);
    const semanticRelevance = semanticMap
      ? Number(semanticMap.get(entryKey(item)) || 0)
      : Number(item.semanticRelevance || 0);
    const critical = Number(item?.priority || 0) >= 90;
    // Reinforcement (④): a small, BOUNDED nudge for memories that keep proving
    // useful. opts.reinforcement is a Map(entryKey → boost ≤ MAX_BOOST). Deliberately
    // tiny vs relevance*25 so it only reorders already-relevant items — never
    // surfaces an irrelevant one. Not applied to critical items (they're pinned).
    const reinforcement = opts.reinforcement instanceof Map ? Number(opts.reinforcement.get(reinforcementKey(item)) || 0) : 0;
    return {
      ...item,
      relevance,
      semanticRelevance,
      reinforcement,
      effectivePriority: Number(item?.priority || 0) + (critical ? 0 : relevance * 25 + semanticRelevance * 18 + reinforcement),
    };
    }),
    diagnostics: ranked.diagnostics || { semanticIndex: "local_fallback" },
  };
}

function rankMemoryItems(items = [], query = "") {
  return rankMemoryItemsWithDiagnostics(items, query).items;
}

function selectMemoryItemsWithDiagnostics(items = [], { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const sorted = (Array.isArray(items) ? items : [])
    .filter((item) => item && String(item.text || "").trim())
    .map((item) => ({ ...item, size: itemSize(item) }))
    .sort((a, b) => {
      const priorityDelta = Number(b.effectivePriority ?? b.priority ?? 0) - Number(a.effectivePriority ?? a.priority ?? 0);
      if (priorityDelta) return priorityDelta;
      return Number(b.priority || 0) - Number(a.priority || 0);
    });
  const selected = [];
  const skipped = [];
  let used = 0;
  if (maxChars <= 0) {
    return {
      selected,
      skipped: sorted.map((item) => ({ ...item, skipReason: "memory_budget_disabled" })),
      diagnostics: {
        maxChars,
        usedChars: used,
        rawCount: sorted.length,
        selectedCount: selected.length,
        skippedCount: sorted.length,
      },
    };
  }
  for (const item of sorted) {
    const size = item.size;
    if (selected.length && used + size > maxChars) continue;
    if (!selected.length && size > maxChars) {
      const compacted = { ...item, text: compactText(item.text, Math.max(120, maxChars - 32)) };
      compacted.size = itemSize(compacted);
      selected.push(compacted);
      used += compacted.size;
      break;
    }
    selected.push(item);
    used += size;
  }
  const selectedIds = new Set(selected.map((item) => item.id));
  for (const item of sorted) {
    if (!selectedIds.has(item.id)) skipped.push({ ...item, skipReason: "memory_budget_exceeded" });
  }
  return {
    selected,
    skipped,
    diagnostics: {
      maxChars,
      usedChars: used,
      rawCount: sorted.length,
      selectedCount: selected.length,
      skippedCount: skipped.length,
    },
  };
}

function selectMemoryItems(items = [], { maxChars = DEFAULT_MAX_CHARS } = {}) {
  return selectMemoryItemsWithDiagnostics(items, { maxChars }).selected;
}

function resolveMemoryMaxChars(rawItems = [], input = {}) {
  if (Number.isFinite(input.maxChars)) return Number(input.maxChars);
  const budget = input.turnPolicy?.memoryBudget;
  if (Number.isFinite(budget?.maxChars)) {
    const maxChars = Number(budget.maxChars);
    if (maxChars > 0) return maxChars;
    const hasCriticalMemory = rawItems.some((item) => Number(item?.priority || 0) >= 90);
    return hasCriticalMemory ? Number(budget.criticalMaxChars || 1200) : 0;
  }
  return DEFAULT_MAX_CHARS;
}

function shouldIncludeSessionSummary({ turnPolicy = {}, includeSessionSummary = true, coldStart = false, shortFollowup = false } = {}) {
  if (!includeSessionSummary) return false;
  if (coldStart || shortFollowup) return true;
  return turnPolicy.rigor === "grounded" || turnPolicy.rigor === "coverage";
}

function buildMemoryItems({
  sessionSummary = null,
  project = null,
  projectMemory = null,
  workspaceDigest = "",
  learnedConventions = "",
  turnPolicy = {},
  includeSessionSummary = true,
  coldStart = false,
  shortFollowup = false,
} = {}) {
  const items = [];
  const summary = sessionSummary && typeof sessionSummary === "object" ? sessionSummary : null;
  if (summary && shouldIncludeSessionSummary({ turnPolicy, includeSessionSummary, coldStart, shortFollowup })) {
    const lines = [
      summary.pendingTask ? `Pending task: ${compactText(summary.pendingTask, 300)}` : "",
      summary.lastUserIntent ? `Last user intent: ${compactText(summary.lastUserIntent, 300)}` : "",
      summary.lastAssistantResult ? `Last assistant result: ${compactText(summary.lastAssistantResult, 360)}` : "",
      Array.isArray(summary.recentFiles) && summary.recentFiles.length
        ? `Recent files: ${summary.recentFiles.slice(-8).join(", ")}`
        : "",
    ].filter(Boolean);
    if (lines.length) {
      const recentTurn = Array.isArray(summary.recentTurnPointers)
        ? summary.recentTurnPointers.at(-1)
        : null;
      items.push({
        id: "session_summary",
        kind: "session_summary",
        priority: summary.pendingTask ? 100 : 70,
        trust: "lily_session_memory",
        proof: false,
        sourceVersion: stableHash({
          pendingTask: summary.pendingTask || "",
          lastUserIntent: summary.lastUserIntent || "",
          lastAssistantResult: summary.lastAssistantResult || "",
          recentFiles: summary.recentFiles || [],
          recentTurnPointers: summary.recentTurnPointers || [],
        }),
        sourcePointers: [
          recentTurn?.turnId
            ? {
                type: "turn",
                turnId: recentTurn.turnId,
                engineMessageId: recentTurn.engineMessageId || "",
              }
            : null,
        ].filter(Boolean),
        reason: "recent session continuity",
        text: lines.join("\n"),
      });
    }
  }

  if (summary?.lastCompactedAt) {
    items.push({
      id: "compaction_state",
      kind: "compaction_state",
      priority: 90,
      trust: "runtime_state",
      proof: false,
      sourceVersion: summary.lastCompactedAt || "",
      sourcePointers: [
        summary.lastCompaction?.summaryMessageId || summary.lastCompaction?.engineSessionId
          ? {
              type: "runtime_compaction",
              engineSessionId: summary.lastCompaction?.engineSessionId || "",
              summaryMessageId: summary.lastCompaction?.summaryMessageId || "",
            }
          : null,
      ].filter(Boolean),
      reason: "runtime context was compacted",
      text: `Lily context was last compacted at ${summary.lastCompactedAt}; compaction count: ${summary.compactionCount || 1}. Treat memory as navigation context, not proof.`,
    });
  }

  if (Array.isArray(summary?.recentEvidenceGaps) && summary.recentEvidenceGaps.length) {
    const gaps = summary.recentEvidenceGaps.slice(-3).map((gap) => [
      `Reason: ${compactText(gap.reason, 180)}`,
      gap.userIntent ? `User intent: ${compactText(gap.userIntent, 260)}` : "",
      gap.assistantPreview ? `Unsupported answer preview: ${compactText(gap.assistantPreview, 260)}` : "",
    ].filter(Boolean).join("\n"));
    items.push({
      id: "recent_evidence_gaps",
      kind: "evidence_gap",
      priority: 120,
      trust: "lily_evidence_memory",
      proof: false,
      sourceVersion: stableHash(summary.recentEvidenceGaps || []),
      sourcePointers: summary.recentEvidenceGaps
        .slice(-3)
        .map((gap) => gap.turnId ? { type: "turn", turnId: gap.turnId } : null)
        .filter(Boolean),
      reason: "previous final answer lacked required evidence",
      text: [
        "Do not repeat unsupported claims from these prior turns without gathering the missing evidence first.",
        ...gaps,
      ].join("\n\n"),
    });
  }

  if ((turnPolicy.rigor === "grounded" || turnPolicy.rigor === "coverage" || coldStart) && (project?.name || project?.path)) {
    items.push({
      id: "project_identity",
      kind: "project_identity",
      priority: 30,
      trust: "workspace_metadata",
      proof: false,
      sourceVersion: project?.path || "",
      reason: "workspace identity",
      text: [
        project?.name ? `Workspace: ${compactText(project.name, 120)}` : "",
        project?.path ? `Workspace path: ${compactText(project.path, 300)}` : "",
      ].filter(Boolean).join("\n"),
    });
  }
  if ((turnPolicy.rigor === "grounded" || turnPolicy.rigor === "coverage" || coldStart) && projectMemory?.text) {
    items.push({
      id: "project_memory_index",
      kind: "project_memory",
      priority: 50,
      trust: "workspace_memory",
      proof: false,
      sourceVersion: [
        projectMemory.filePath || "",
        projectMemory.mtimeMs || "",
        projectMemory.bytes || "",
        projectMemory.truncated ? "truncated" : "full",
      ].join(":"),
      sourcePointers: projectMemory.filePath ? [{ type: "file", filePath: projectMemory.filePath }] : [],
      reason: "curated workspace memory index",
      text: [
        projectMemory.filePath ? `Source: ${compactText(projectMemory.filePath, 300)}` : "",
        projectMemory.truncated ? "Note: project memory index was truncated to fit the budget." : "",
        compactText(projectMemory.text, 1_200),
      ].filter(Boolean).join("\n"),
    });
  }
  if ((turnPolicy.rigor === "grounded" || turnPolicy.rigor === "coverage" || coldStart) && String(workspaceDigest || "").trim()) {
    items.push({
      id: "workspace_digest",
      kind: "workspace_digest",
      priority: 40,
      trust: "workspace_metadata",
      proof: false,
      sourceVersion: stableHash(String(workspaceDigest || "")),
      sourcePointers: project?.path ? [{ type: "directory", filePath: project.path }] : [],
      reason: "bounded workspace structure digest",
      text: compactText(workspaceDigest, 900),
    });
  }
  if ((turnPolicy.rigor === "grounded" || turnPolicy.rigor === "coverage" || coldStart) && String(learnedConventions || "").trim()) {
    items.push({
      id: "learned_conventions",
      kind: "learned_conventions",
      priority: 60,
      trust: "user_learned_memory",
      proof: false,
      sourceVersion: stableHash(String(learnedConventions || "")),
      sourcePointers: project?.id ? [{ type: "learned_conventions", projectId: project.id }] : [],
      reason: "explicitly remembered user/project conventions",
      text: [
        "Explicit learned conventions. Treat as user preference/context, not as proof of external facts.",
        compactText(learnedConventions, 1_200),
      ].join("\n"),
    });
  }
  return items;
}

function formatMemoryContext(items = []) {
  if (!items.length) return "";
  const lines = [
    "[Lily Memory Context]",
    "Use this memory only for continuity and retrieval hints. It is not proof; verify strong claims with tools/evidence.",
  ];
  for (const item of items) {
    lines.push("", `## ${item.kind || item.id}`, `Reason: ${item.reason || "context"}`, String(item.text || "").trim());
  }
  lines.push("", "[End Lily Memory Context]");
  return lines.join("\n");
}

function memoryFingerprint(items = []) {
  const payload = (Array.isArray(items) ? items : []).map((item) => ({
    id: item.id || "",
    kind: item.kind || "",
    trust: item.trust || "",
    reason: item.reason || "",
    sourceVersion: item.sourceVersion || "",
    text: String(item.text || ""),
  }));
  if (!payload.length) return "";
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildContextMemory(input = {}) {
  const disabledKinds = new Set(Array.isArray(input.disabledKinds) ? input.disabledKinds.map(String) : []);
  const items = buildMemoryItems(input).filter((item) => !disabledKinds.has(item.kind));
  const query = input.userText || input.query || "";
  const projectKey = input.project?.id || input.project?.path || "";
  // input.semanticMap (optional, from buildContextMemoryAsync) carries REAL-embedding
  // relevance. Absent → rankMemoryItemsWithDiagnostics uses the lexical hash rank,
  // exactly as before. This sync path is 100% unchanged for every existing caller.
  const semanticMap = input.semanticMap instanceof Map ? input.semanticMap : null;
  // Reinforcement (④, OPT-IN LILY_MEMORY_REINFORCE=1): load bounded usage boosts
  // for the candidate items so useful memories rank a little higher. Fail-open →
  // no boosts → identical to the plain rank.
  let reinforcement = null;
  if (process.env.LILY_MEMORY_REINFORCE === "1") {
    try {
      const { reinforcementBoosts } = require("./memory-reinforcement");
      reinforcement = reinforcementBoosts(items.map(reinforcementKey), projectKey, Date.now());
    } catch {
      reinforcement = null;
    }
  }
  const ranked = rankMemoryItemsWithDiagnostics(items, query, { projectKey, semanticMap, reinforcement });
  const rawItems = ranked.items;
  const maxChars = resolveMemoryMaxChars(rawItems, input);
  const selection = selectMemoryItemsWithDiagnostics(rawItems, { maxChars });
  const selected = selection.selected;
  // Record which memories were actually USED (selected) this turn — the positive
  // reinforcement signal. Deferred off the turn path (fire-and-forget) so the
  // sync disk write never adds latency; fail-open, best-effort.
  if (reinforcement && selected.length) {
    const usedKeys = selected.map(reinforcementKey);
    setImmediate(() => {
      try {
        require("./memory-reinforcement").recordUsage(projectKey, usedKeys, Date.now());
      } catch { /* best-effort */ }
    });
  }
  return {
    items: selected,
    skipped: selection.skipped,
    diagnostics: {
      ...selection.diagnostics,
      ...(ranked.diagnostics || {}),
    },
    text: formatMemoryContext(selected),
    fingerprint: memoryFingerprint(selected),
    totalChars: selection.diagnostics.usedChars,
  };
}

// Async front door for callers that want REAL-embedding recall when it is
// configured (LILY_EMBEDDING_*). It computes the semantic map, then hands off to
// the sync buildContextMemory. FAIL-OPEN + OPT-IN: no caller configured, or any
// embed failure → semanticMap stays null → identical to the plain sync path.
async function buildContextMemoryAsync(input = {}) {
  let semanticMap = null;
  try {
    let caller = null;
    let model = "injected";
    if (typeof input.embeddingCaller === "function") {
      caller = input.embeddingCaller;
      model = input.embeddingModel || "injected";
    } else {
      const config = resolveEmbeddingConfig();
      if (config) {
        caller = makeEmbeddingCaller(config);
        model = config.model;
      }
    }
    if (caller) {
      const disabledKinds = new Set(Array.isArray(input.disabledKinds) ? input.disabledKinds.map(String) : []);
      const items = buildMemoryItems(input).filter((item) => !disabledKinds.has(item.kind));
      semanticMap = await semanticRelevanceMap(items, input.userText || input.query || "", {
        caller,
        projectKey: input.project?.id || input.project?.path || "",
        model,
      });
    }
  } catch {
    semanticMap = null;
  }
  return buildContextMemory(semanticMap ? { ...input, semanticMap } : input);
}

module.exports = {
  DEFAULT_MAX_CHARS,
  buildContextMemory,
  buildContextMemoryAsync,
  buildMemoryItems,
  formatMemoryContext,
  memoryFingerprint,
  memoryRelevanceScore,
  rankMemoryItems,
  rankMemoryItemsWithDiagnostics,
  reinforcementKey,
  resolveMemoryMaxChars,
  selectMemoryItems,
  selectMemoryItemsWithDiagnostics,
};
