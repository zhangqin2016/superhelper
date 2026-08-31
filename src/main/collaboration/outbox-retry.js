"use strict";
const { safeOperationErrorCode } = require("./message-operation-view");

// The store validates the identity before handing off atomic retry accounting.
function recordOutboxRetry(store, { outboxId, maxAttempts, uncertainDelivery = false, errorCode }) {
  const max = Number(maxAttempts);
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("collaboration store: retry limit is invalid");
  const expectedState = uncertainDelivery ? "confirming" : "submitting";
  return store.db.transaction(() => {
    const row = store.db.get(`SELECT attempts FROM outbox WHERE account_id = ? AND id = ? AND state = ?`, store.accountId, outboxId, expectedState);
    if (!row) return null;
    const attempts = Number(row.attempts) + 1;
    const state = uncertainDelivery ? (attempts >= max ? "delivery_unknown" : "confirming") : (attempts >= max ? "paused" : "queued");
    store.db.run(`UPDATE outbox SET attempts = ?, state = ?, delivery_uncertain = CASE WHEN delivery_confirmed = 1 THEN 0 ELSE ? END,
      error_code = CASE WHEN delivery_confirmed = 1 THEN NULL WHEN ? THEN ? ELSE error_code END, updated_at = ? WHERE account_id = ? AND id = ? AND state = ?`,
    attempts, state, Number(uncertainDelivery), Number(errorCode !== undefined), safeOperationErrorCode(errorCode), store.now(), store.accountId, outboxId, expectedState);
    return { state, attempts };
  })();
}
module.exports = { recordOutboxRetry };
