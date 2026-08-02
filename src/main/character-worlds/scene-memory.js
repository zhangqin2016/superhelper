"use strict";

/**
 * Scene memory (design spec §11, Phase 3 P3-1).
 *
 * Durable, provenance-bearing episodic memory keyed by
 * (conversation id, character revision id). Items are immutable: an update
 * APPENDS a superseding item (supersedesId) and never rewrites history.
 * Narrative memory NEVER becomes a Lily task fact: it is injected only as a
 * separate, lower-authority `authority: "narrative"` section of the character
 * context. Extraction advances ONLY after a successful finalized turn; failed,
 * cancelled, rewound, or interrupted turns never advance it.
 *
 * Default injection is deterministic (bounded lexical/recency selection, no
 * second model request). Semantic retrieval is an opt-in reuse of the shared
 * memory-vector-index (already time-bounded) — see buildSceneMemoryIndex.
 */

const crypto = require("node:crypto");

const MAX_SCENE_MEMORY_BYTES = 4 * 1024;
const MAX_ITEMS_PER_SCOPE = 64;
const MEMORY_KINDS = new Set(["scene_fact", "character_belief", "relationship", "open_thread"]);
const CONFIDENCE_KINDS = new Set(["explicit", "derived"]);

function newMemoryId() {
  return crypto.randomUUID();
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS character_memory (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      character_revision_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      source_turn_ids TEXT NOT NULL,
      confidence TEXT NOT NULL,
      supersedes_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_character_memory_scope
      ON character_memory (session_id, character_revision_id, created_at);
  `);
}

function appendMemory(db, { sessionId, characterRevisionId, kind, text, sourceTurnIds = [], confidence = "explicit", supersedesId = null, createdAt = new Date().toISOString() }) {
  ensureSchema(db);
  if (typeof sessionId !== "string" || !sessionId) throw new TypeError("sessionId required");
  if (typeof characterRevisionId !== "string" || !characterRevisionId) throw new TypeError("characterRevisionId required");
  if (!MEMORY_KINDS.has(kind)) throw new TypeError(`unknown memory kind: ${kind}`);
  if (typeof text !== "string" || !text.trim()) throw new TypeError("text required");
  if (!CONFIDENCE_KINDS.has(confidence)) throw new TypeError(`unknown confidence: ${confidence}`);
  const id = newMemoryId();
  db.run(
    `INSERT INTO character_memory
       (id, session_id, character_revision_id, kind, text, source_turn_ids, confidence, supersedes_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, sessionId, characterRevisionId, kind, text, JSON.stringify(sourceTurnIds), confidence, supersedesId, createdAt,
  );
  return { id, kind, text, characterRevisionId };
}

function memoryFromRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    sourceTurnIds: (() => { try { const v = JSON.parse(row.source_turn_ids); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    confidence: row.confidence,
    supersedesId: row.supersedes_id || null,
    createdAt: row.created_at,
  };
}

function listMemory(db, sessionId, characterRevisionId) {
  ensureSchema(db);
  const rows = db.all(
    `SELECT * FROM character_memory
     WHERE session_id = ? AND character_revision_id = ?
     ORDER BY created_at ASC, id ASC`,
    sessionId, characterRevisionId,
  );
  return rows.map(memoryFromRow);
}

/** Items not superseded by a later item in the same scope (active set). */
function activeMemory(db, sessionId, characterRevisionId) {
  const items = listMemory(db, sessionId, characterRevisionId);
  const superseded = new Set(items.filter((m) => m.supersedesId).map((m) => m.supersedesId));
  return items.filter((m) => !superseded.has(m.id)).slice(-MAX_ITEMS_PER_SCOPE);
}

/**
 * Turn-outcome gate (§11): memory advances only after a successful finalized
 * turn. "completed" appends a canonical bounded record (the default recent
 * canonical history, no model request); every other outcome is a no-op.
 */
function recordTurnOutcome(db, { sessionId, characterRevisionId, outcome, turnId = "", text = "" }) {
  if (outcome === "completed") {
    const label = text.trim() || `finalized-only ${turnId || "turn"}`;
    return appendMemory(db, {
      sessionId,
      characterRevisionId,
      kind: "scene_fact",
      text: String(label).slice(0, 512),
      sourceTurnIds: turnId ? [turnId] : [],
      confidence: "derived",
    });
  }
  return null;
}

/**
 * Build the bounded, lower-authority narrative memory section for character
 * context injection. Returns { authority: "narrative", text } — never a Lily
 * task-fact surface. The text is capped so a hostile memory store can only
 * fill the budget, never break the compile.
 */
function sceneMemorySection(items = []) {
  const parts = [];
  let budget = MAX_SCENE_MEMORY_BYTES;
  for (const item of items) {
    if (budget <= 0) break;
    const line = `- [${item.kind}] ${String(item.text || "").trim()}`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    // +1 reserves the join separator so the FINAL text never exceeds budget.
    if (lineBytes + 1 > budget) break;
    parts.push(line);
    budget -= lineBytes + 1;
  }
  return {
    authority: "narrative",
    text: parts.length ? parts.join("\n") : "",
  };
}

/**
 * Finalizer hook (§11): advance scene memory ONLY on a proven successful
 * terminal with a bound character. Fail-open — a memory error never breaks
 * the finalized turn.
 */
function advanceMemoryOnCompleted(ctx, sessionId, state, completedTurnId) {
  const snap = state?.characterWorldsRuntimeSnapshot;
  if (snap?.mode !== "character" || !snap.characterRevisionId || !snap.ownerScope) return;
  if (ctx?.characterWorldsRuntime?.finalizeTurn) {
    ctx.characterWorldsRuntime.finalizeTurn(snap, {
      store: ctx.sessionManager?._store?.() || null,
      sessionId,
      completedTurnId,
      assistantText: state.assistantText,
    });
    return;
  }
  const store = ctx?.sessionManager?._store?.() || null;
  if (!store?.db) return;
  const { CharacterSceneMemoryService } = require("./scene-memory-service");
  const service = new CharacterSceneMemoryService({ store, ownerScope: snap.ownerScope });
  const turnId = completedTurnId || state.turnId || "";
  const text = typeof state?.assistantText === "string" ? state.assistantText.trim() : "";
  service.appendTurnMemory({
    sessionId,
    characterRevisionId: snap.characterRevisionId,
    turnId,
    finalized: true,
    items: text
      ? [{ kind: "scene_fact", text: text.slice(0, 512), sourceTurnIds: [turnId], confidence: "derived" }]
      : [],
  });
}

module.exports = {
  MAX_SCENE_MEMORY_BYTES,
  MAX_ITEMS_PER_SCOPE,
  activeMemory,
  advanceMemoryOnCompleted,
  appendMemory,
  extractSceneFacts,
  listMemory,
  recordTurnOutcome,
  sceneMemorySection,
};


/**
 * §11 opt-in model-assisted fact extraction (Phase 3): the caller MAY inject
 * an `extractor(turnText, context) -> [{ kind, text, confidence }]`. Without
 * one this returns [] and the default bounded-recent behavior stands — no
 * extra model request on the normal turn path.
 */
async function extractSceneFacts(turnText, { extractor, context } = {}) {
  if (typeof extractor !== "function" || !turnText) return [];
  const items = await extractor(turnText, context || {});
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item.kind === "string" && typeof item.text === "string");
}
