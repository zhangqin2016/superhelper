"use strict";
const checkpoint = require("./read-checkpoint");
const { queueAuthorizedRefresh } = require("./conversation-hydration");
function createReadRecovery({ store, client, deviceId, assertActive, onChange, recoverDeniedHistory }) {
  const flights = new Map();
  let recovery = null;
  const unavailable = () => ({ ok: false, code: "COLLAB_READ_PENDING" });
  function run(conversationId) {
    assertActive();
    if (flights.has(conversationId)) return flights.get(conversationId);
    const task = Promise.resolve().then(async () => {
      let result = unavailable();
      // One automatic follow-up allows a coalesced higher observation, never
      // spins on a clamped response or an unchanging failed command.
      for (let i = 0; i < 2; i += 1) {
        assertActive();
        if (!client?.submitMessage || !store.db) return result;
        const command = checkpoint.beginReadAttempt(store, conversationId, deviceId);
        if (!command) return result;
        try {
          assertActive();
          const ack = await client.submitMessage(command);
          assertActive();
          if (!checkpoint.matches(store, command)) return unavailable();
          const seq = ack?.result?.lastReadSeq;
          if (ack?.ok !== true || !Number.isSafeInteger(seq) || seq < 0) return { ok: false, code: "COLLAB_READ_ACK_INVALID" };
          store.db.transaction(() => {
            checkpoint.confirmRead(store, conversationId, seq, command);
            // An aggregate cannot be decremented using an ACK alone.
            queueAuthorizedRefresh(store, conversationId);
          })();
          onChange();
          result = { ok: true, conversationId, seq };
        } catch (error) {
          assertActive();
          if (!checkpoint.matches(store, command)) return unavailable();
          recoverDeniedHistory(conversationId, error);
          return { ok: false, code: "COLLAB_READ_PENDING" };
        }
      }
      return result;
    }).finally(() => { if (flights.get(conversationId) === task) flights.delete(conversationId); });
    flights.set(conversationId, task);
    return task;
  }
  return {
    markRead({ conversationId, seq }) {
      assertActive();
      if (!store.db || !deviceId || !client?.submitMessage) return Promise.resolve({ ok: false, code: "COLLABORATION_UNAVAILABLE" });
      const state = checkpoint.admitRead(store, { conversationId, seq, deviceId });
      if (!state.flight && state.pendingMax == null) return Promise.resolve({ ok: true, conversationId, seq: state.confirmedSeq });
      return run(conversationId);
    },
    recover() {
      assertActive();
      if (recovery) return recovery;
      if (!store.db || !deviceId || !client?.submitMessage) return Promise.resolve();
      const rows = store.db.all(`SELECT conversation_id FROM read_checkpoints WHERE account_id=?`, store.accountId)
        .map((row) => ({ id: row.conversation_id, state: checkpoint.getReadCheckpoint(store, row.conversation_id) }))
        .filter(({ state }) => (state.flight || state.pendingMax != null) && (!state.flight || state.flight.deviceId === deviceId) && state.retryAt <= store.now())
        .sort((a, b) => a.state.retryAt - b.state.retryAt || a.id.localeCompare(b.id)).slice(0, 20);
      const worker = async () => { while (rows.length) { assertActive(); await run(rows.shift().id); assertActive(); } };
      recovery = Promise.all([worker(), worker()]).finally(() => { recovery = null; });
      return recovery;
    },
  };
}
module.exports = { createReadRecovery };
