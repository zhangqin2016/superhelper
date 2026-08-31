"use strict";
const { removeTeamDirectory, pruneDirectoryProfiles } = require("./directory-projection");
const { retireScopeTransfers } = require("./transfer-retirement");

function revoked() { return Object.assign(new Error("Collaboration access revoked"), { code: "COLLAB_ACCESS_REVOKED" }); }
function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value; }

function isConversationRevoked(store, conversationId) {
  return Boolean(store.db?.get(`SELECT 1 FROM revoked_conversations WHERE account_id = ? AND conversation_id = ?`, store.accountId, conversationId));
}
function assertScopeWritable(store, scopeId) {
  if (store.db.get(`SELECT 1 FROM revoked_scopes WHERE account_id = ? AND scope_id = ?`, store.accountId, scopeId)) throw revoked();
}

/** All row deletion and its tombstone are part of the caller's SQLite transaction. */
function removeConversationRows(store, conversationId, scopeId = null) {
  store.db.run(`INSERT OR IGNORE INTO revoked_conversations (account_id, conversation_id, scope_id) VALUES (?, ?, ?)`, store.accountId, conversationId, scopeId);
  let deletedOutbox = 0;
  for (const table of ["conversation_members", "messages", "drafts", "outbox", "events", "history_hydration", "history_hydration_targets", "conversation_hydration", "social_commands"]) {
    const result = store.db.run(`DELETE FROM ${table} WHERE account_id = ? AND conversation_id = ?`, store.accountId, conversationId);
    if (table === "outbox") deletedOutbox = Number(result.changes);
  }
  store.db.run(`DELETE FROM conversations WHERE account_id = ? AND id = ?`, store.accountId, conversationId);
  return { deletedOutbox };
}

function removeScopeRows(store, scopeId) {
  removeTeamDirectory(store, scopeId);
  // Include orphaned pending records, not only conversations in the last bootstrap.
  const ids = store.db.all(`SELECT id AS conversation_id FROM conversations WHERE account_id = ? AND scope_id = ?
    UNION SELECT conversation_id FROM messages WHERE account_id = ? AND scope_id = ?
    UNION SELECT conversation_id FROM outbox WHERE account_id = ? AND scope_id = ?
    UNION SELECT conversation_id FROM drafts WHERE account_id = ? AND scope_id = ?`,
  store.accountId, scopeId, store.accountId, scopeId, store.accountId, scopeId, store.accountId, scopeId);
  let deletedOutbox = 0;
  for (const row of ids) deletedOutbox += removeConversationRows(store, row.conversation_id, scopeId).deletedOutbox;
  pruneDirectoryProfiles(store);
  for (const table of ["transfers", "share_mappings", "social_commands"]) store.db.run(`DELETE FROM ${table} WHERE account_id = ? AND scope_id = ?`, store.accountId, scopeId);
  store.db.run(`INSERT INTO revoked_scopes (account_id, scope_id, key_delete_pending) VALUES (?, ?, 1)
    ON CONFLICT(account_id, scope_id) DO UPDATE SET key_delete_pending = 1`, store.accountId, scopeId);
  return { deletedOutbox };
}

/** Filesystem work happens only after SQL commit; its durable intent survives a crash. */
function flushRevokedKeys(store) {
  for (const row of store.db.all(`SELECT scope_id FROM revoked_scopes WHERE account_id = ? AND key_delete_pending = 1`, store.accountId)) {
    // This must finish before key destruction.  An authenticated Team
    // transfer is then durably fenced even if a later bootstrap re-enables
    // the organization and creates a new scope key.
    retireScopeTransfers({ rootPath: store.transferRoot, accountId: store.accountId, keyring: store.keyring, scopeId: row.scope_id });
    store.keyring.destroyScopeKey({ accountId: store.accountId, scopeId: row.scope_id });
    store.db.run(`UPDATE revoked_scopes SET key_delete_pending = 0 WHERE account_id = ? AND scope_id = ?`, store.accountId, row.scope_id);
  }
}
function revokeScope(store, scopeId) {
  const result = store.db.transaction(() => removeScopeRows(store, scopeId))();
  flushRevokedKeys(store);
  return result;
}

function projectAccessRevocation(store, event) {
  if (event.type === "scope.revoked") {
    const payload = event.payload || {};
    if (payload.scopeType !== "organization" || !validId(payload.organizationId) || !validId(payload.userId)) throw revoked();
    if (payload.userId === store.accountId) removeScopeRows(store, `team:${payload.organizationId}`);
  } else if (["member.removed", "member.left"].includes(event.type) && event.payload?.userId === store.accountId) {
    const id = event.conversationId ?? event.conversation_id;
    if (!validId(id)) throw revoked();
    removeConversationRows(store, id, store.getConversation({ conversationId: id })?.scopeId);
  }
}

function pruneRevokedHistory(store) {
  for (const table of ["events", "history_hydration", "history_hydration_targets"]) store.db.run(`DELETE FROM ${table}
    WHERE account_id = ? AND conversation_id IN (SELECT conversation_id FROM revoked_conversations WHERE account_id = ?)
    AND conversation_id NOT IN (SELECT conversation_id FROM conversation_hydration WHERE account_id = ?)`, store.accountId, store.accountId, store.accountId);
}

/** Use only the server's current authorization errors, never connectivity failures. */
function recoverAccessDenial(store, conversationId, error) {
  const conversation = store.getConversation?.({ conversationId });
  if (!store.db) return false;
  if (error?.code === "COLLAB_ORGANIZATION_ACCESS_REVOKED" && conversation?.scopeId.startsWith("team:")) {
    revokeScope(store, conversation.scopeId);
    return true;
  }
  if (["COLLAB_MEMBERSHIP_INACTIVE", "COLLAB_CONVERSATION_UNAVAILABLE", "COLLAB_ORGANIZATION_ACCESS_REVOKED"].includes(error?.code)) {
    store.db.transaction(() => removeConversationRows(store, conversationId, conversation?.scopeId))();
    return true;
  }
  return false;
}

/** A full server snapshot regrants only its listed scopes/conversations. */
function visibleBootstrapConversations(conversations, teams, scopeFor) {
  if (!Array.isArray(conversations) || conversations.some((row) => !row || !validId(row.id))
      || new Set(conversations.map((row) => row.id)).size !== conversations.length
      || teams !== undefined && (!Array.isArray(teams) || teams.some((row) => !row || !validId(row.id) || !["active", "disabled"].includes(row.status)))) {
    throw Object.assign(new Error("Collaboration bootstrap is invalid"), { code: "COLLAB_BOOTSTRAP_INVALID" });
  }
  const allowed = Array.isArray(teams) ? new Set(teams.filter((team) => team.status === "active").map((team) => `team:${team.id}`)) : null;
  return conversations.filter((row) => !allowed || !scopeFor(row).startsWith("team:") || allowed.has(scopeFor(row)));
}
function prepareBootstrapAccess(store, conversations, teams, scopeFor) {
  const visibleIds = new Set(conversations.map((row) => row.id));
  const visibleScopes = new Set(conversations.map(scopeFor));
  if (Array.isArray(teams)) {
    const allowed = new Set(teams.filter((team) => team.status === "active").map((team) => `team:${team.id}`));
    if ([...visibleScopes].some((scope) => scope.startsWith("team:") && !allowed.has(scope))) throw revoked();
    const oldScopes = store.db.all(`SELECT scope_id FROM conversations WHERE account_id = ? UNION SELECT scope_id FROM outbox WHERE account_id = ?
      UNION SELECT scope_id FROM drafts WHERE account_id = ? UNION SELECT scope_id FROM transfers WHERE account_id = ? UNION SELECT scope_id FROM share_mappings WHERE account_id = ?
      UNION SELECT scope_id FROM revoked_conversations WHERE account_id = ? UNION SELECT scope_id FROM directory_teams WHERE account_id = ?
      UNION SELECT scope_id FROM social_commands WHERE account_id = ?`,
    store.accountId, store.accountId, store.accountId, store.accountId, store.accountId, store.accountId, store.accountId, store.accountId);
    for (const { scope_id: scopeId } of oldScopes) if (scopeId?.startsWith("team:") && !allowed.has(scopeId)) removeScopeRows(store, scopeId);
    for (const scopeId of allowed) visibleScopes.add(scopeId);
  }
  for (const row of store.db.all(`SELECT id, scope_id FROM conversations WHERE account_id = ?`, store.accountId)) {
    if (!visibleIds.has(row.id)) removeConversationRows(store, row.id, row.scope_id);
  }
  for (const scopeId of visibleScopes) store.db.run(`DELETE FROM revoked_scopes WHERE account_id = ? AND scope_id = ?`, store.accountId, scopeId);
  for (const id of visibleIds) store.db.run(`DELETE FROM revoked_conversations WHERE account_id = ? AND conversation_id = ?`, store.accountId, id);
}

module.exports = { assertScopeWritable, isConversationRevoked, removeScopeRows, removeConversationRows, flushRevokedKeys, revokeScope, projectAccessRevocation, pruneRevokedHistory, recoverAccessDenial, prepareBootstrapAccess, visibleBootstrapConversations };
