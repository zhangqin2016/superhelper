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
  const ORPHAN_SESSION_BATCH = 4;
  const HISTORY_CHUNKS_PER_ROUND = 4;
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
      // Drain the ephemeral events a pre-retention install accumulated.
      //
      // Chunked and bounded by the PRIMARY KEY, so each chunk is an index range
      // scan: 30 ms for a 20,000-seq window on a real 12 GB install, against
      // 19.8 s for the single full-table DELETE the obvious `type IN (...)`
      // query produces. A cursor in schema_meta resumes across restarts and
      // stops looking once finished, so a clean install pays nothing.
      //
      // This SUPERSEDES the orphan scan below: a deleted conversation's rows
      // are the same ephemeral types, so they drain here without the 3-second
      // NOT EXISTS discovery that made the orphan path unusable on this thread.
      let prunedHistory = 0;
      try {
        const history = store().pruneHistoricalEphemeralEvents({ maxChunks: HISTORY_CHUNKS_PER_ROUND });
        prunedHistory = Number(history?.removed || 0);
        if (prunedHistory > 0) {
          console.info("[sessions] pruned " + prunedHistory + " historical runtime event(s)");
        }
      } catch (historyErr) {
        console.warn("[sessions] historical runtime event prune failed:", historyErr?.message || historyErr);
      }

      // Superseded by the drain above, and OFF by default: finding orphans
      // needs a full-table NOT EXISTS scan (2.8-3.1 s measured), which is not
      // something to run here. Kept only as an explicit escape hatch.
      let prunedOrphans = 0;
      try {
        if (process.env.LILY_PRUNE_ORPHAN_EVENTS === "1") {
          prunedOrphans = store().pruneOrphanRuntimeEvents({
            limit: ORPHAN_BATCH_SIZE,
            maxSessions: ORPHAN_SESSION_BATCH,
          });
        }
        if (prunedOrphans > 0) {
          console.info("[sessions] pruned " + prunedOrphans + " runtime event(s) from deleted conversations");
        }
      } catch (pruneErr) {
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
      if ((result?.compacted > 0 || prunedOrphans > 0 || prunedHistory > 0) && rounds < MAX_ROUNDS) {
        schedule(step, 1000);
      }
    } catch (err) {
      console.warn("[sessions] runtime event maintenance failed:", err?.message || err);
    }
  };
  schedule(step, 12000);
}

module.exports = { startRuntimeEventMaintenance };
