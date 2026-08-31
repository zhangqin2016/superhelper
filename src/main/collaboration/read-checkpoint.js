"use strict";
const { randomUUID } = require("node:crypto");
const { isConversationRevoked, assertScopeWritable } = require("./access-revocation");
const MAX_READ_RETRY_DELAY = 60_000;
const error = (code) => Object.assign(new Error("Collaboration read checkpoint unavailable"), { code });
function getReadCheckpoint(store, conversationId) {
  const row = store.db.get(`SELECT * FROM read_checkpoints WHERE account_id=? AND conversation_id=?`, store.accountId, conversationId);
  return row ? { ...store._decrypt({ scopeId: row.scope_id, recordId: `read:${conversationId}`, value: row.payload_envelope_json }), scopeId: row.scope_id } : null;
}
function save(store, conversationId, state) {
  const { scopeId, ...value } = state;
  store.db.run(`INSERT INTO read_checkpoints(account_id,conversation_id,scope_id,payload_envelope_json) VALUES(?,?,?,?)
    ON CONFLICT(account_id,conversation_id) DO UPDATE SET payload_envelope_json=excluded.payload_envelope_json`,
  store.accountId, conversationId, scopeId, store._encrypt({ scopeId, recordId: `read:${conversationId}`, value }));
}
function admitRead(store, { conversationId, seq, deviceId }) {
  if (typeof deviceId !== "string" || !deviceId.trim()) throw error("COLLAB_READ_DEVICE_REQUIRED");
  if (!Number.isSafeInteger(seq) || seq < 0) throw error("COLLAB_READ_INVALID");
  const conversation = store.getConversation({ conversationId });
  if (!conversation || isConversationRevoked(store, conversationId)) throw error("COLLAB_ACCESS_REVOKED");
  assertScopeWritable(store, conversation.scopeId);
  return store.db.transaction(() => {
    const state = getReadCheckpoint(store, conversationId) || { scopeId: conversation.scopeId, lastObservedSeq: -1, pendingMax: null, confirmedSeq: 0, flight: null, attempts: 0, retryAt: 0 };
    if (seq !== (state.lastObservedSeq ?? state.observedMax)) {
      state.lastObservedSeq = seq;
      // A clamped out-of-range observation is consumed, not a lifetime high
      // watermark: a subsequent real lower message must still be markable.
      if (seq > state.confirmedSeq && seq !== state.handledClampSeq && seq !== state.flight?.seq) state.pendingMax = Math.max(state.pendingMax ?? 0, seq);
      save(store, conversationId, state);
    }
    return state;
  })();
}
function beginReadAttempt(store, conversationId, deviceId) {
  return store.db.transaction(() => {
    const state = getReadCheckpoint(store, conversationId);
    if (!state || !deviceId) return null;
    if (!state.flight && state.pendingMax != null) {
      state.flight = { deviceId, seq: state.pendingMax, clientCommandId: randomUUID() };
      state.pendingMax = null; state.attempts = 0; state.retryAt = 0;
    }
    if (!state.flight || state.flight.deviceId !== deviceId || state.retryAt > store.now()) return null;
    state.attempts = Math.min(Number.MAX_SAFE_INTEGER, state.attempts + 1);
    state.retryAt = store.now() + Math.min(MAX_READ_RETRY_DELAY, 1000 * 2 ** Math.min(6, state.attempts - 1));
    save(store, conversationId, state);
    return { action: "read", conversationId, ...state.flight };
  })();
}
function matches(store, command) {
  const state = getReadCheckpoint(store, command.conversationId);
  return state?.flight?.clientCommandId === command.clientCommandId && state.flight.deviceId === command.deviceId && state.flight.seq === command.seq;
}
function releaseHandledClamp(store, conversationId, authorizedSeq) {
  if (!Number.isSafeInteger(authorizedSeq) || authorizedSeq < 0) return;
  const state = getReadCheckpoint(store, conversationId);
  if (state?.handledClampSeq == null || authorizedSeq < state.handledClampSeq) return;
  // Only new authorized snapshot/message evidence calls this. A read ACK or
  // its own conversation.read event cannot turn a handled clamp into a loop.
  if (state.lastObservedSeq === state.handledClampSeq) state.lastObservedSeq = -1;
  delete state.handledClampSeq;
  save(store, conversationId, state);
}
function confirmRead(store, conversationId, seq, command = null, remember = false) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw error("COLLAB_READ_ACK_INVALID");
  return store.db.transaction(() => {
    let state = getReadCheckpoint(store, conversationId);
    if (!state && remember) {
      const conversation = store.getConversation({ conversationId });
      if (conversation) state = { scopeId: conversation.scopeId, lastObservedSeq: -1, pendingMax: null, confirmedSeq: 0, flight: null, attempts: 0, retryAt: 0 };
    }
    if (!state || command && !matches(store, command)) return false;
    state.confirmedSeq = Math.max(state.confirmedSeq, seq);
    if (command && seq < command.seq) state.handledClampSeq = command.seq;
    if (state.flight && (command || seq >= state.flight.seq)) { state.flight = null; state.attempts = 0; state.retryAt = 0; }
    if (state.pendingMax != null && state.pendingMax <= state.confirmedSeq) state.pendingMax = null;
    save(store, conversationId, state);
    return true;
  })();
}
module.exports = { MAX_READ_RETRY_DELAY, getReadCheckpoint, admitRead, beginReadAttempt, matches, confirmRead, releaseHandledClamp };
