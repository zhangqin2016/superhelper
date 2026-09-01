"use strict";
const { createHash } = require("node:crypto");
const { isConversationRevoked } = require("./access-revocation");
const { normalizeMentionCandidates } = require("./mention-candidates");
const stale = () => Object.assign(new Error("Collaboration conversation authorization changed"), { code: "COLLAB_CONVERSATION_STALE" });

/** Only authority/directory fields enter this signature. Draft, message and read
 * writes must not starve a candidate request while the user is typing. The
 * directory contract itself caps each collection at 10000 rows. */
function authorityStamp(store, conversationId) {
  if (!store.db) return JSON.stringify([store.accountId, store.getSyncState?.().cursor]);
  const accountId = store.accountId, db = store.db;
  const conversation = db.get(`SELECT scope_id,history_generation FROM conversations WHERE account_id=? AND id=?`, accountId, conversationId);
  const scope = conversation?.scope_id ?? null;
  const teamId = scope?.startsWith("team:") ? scope.slice(5) : null;
  const teams = db.all(`SELECT id,scope_id,name,role FROM directory_teams WHERE account_id=? AND (? IS NULL OR scope_id=?) ORDER BY id`, accountId, scope, scope);
  const teamMembers = db.all(`SELECT team_id,user_id,role,lily_id,display_name,avatar_object_id FROM directory_team_members
    WHERE account_id=? AND (? IS NULL OR team_id=?) ORDER BY team_id,user_id`, accountId, scope, teamId);
  const members = db.all(`SELECT user_id,status,role,joined_seq FROM conversation_members WHERE account_id=? AND conversation_id=? ORDER BY user_id`, accountId, conversationId);
  const relevantIds = new Set([accountId, ...members.map((m) => m.user_id), ...teamMembers.map((m) => m.user_id)]);
  const ids = JSON.stringify([...relevantIds]);
  const profiles = db.all(`SELECT user_id,lily_id,display_name,avatar_object_id FROM profiles WHERE account_id=? AND user_id IN (SELECT value FROM json_each(?)) ORDER BY user_id`, accountId, ids);
  const contacts = db.all(`SELECT user_id,relationship,request_id,own_blocked FROM directory_contacts WHERE account_id=? AND user_id IN (SELECT value FROM json_each(?)) ORDER BY user_id`, accountId, ids);
  const pending = db.get(`SELECT generation FROM conversation_hydration WHERE account_id=? AND conversation_id=?`, accountId, conversationId);
  const revoked = db.get(`SELECT scope_id FROM revoked_conversations WHERE account_id=? AND conversation_id=?`, accountId, conversationId);
  const scopes = db.all(`SELECT scope_id FROM revoked_scopes WHERE account_id=? AND (? IS NULL OR scope_id=?) ORDER BY scope_id`, accountId, scope, scope);
  return createHash("sha256").update(JSON.stringify([accountId, store.getSyncState().cursor, conversation, pending, revoked, scopes, teams, teamMembers, members, profiles, contacts])).digest("hex");
}

function createMentionCandidateCache({ store, now = Date.now }) {
  const entries = new Map();
  let epoch = 0;
  let accountId = store.accountId;
  const clear = () => { entries.clear(); epoch++; };
  const ensureAccount = () => { if (accountId !== store.accountId) { clear(); accountId = store.accountId; } };
  const stamp = (conversationId) => { ensureAccount(); return `${epoch}:${authorityStamp(store, conversationId)}`; };
  const assertReadable = (conversationId) => {
    const scopeId = store.getConversation?.({ conversationId })?.scopeId;
    if (isConversationRevoked(store, conversationId) || scopeId && store.db?.get(`SELECT 1 FROM revoked_scopes WHERE account_id=? AND scope_id=?`, store.accountId, scopeId)) {
      entries.delete(conversationId);
      throw Object.assign(new Error("Collaboration access revoked"), { code: "COLLAB_ACCESS_REVOKED" });
    }
  };
  return {
    clear,
    discard(conversationId) { entries.delete(conversationId); },
    capture(conversationId) {
      const expected = stamp(conversationId);
      return () => { if (stamp(conversationId) !== expected) throw stale(); };
    },
    get(conversationId) {
      ensureAccount();
      assertReadable(conversationId);
      const entry = entries.get(conversationId);
      if (!entry) return null;
      if (entry.stamp !== stamp(conversationId) || now() >= entry.expiresAt) { entries.delete(conversationId); return null; }
      entries.delete(conversationId); entries.set(conversationId, entry);
      return structuredClone(entry.value);
    },
    put(conversationId, value) {
      ensureAccount();
      const normalized = normalizeMentionCandidates(value, { allowUnknown: true });
      if (normalized.status !== "complete") { entries.delete(conversationId); return; }
      assertReadable(conversationId);
      entries.delete(conversationId);
      entries.set(conversationId, { value: normalized, stamp: stamp(conversationId), expiresAt: now() + 30000 });
      while (entries.size > 32) entries.delete(entries.keys().next().value);
    },
  };
}
module.exports = { createMentionCandidateCache };
