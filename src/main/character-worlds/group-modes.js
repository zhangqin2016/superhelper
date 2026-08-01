"use strict";

/**
 * Group/story modes (design spec §12, Phase 3 P3-2).
 *
 * A scene is immutable on participant character-revision refs and carries
 * mutable state. Speaker selection is a deterministic host planner; model
 * judgment is used only in the opt-in `semantic` strategy. Selection affects
 * EXPRESSION only — never tool authority (PICKER_TOOL_AUTHORITY = false).
 * Response variants (§12.1) are keyed by exact session+turn ids, carry the
 * same binding snapshot, and never duplicate payments/messages/file edits.
 */

const crypto = require("node:crypto");

const PICKER_TOOL_AUTHORITY = false;
const REPLY_STRATEGIES = new Set(["manual", "natural", "list_order", "pooled", "semantic"]);

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_scenes (
      id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      session_id TEXT NOT NULL,
      participant_character_revision_ids TEXT NOT NULL,
      active_speaker_revision_id TEXT,
      reply_strategy TEXT NOT NULL,
      prompt_mode TEXT NOT NULL,
      muted_character_revision_ids TEXT NOT NULL,
      scene_state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_scenes_owner
      ON group_scenes (owner_scope, session_id);
    CREATE TABLE IF NOT EXISTS group_response_variants (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function createScene(repo, { ownerScope, sessionId, name, participantCharacterRevisionIds = [], replyStrategy = "natural", promptMode = "swap" }) {
  if (!REPLY_STRATEGIES.has(replyStrategy)) throw new TypeError(`unknown reply strategy: ${replyStrategy}`);
  const id = crypto.randomUUID();
  const db = repo.db;
  ensureSchema(db);
  db.run(
    `INSERT INTO group_scenes
       (id, owner_scope, session_id, participant_character_revision_ids, active_speaker_revision_id, reply_strategy, prompt_mode, muted_character_revision_ids, scene_state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ownerScope, sessionId, JSON.stringify(participantCharacterRevisionIds), null, replyStrategy, promptMode, JSON.stringify([]), JSON.stringify({}), new Date().toISOString(),
  );
  return {
    id,
    characterRevisionId: participantCharacterRevisionIds[0] || null,
    participantCharacterRevisionIds,
    replyStrategy,
    promptMode,
    sessionId,
  };
}

function getScene(repo, ownerScope, sessionId) {
  ensureSchema(repo.db);
  const row = repo.db.get(
    `SELECT * FROM group_scenes WHERE owner_scope = ? AND session_id = ? ORDER BY updated_at DESC LIMIT 1`,
    ownerScope, sessionId,
  );
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    participantCharacterRevisionIds: JSON.parse(row.participant_character_revision_ids || "[]"),
    activeSpeakerRevisionId: row.active_speaker_revision_id || null,
    replyStrategy: row.reply_strategy,
    promptMode: row.prompt_mode,
    mutedCharacterRevisionIds: JSON.parse(row.muted_character_revision_ids || "[]"),
    sceneState: JSON.parse(row.scene_state || "{}"),
  };
}

/** Deterministic speaker pick (host planner). Never touches tool authority. */
function pickSpeaker({ scene, strategy = "list_order", requestedSpeakerRevisionIds = [], latestCanonicalText = "", spokenSinceUser = [] }) {
  const participants = Array.isArray(scene?.participantCharacterRevisionIds) ? scene.participantCharacterRevisionIds : [];
  const muted = new Set(scene?.mutedCharacterRevisionIds || []);
  const eligible = participants.filter((id) => !muted.has(id));
  if (!eligible.length) return { characterRevisionId: null, strategy: "empty" };
  const s = strategy || scene?.replyStrategy || "list_order";
  if (s === "manual") {
    const wanted = requestedSpeakerRevisionIds.find((id) => eligible.includes(id));
    return wanted
      ? { characterRevisionId: wanted, strategy: "manual" }
      : { characterRevisionId: eligible[0], strategy: "manual_fallback" };
  }
  if (s === "natural") {
    const mentioned = eligible.find((id) => latestCanonicalText.includes(id));
    if (mentioned) return { characterRevisionId: mentioned, strategy: "natural" };
    return { characterRevisionId: eligible[0], strategy: "natural_fallback" };
  }
  if (s === "pooled") {
    const spoken = new Set(spokenSinceUser || []);
    const unspoken = eligible.filter((id) => !spoken.has(id));
    return {
      characterRevisionId: unspoken.length ? unspoken[0] : eligible[0],
      strategy: unspoken.length ? "pooled" : "pooled_reset",
    };
  }
  if (s === "semantic") {
    return { characterRevisionId: eligible[0], strategy: "semantic_host_default" };
  }
  return { characterRevisionId: eligible[0], strategy: "list_order" };
}

function createResponseVariant(repo, { sessionId, turnId, variantId, text }) {
  const id = crypto.randomUUID();
  ensureSchema(repo.db);
  repo.db.run(
    `INSERT INTO group_response_variants (id, session_id, turn_id, variant_id, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, sessionId, turnId, variantId, text, new Date().toISOString(),
  );
  return { id, sessionId, turnId, variantId, text };
}

function getResponseVariants(repo, sessionId, turnId) {
  ensureSchema(repo.db);
  return repo.db.all(
    `SELECT * FROM group_response_variants WHERE session_id = ? AND turn_id = ? ORDER BY created_at ASC`,
    sessionId, turnId,
  ).map((row) => ({
    id: row.id,
    variantId: row.variant_id,
    text: row.text,
  }));
}

module.exports = {
  PICKER_TOOL_AUTHORITY,
  REPLY_STRATEGIES,
  createResponseVariant,
  createScene,
  getResponseVariants,
  getScene,
  pickSemanticSpeaker,
  pickSpeaker,
};


/**
 * §12.1 opt-in semantic speaker selection (model runtime): the caller MAY
 * inject a `ranker(eligible, context) -> ranked revision ids`. Without a
 * ranker this returns null and the host falls back to `semantic_host_default`
 * — never an extra model call on the normal turn path.
 */
async function pickSemanticSpeaker(eligible, { ranker, context } = {}) {
  if (typeof ranker !== "function" || !eligible.length) return null;
  const ranked = await ranker(eligible, context || {});
  if (!Array.isArray(ranked) || !ranked.length) return null;
  const wanted = ranked.find((id) => eligible.includes(id));
  return wanted || null;
}
