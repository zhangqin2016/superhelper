"use strict";

function invalid() { throw Object.assign(new Error("Collaboration directory is invalid"), { code: "COLLAB_DIRECTORY_INVALID" }); }
function id(value) {
  if (typeof value !== "string" || !value || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function rows(value = []) { if (!Array.isArray(value) || value.length > 10000) invalid(); return value; }
function field(value, camel, snake) { return value?.[camel] ?? value?.[snake]; }
function text(value) { if (value == null) return ""; if (typeof value !== "string" || value.length > 500) invalid(); return value; }
function profile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const avatar = field(value, "avatarObjectId", "avatar_object_id");
  return { userId: id(field(value, "userId", "user_id")), lilyId: text(field(value, "lilyId", "lily_id")),
    displayName: text(field(value, "displayName", "display_name")), avatarObjectId: avatar == null ? null : id(avatar),
    // Optional facets (older servers omit them): the enterprise login and a
    // server-masked phone. Both are display fallbacks, never identifiers.
    loginName: text(field(value, "loginName", "login_name")), phoneMasked: text(field(value, "phoneMasked", "phone_masked")) };
}
function role(value) { if (value == null) return null; if (!["owner", "admin", "member"].includes(value)) invalid(); return value; }
function pair(store, a, b) {
  id(a); id(b);
  if (a === b || ![a, b].includes(store.accountId)) invalid();
  return a === store.accountId ? b : a;
}
function saveProfile(store, value) {
  const p = profile(value);
  store.db.run(`INSERT INTO profiles(account_id,user_id,lily_id,display_name,avatar_object_id,login_name,phone_masked,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id,user_id) DO UPDATE SET lily_id=excluded.lily_id,display_name=excluded.display_name,avatar_object_id=excluded.avatar_object_id,
    login_name=excluded.login_name,phone_masked=excluded.phone_masked,updated_at=excluded.updated_at`,
  store.accountId, p.userId, p.lilyId, p.displayName, p.avatarObjectId, p.loginName || null, p.phoneMasked || null, store.now());
}
function contact(store, peer, relationship, requestId = null) {
  store.db.run(`INSERT INTO directory_contacts(account_id,user_id,relationship,request_id) VALUES(?,?,?,?)
    ON CONFLICT(account_id,user_id) DO UPDATE SET relationship=excluded.relationship,request_id=excluded.request_id`, store.accountId, peer, relationship, requestId);
}

/** The caller owns the single bootstrap transaction, including its watermark. */
function replaceDirectory(store, snapshot) {
  const complete = snapshot.directorySchemaVersion === 1;
  if (snapshot.directorySchemaVersion !== undefined && !complete) invalid();
  if (complete && ["relationships", "friendRequests", "blocks", "teams", "teamMembers"].some((key) => !Array.isArray(snapshot[key]))) invalid();
  // Legacy snapshots cannot prove pending requests or own blocks disappeared.
  // Retain their public profiles along with those relationships during rollout.
  const retained = !complete ? store.db.all(`SELECT * FROM profiles WHERE account_id=? AND (user_id=? OR user_id IN
    (SELECT user_id FROM directory_contacts WHERE account_id=?))`, store.accountId, store.accountId, store.accountId) : [];
  store.db.run(`DELETE FROM profiles WHERE account_id=?`, store.accountId);
  for (const p of retained) saveProfile(store, p);
  if (complete) store.db.run(`DELETE FROM directory_contacts WHERE account_id=?`, store.accountId);
  else if (Array.isArray(snapshot.relationships)) {
    // An explicit legacy friendship list is authoritative for friends only;
    // absent pending/block fields are not evidence that those states vanished.
    store.db.run(`UPDATE directory_contacts SET relationship=NULL,request_id=NULL WHERE account_id=? AND relationship='friend'`, store.accountId);
  }
  if (snapshot.profile && profile(snapshot.profile).userId !== store.accountId) invalid();
  for (const p of [...(snapshot.profile ? [snapshot.profile] : []), ...rows(snapshot.profiles)]) saveProfile(store, p);
  for (const request of rows(snapshot.friendRequests)) {
    const sender = field(request, "senderUserId", "sender_user_id"), receiver = field(request, "receiverUserId", "receiver_user_id");
    const peer = pair(store, sender, receiver);
    if (request.status !== "pending") invalid();
    contact(store, peer, sender === store.accountId ? "outgoing" : "incoming", id(request.id));
  }
  for (const relationship of rows(snapshot.relationships)) {
    const peer = pair(store, field(relationship, "userLowId", "user_low_id"), field(relationship, "userHighId", "user_high_id"));
    if (relationship.status !== "active") invalid();
    contact(store, peer, "friend");
  }
  for (const block of rows(snapshot.blocks)) {
    const blocker = field(block, "blockerUserId", "blocker_user_id"), blocked = field(block, "blockedUserId", "blocked_user_id");
    const peer = pair(store, blocker, blocked);
    if (blocker !== store.accountId) invalid();
    store.db.run(`INSERT INTO directory_contacts(account_id,user_id,own_blocked) VALUES(?,?,1)
      ON CONFLICT(account_id,user_id) DO UPDATE SET own_blocked=1`, store.accountId, peer);
  }
  store.db.run(`DELETE FROM directory_contacts WHERE account_id=? AND relationship IS NULL AND own_blocked=0`, store.accountId);
  if (snapshot.teams === undefined) {
    if (snapshot.teamMembers !== undefined) invalid();
    return;
  }
  store.db.run(`DELETE FROM directory_teams WHERE account_id=?`, store.accountId);
  const allowed = new Set();
  for (const team of rows(snapshot.teams)) {
    const teamId = id(team.id);
    if (!["active", "disabled"].includes(team.status) || allowed.has(teamId)) invalid();
    if (team.status !== "active") continue;
    allowed.add(teamId);
    store.db.run(`INSERT INTO directory_teams(account_id,id,scope_id,name,role) VALUES(?,?,?,?,?)`, store.accountId, teamId, `team:${teamId}`, text(team.name), role(team.role));
  }
  if (snapshot.teamMembers === undefined) return;
  store.db.run(`DELETE FROM directory_team_members WHERE account_id=?`, store.accountId);
  for (const member of rows(snapshot.teamMembers)) {
    const teamId = id(field(member, "organizationId", "organization_id"));
    if (!allowed.has(teamId)) invalid();
    const p = profile(member);
    store.db.run(`INSERT INTO directory_team_members(account_id,team_id,user_id,lily_id,display_name,avatar_object_id,login_name,phone_masked,role) VALUES(?,?,?,?,?,?,?,?,?)`,
      store.accountId, teamId, p.userId, p.lilyId, p.displayName, p.avatarObjectId, p.loginName || null, p.phoneMasked || null, role(member.role));
  }
}

/** No inference about a peer's blocking policy is ever cached or rendered. */
function projectDirectoryEvent(store, event) {
  if (!["friend.requested", "friend.accepted", "friend.declined", "friend.removed", "user.blocked", "user.unblocked"].includes(event.type)) return;
  const payload = event.payload || {};
  // Servers predating the additive participant projection require bootstrap.
  if (payload.participantUserIds === undefined) return;
  const participants = rows(payload.participantUserIds);
  if (participants.length !== 2) invalid();
  const peer = pair(store, ...participants), actor = id(event.actorUserId ?? event.actor_user_id);
  if (!participants.includes(actor)) invalid();
  const expected = { "friend.requested": "pending", "friend.accepted": "active", "friend.declined": "declined", "friend.removed": "removed", "user.blocked": "blocked", "user.unblocked": "unblocked" };
  if (payload.status !== expected[event.type]) invalid();
  if (event.type.startsWith("user.") && actor !== store.accountId) return;
  if (payload.profilesByUserId != null) {
    if (typeof payload.profilesByUserId !== "object" || Array.isArray(payload.profilesByUserId)) invalid();
    for (const [userId, p] of Object.entries(payload.profilesByUserId)) {
      if (!participants.includes(userId) || profile(p).userId !== userId) invalid();
      saveProfile(store, p);
    }
  }
  if (event.type === "friend.requested") contact(store, peer, actor === store.accountId ? "outgoing" : "incoming", id(payload.requestId));
  if (event.type === "friend.accepted") contact(store, peer, "friend");
  if (event.type === "friend.declined") store.db.run(`UPDATE directory_contacts SET relationship=NULL,request_id=NULL
    WHERE account_id=? AND user_id=? AND request_id=? AND relationship IN ('incoming','outgoing')`, store.accountId, peer, id(payload.requestId));
  if (event.type === "friend.removed") store.db.run(`UPDATE directory_contacts SET relationship=NULL,request_id=NULL WHERE account_id=? AND user_id=? AND relationship='friend'`, store.accountId, peer);
  if (event.type.startsWith("user.")) store.db.run(`INSERT INTO directory_contacts(account_id,user_id,own_blocked) VALUES(?,?,?)
    ON CONFLICT(account_id,user_id) DO UPDATE SET own_blocked=excluded.own_blocked`, store.accountId, peer, Number(event.type === "user.blocked"));
  store.db.run(`DELETE FROM directory_contacts WHERE account_id=? AND relationship IS NULL AND own_blocked=0`, store.accountId);
}

function removeTeamDirectory(store, scopeId) {
  const teams = store.db.all(`SELECT id FROM directory_teams WHERE account_id=? AND scope_id=?`, store.accountId, scopeId);
  for (const team of teams) store.db.run(`DELETE FROM directory_team_members WHERE account_id=? AND team_id=?`, store.accountId, team.id);
  store.db.run(`DELETE FROM directory_teams WHERE account_id=? AND scope_id=?`, store.accountId, scopeId);
}
function pruneDirectoryProfiles(store) {
  store.db.run(`DELETE FROM profiles WHERE account_id=? AND user_id<>?
    AND user_id NOT IN (SELECT user_id FROM directory_contacts WHERE account_id=?)
    AND user_id NOT IN (SELECT user_id FROM conversation_members WHERE account_id=?)
    AND user_id NOT IN (SELECT user_id FROM directory_team_members WHERE account_id=?)`,
  store.accountId, store.accountId, store.accountId, store.accountId, store.accountId);
}
function getDirectory(store) {
  return {
    profile: store.getProfile({ userId: store.accountId }),
    contacts: store.db.all(`SELECT c.*,p.lily_id,p.display_name,p.avatar_object_id,p.login_name,p.phone_masked FROM directory_contacts c
      LEFT JOIN profiles p ON p.account_id=c.account_id AND p.user_id=c.user_id WHERE c.account_id=? ORDER BY c.user_id`, store.accountId)
      .map((r) => ({ ...profile(r), relationship: r.relationship, requestId: r.request_id, ownBlocked: Boolean(r.own_blocked) })),
    teams: store.db.all(`SELECT * FROM directory_teams WHERE account_id=? ORDER BY id`, store.accountId).map((r) => ({
      id: r.id, scopeId: r.scope_id, name: r.name, role: r.role,
      members: store.db.all(`SELECT * FROM directory_team_members WHERE account_id=? AND team_id=? ORDER BY user_id`, store.accountId, r.id)
        .map((m) => ({ ...profile(m), role: m.role })),
    })),
  };
}

module.exports = { replaceDirectory, projectDirectoryEvent, removeTeamDirectory, pruneDirectoryProfiles, getDirectory, profile, id, rows, role, text };
