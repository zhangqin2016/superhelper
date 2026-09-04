"use strict";

/**
 * Background maintenance for the runtime-event log.
 *
 * Two jobs, in order. Orphan rows first: compacting a payload that belongs to a
 * conversation the user already deleted is work spent on a row that should not
 * exist. Then oversized payloads of rows that remain.
 *
 * Both are bounded per round and rescheduled while there is still work, so a
 * large backlog is worked off across rounds and startups instead of blocking
 * one. Pruning is wrapped separately: maintenance must never be the reason a
 * startup fails.
 *
 * Extracted from session-manager.js, which was at its line ratchet. The store
 * and the scheduler are injected, so this is testable without a session
 * manager.
 */

function startRuntimeEventMaintenance({ store, schedule }) {
  const BATCH_SIZE = 200;
  const ORPHAN_BATCH_SIZE = 20_000;
  const MIN_BYTES = 20_000;
  const MAX_ROUNDS = 50;
  let rounds = 0;
  const step = () => {
    rounds += 1;
    try {
      // Orphan events first: compacting a payload that belongs to a deleted
      // conversation is work spent on a row that should not exist. They were
      // never deleted anywhere, so an install accumulates them forever —
      // measured 2,542,720 orphans (64.9% of all events) in a 12 GB database
      // holding 1,156 messages. Bounded per round, so a large backlog is
      // worked off across rounds and startups instead of blocking one.
      let prunedOrphans = 0;
      try {
        prunedOrphans = store().pruneOrphanRuntimeEvents({ limit: ORPHAN_BATCH_SIZE });
        if (prunedOrphans > 0) {
          console.info("[sessions] pruned " + prunedOrphans + " runtime event(s) from deleted conversations");
        }
      } catch (pruneErr) {
        // Fail open: pruning is maintenance, never a reason to break startup.
        console.warn("[sessions] orphan runtime event prune failed:", pruneErr?.message || pruneErr);
      }
      const result = store().compactRuntimeEventPayloads({
        limit: BATCH_SIZE,
        minBytes: MIN_BYTES,
      });
      if (result?.compacted > 0) {
        const saved = Math.max(0, Number(result.beforeBytes || 0) - Number(result.afterBytes || 0));
        console.info(`[sessions] compacted ${result.compacted} runtime event payload(s), saved ${saved} byte(s)`);
      }
      if ((result?.compacted > 0 || prunedOrphans > 0) && rounds < MAX_ROUNDS) {
        schedule(step, 1000);
      }
    } catch (err) {
      console.warn("[sessions] runtime event maintenance failed:", err?.message || err);
    }
  };
  schedule(step, 12000);
}

module.exports = { startRuntimeEventMaintenance };
