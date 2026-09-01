"use strict";
const { randomUUID } = require("node:crypto");

function resetHistoryGeneration(store, conversationId) {
  store.db.run(`UPDATE conversations SET history_generation = ? WHERE account_id = ? AND id = ?`,
    randomUUID(), store.accountId, conversationId);
}

/** Capture before issuing HTTP; check even on errors before access-denial cleanup.
 * The service lane serializes ordinary work. This also covers direct bootstrap,
 * membership projection and remove/regrant while an older request is pending. */
function captureHistoryFence(store, conversationId) {
  if (!store.db) return () => {}; // Legacy adapters have their service lifecycle fence.
  const accountId = store.accountId;
  const generation = () => store.db.get(`SELECT history_generation FROM conversations WHERE account_id = ? AND id = ?`, accountId, conversationId)?.history_generation;
  const expected = generation();
  return () => {
    if (store.accountId !== accountId || generation() !== expected) {
      throw Object.assign(new Error("Collaboration history authorization changed"), { code: "COLLAB_HISTORY_STALE" });
    }
  };
}
module.exports = { resetHistoryGeneration, captureHistoryFence };
