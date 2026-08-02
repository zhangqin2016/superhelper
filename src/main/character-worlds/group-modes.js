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
      allow_multiple_speakers INTEGER NOT NULL DEFAULT 1,
      allow_self_responses INTEGER NOT NULL DEFAULT 0,
      muted_character_revision_ids TEXT NOT NULL,
      last_speaker_revision_ids TEXT NOT NULL DEFAULT '[]',
      active_greeting_index_by_revision_id TEXT NOT NULL DEFAULT '{}',
      scenario_override TEXT NOT NULL DEFAULT '',
      scene_state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_scenes_owner
      ON group_scenes (owner_scope, session_id);
    CREATE TABLE IF NOT EXISTS group_response_variants (
      id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL DEFAULT 'device:local',
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      text TEXT NOT NULL,
      binding_snapshot_json TEXT NOT NULL DEFAULT '{}',
      side_effecting INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  const columns = (table) => new Set(db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
  const sceneColumns = columns("group_scenes");
  for (const [name, definition] of [
    ["allow_multiple_speakers", "INTEGER NOT NULL DEFAULT 1"],
    ["allow_self_responses", "INTEGER NOT NULL DEFAULT 0"],
    ["last_speaker_revision_ids", "TEXT NOT NULL DEFAULT '[]'"],
    ["active_greeting_index_by_revision_id", "TEXT NOT NULL DEFAULT '{}'"],
    ["scenario_override", "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!sceneColumns.has(name)) db.exec(`ALTER TABLE group_scenes ADD COLUMN ${name} ${definition}`);
  }
  const variantColumns = columns("group_response_variants");
  for (const [name, definition] of [
    ["owner_scope", "TEXT NOT NULL DEFAULT 'device:local'"],
    ["binding_snapshot_json", "TEXT NOT NULL DEFAULT '{}'"],
    ["side_effecting", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    if (!variantColumns.has(name)) db.exec(`ALTER TABLE group_response_variants ADD COLUMN ${name} ${definition}`);
  }
}

function createScene(repo, {
  ownerScope, sessionId, name, participantCharacterRevisionIds = [], replyStrategy = "natural",
  promptMode = "swap", allowMultipleSpeakers = true, allowSelfResponses = false,
  mutedCharacterRevisionIds = [], scenarioOverride = "", sceneState = {},
}) {
  if (!REPLY_STRATEGIES.has(replyStrategy)) throw new TypeError(`unknown reply strategy: ${replyStrategy}`);
  if (typeof ownerScope !== "string" || !ownerScope || typeof sessionId !== "string" || !sessionId) throw new TypeError("scene_identity_required");
  const participants = [...new Set(participantCharacterRevisionIds.filter((id) => typeof id === "string" && id))];
  for (const revisionId of participants) {
    if (typeof repo.getRevision !== "function" || !repo.getRevision(ownerScope, revisionId)) throw new TypeError("scene_participant_invalid");
  }
  const muted = [...new Set(mutedCharacterRevisionIds.filter((id) => participants.includes(id)))];
  const id = crypto.randomUUID();
  const db = repo.db;
  ensureSchema(db);
  db.run(
    `INSERT INTO group_scenes
       (id, owner_scope, session_id, participant_character_revision_ids, active_speaker_revision_id,
        reply_strategy, prompt_mode, allow_multiple_speakers, allow_self_responses,
        muted_character_revision_ids, last_speaker_revision_ids,
        active_greeting_index_by_revision_id, scenario_override, scene_state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ownerScope, sessionId, JSON.stringify(participants), null, replyStrategy, promptMode,
    allowMultipleSpeakers ? 1 : 0, allowSelfResponses ? 1 : 0, JSON.stringify(muted),
    JSON.stringify([]), JSON.stringify({}), String(scenarioOverride || "").slice(0, 4096),
    JSON.stringify(sceneState && typeof sceneState === "object" ? sceneState : {}), new Date().toISOString(),
  );
  return {
    id,
    characterRevisionId: participantCharacterRevisionIds[0] || null,
    participantCharacterRevisionIds: participants,
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
    allowMultipleSpeakers: Boolean(row.allow_multiple_speakers),
    allowSelfResponses: Boolean(row.allow_self_responses),
    mutedCharacterRevisionIds: JSON.parse(row.muted_character_revision_ids || "[]"),
    lastSpeakerRevisionIds: JSON.parse(row.last_speaker_revision_ids || "[]"),
    activeGreetingIndexByRevisionId: JSON.parse(row.active_greeting_index_by_revision_id || "{}"),
    scenarioOverride: row.scenario_override || "",
    sceneState: JSON.parse(row.scene_state || "{}"),
  };
}

function upsertScene(repo, {
  ownerScope, sessionId, participantCharacterRevisionIds = null,
  replyStrategy = "manual", promptMode = "swap", activeSpeakerRevisionId = null,
  allowMultipleSpeakers = true, allowSelfResponses = false,
  mutedCharacterRevisionIds = [], scenarioOverride = "", sceneState = {},
} = {}) {
  if (typeof ownerScope !== "string" || !ownerScope || typeof sessionId !== "string" || !sessionId) {
    throw new TypeError("scene_identity_required");
  }
  if (!REPLY_STRATEGIES.has(replyStrategy)) throw new TypeError(`unknown reply strategy: ${replyStrategy}`);
  ensureSchema(repo.db);
  const existing = getScene(repo, ownerScope, sessionId);
  if (!existing) {
    return createScene(repo, {
      ownerScope, sessionId, participantCharacterRevisionIds: participantCharacterRevisionIds || [],
      replyStrategy, promptMode, allowMultipleSpeakers, allowSelfResponses,
      mutedCharacterRevisionIds, scenarioOverride, sceneState,
    });
  }
  const participants = participantCharacterRevisionIds == null
    ? existing.participantCharacterRevisionIds
    : [...new Set(participantCharacterRevisionIds.filter((id) => typeof id === "string" && id))];
  if (JSON.stringify(participants) !== JSON.stringify(existing.participantCharacterRevisionIds)) {
    throw new TypeError("scene_participants_immutable");
  }
  if (activeSpeakerRevisionId && !participants.includes(activeSpeakerRevisionId)) {
    throw new TypeError("scene_active_speaker_invalid");
  }
  const muted = [...new Set((Array.isArray(mutedCharacterRevisionIds) ? mutedCharacterRevisionIds : existing.mutedCharacterRevisionIds)
    .filter((id) => participants.includes(id)))];
  repo.db.run(
    `UPDATE group_scenes SET active_speaker_revision_id = ?, reply_strategy = ?, prompt_mode = ?,
       allow_multiple_speakers = ?, allow_self_responses = ?, muted_character_revision_ids = ?,
       scenario_override = ?, scene_state = ?, updated_at = ?
     WHERE id = ? AND owner_scope = ? AND session_id = ?`,
    activeSpeakerRevisionId || existing.activeSpeakerRevisionId || null, replyStrategy, promptMode,
    allowMultipleSpeakers ? 1 : 0, allowSelfResponses ? 1 : 0, JSON.stringify(muted),
    String(scenarioOverride || existing.scenarioOverride || "").slice(0, 4096),
    JSON.stringify(sceneState && typeof sceneState === "object" ? sceneState : existing.sceneState || {}),
    new Date().toISOString(), existing.id, ownerScope, sessionId,
  );
  return getScene(repo, ownerScope, sessionId);
}

/** Deterministic speaker pick (host planner). Never touches tool authority. */
function wholeWordMention(text, name) {
  const value = String(name || "").normalize("NFC").trim();
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = "[\\p{L}\\p{N}_]";
  try {
    return new RegExp(`(?<!${word})${escaped}(?!${word})`, "iu").test(String(text || ""));
  } catch {
    return String(text || "").toLocaleLowerCase().includes(value.toLocaleLowerCase());
  }
}

function deterministicFraction(seed) {
  const value = crypto.createHash("sha256").update(String(seed), "utf8").digest().readUInt32BE(0);
  return value / 0x100000000;
}

function pickSpeaker({ scene, strategy = "list_order", requestedSpeakerRevisionIds = [], latestCanonicalText = "", spokenSinceUser = [], roster = [], seedIdentity = "" }) {
  const participants = Array.isArray(scene?.participantCharacterRevisionIds) ? scene.participantCharacterRevisionIds : [];
  const muted = new Set(scene?.mutedCharacterRevisionIds || []);
  const known = new Map((Array.isArray(roster) ? roster : []).map((item) => [item?.id, item]));
  const eligible = participants.filter((id) => typeof id === "string" && !muted.has(id) && (!roster.length || known.has(id)));
  if (!eligible.length) return { characterRevisionId: null, strategy: "empty" };
  const s = strategy || scene?.replyStrategy || "list_order";
  if (s === "manual") {
    const wanted = requestedSpeakerRevisionIds.find((id) => eligible.includes(id));
    return wanted
      ? { characterRevisionId: wanted, strategy: "manual" }
      : { characterRevisionId: eligible[0], strategy: "manual_fallback" };
  }
  if (s === "natural") {
    const mentioned = eligible.find((id) => wholeWordMention(latestCanonicalText, known.get(id)?.name || id));
    if (mentioned && (scene.allowSelfResponses || mentioned !== scene.activeSpeakerRevisionId)) return { characterRevisionId: mentioned, strategy: "natural" };
    const talkative = eligible.filter((id) => {
      const probability = Number(known.get(id)?.talkativeness);
      return Number.isFinite(probability) && probability > 0 && deterministicFraction(`${seedIdentity}|${id}|talkativeness`) < Math.min(1, probability);
    });
    return { characterRevisionId: talkative[0] || eligible[0], strategy: talkative.length ? "natural_probability" : "natural_fallback" };
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

function createResponseVariant(repo, { ownerScope = "device:local", sessionId, turnId, variantId, text, bindingSnapshot = null, sideEffecting = false }) {
  if (!ownerScope || !sessionId || !turnId || !variantId || typeof text !== "string") throw new TypeError("variant_identity_required");
  if (sideEffecting) throw new TypeError("variant_side_effecting");
  const id = crypto.randomUUID();
  ensureSchema(repo.db);
  repo.db.run(
    `INSERT INTO group_response_variants
       (id, owner_scope, session_id, turn_id, variant_id, text, binding_snapshot_json, side_effecting, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ownerScope, sessionId, turnId, variantId, text,
    JSON.stringify(bindingSnapshot && typeof bindingSnapshot === "object" ? bindingSnapshot : {}),
    0, new Date().toISOString(),
  );
  return { id, sessionId, turnId, variantId, text };
}

function getResponseVariants(repo, ownerScope, sessionId, turnId) {
  if (turnId === undefined) {
    turnId = sessionId;
    sessionId = ownerScope;
    ownerScope = "device:local";
  }
  ensureSchema(repo.db);
  return repo.db.all(
    `SELECT * FROM group_response_variants WHERE owner_scope = ? AND session_id = ? AND turn_id = ? ORDER BY created_at ASC`,
    ownerScope, sessionId, turnId,
  ).map((row) => ({
    id: row.id,
    variantId: row.variant_id,
    text: row.text,
    bindingSnapshot: JSON.parse(row.binding_snapshot_json || "{}"),
    sideEffecting: Boolean(row.side_effecting),
  }));
}

module.exports = {
  PICKER_TOOL_AUTHORITY,
  REPLY_STRATEGIES,
  createResponseVariant,
  createScene,
  getResponseVariants,
  getScene,
  upsertScene,
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
