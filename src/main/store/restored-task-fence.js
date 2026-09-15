"use strict";

/** A restored queue may describe work already executed after the snapshot.
 * Quarantine that old admission once, durably, before constructing runtimes.
 * New user requests after recovery are unaffected, even if receipt ack fails.
 */
function fenceRestoredTasks(store, receipt) {
  if (!receipt?.id) return false;
  const key = `database-recovery-fence:${receipt.id}`;
  return store.db.transaction(() => {
    if (store.db.get("SELECT value FROM schema_meta WHERE key = ?", key)) return false;
    store.db.run(`UPDATE turn_inputs SET status = 'outcome_unknown',
      error_code = 'DATABASE_RESTORED_MANUAL_REVIEW'
      WHERE status IN ('admitted', 'dispatching', 'accepted')`);
    store.db.run(`UPDATE parent_closure_recoveries SET status = 'unavailable',
      reason = 'DATABASE_RESTORED_MANUAL_REVIEW', claim_expires_at = NULL, updated_at = ?
      WHERE status IN ('prepared', 'claimed')`, Date.now());
    store.setMeta(key, JSON.stringify({ at: Date.now(), reason: "manual_review_required" }));
    return true;
  })();
}

module.exports = { fenceRestoredTasks };
