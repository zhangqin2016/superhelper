"use strict";
const { confirmRead, getReadCheckpoint, releaseHandledClamp } = require("./read-checkpoint");
const fields = ["projectionSeq", "lastReadSeq", "unreadCount", "mentionCount"];
const invalid = () => Object.assign(new Error("Invalid collaboration activity projection"), { code: "COLLAB_CONVERSATION_INVALID" });
function normalizeActivity(value) {
  // Old servers exposed a read watermark but did not compute exact counts.
  if (!["projectionSeq", "unreadCount", "mentionCount"].some((key) => Object.hasOwn(value, key))) return null;
  if (fields.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.lastReadSeq > value.projectionSeq || value.unreadCount > value.projectionSeq || value.mentionCount > value.unreadCount) throw invalid();
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
function activityView(store, conversationId) {
  const row = store.db.get(`SELECT * FROM conversation_activity WHERE account_id=? AND conversation_id=?`, store.accountId, conversationId);
  return row ? { activityKnown: true, projectionSeq: row.projection_seq, lastReadSeq: row.last_read_seq, unreadCount: row.unread_count, mentionCount: row.mention_count } : { activityKnown: false };
}
function applyActivitySnapshot(store, conversationId, value) {
  const activity = normalizeActivity(value);
  if (!activity) {
    store.db.run(`DELETE FROM conversation_activity WHERE account_id=? AND conversation_id=?`, store.accountId, conversationId);
    return true;
  }
  const old = activityView(store, conversationId);
  if (old.activityKnown && old.projectionSeq > activity.projectionSeq) return false;
  store.db.run(`INSERT INTO conversation_activity(account_id,conversation_id,projection_seq,last_read_seq,unread_count,mention_count) VALUES(?,?,?,?,?,?)
    ON CONFLICT(account_id,conversation_id) DO UPDATE SET projection_seq=excluded.projection_seq,last_read_seq=excluded.last_read_seq,unread_count=excluded.unread_count,mention_count=excluded.mention_count`,
  store.accountId, conversationId, activity.projectionSeq, activity.lastReadSeq, activity.unreadCount, activity.mentionCount);
  confirmRead(store, conversationId, activity.lastReadSeq);
  releaseHandledClamp(store, conversationId, activity.projectionSeq);
  const stale = (getReadCheckpoint(store, conversationId)?.confirmedSeq || 0) > activity.lastReadSeq;
  return !stale;
}
function projectMessageActivity(store, event) {
  const conversationId = event.conversationId ?? event.conversation_id;
  if (!conversationId || event.type !== "message.created") return;
  const actor = event.actorUserId ?? event.actor_user_id;
  const seq = event.seq;
  if (typeof actor === "string" && actor) releaseHandledClamp(store, conversationId, seq);
  const state = activityView(store, conversationId);
  if (!state.activityKnown) return;
  if (!Number.isSafeInteger(seq) || seq < 0 || typeof actor !== "string" || !actor) throw invalid();
  if (seq <= state.projectionSeq) return;
  const unread = actor !== store.accountId && seq > Math.max(state.lastReadSeq, getReadCheckpoint(store, conversationId)?.confirmedSeq || 0);
  const mentioned = unread && Array.isArray(event.payload?.mentionUserIds) && event.payload.mentionUserIds.includes(store.accountId);
  // The validated ordered sync stream covers preceding activity, even when
  // this message is own/already-read. Arbitrary history pages never do this.
  store.db.run(`UPDATE conversation_activity SET projection_seq=?,unread_count=unread_count+?,mention_count=mention_count+? WHERE account_id=? AND conversation_id=?`, seq, unread ? 1 : 0, mentioned ? 1 : 0, store.accountId, conversationId);
}
function resetMembershipReadState(store, conversationId, members) {
  const prior = store.listConversationMembers({ conversationId }).find((m) => m.userId === store.accountId);
  const current = members.find((m) => (m.userId ?? m.user_id) === store.accountId && (m.conversationId ?? m.conversation_id ?? conversationId) === conversationId);
  if (prior && Number(current?.joinedSeq ?? current?.joined_seq) > prior.joinedSeq) {
    for (const table of ["read_checkpoints", "conversation_activity", "reply_source_masks"]) store.db.run(`DELETE FROM ${table} WHERE account_id=? AND conversation_id=?`, store.accountId, conversationId);
  }
}
module.exports = { normalizeActivity, activityView, applyActivitySnapshot, projectMessageActivity, resetMembershipReadState };
