"use strict";

/**
 * Resumable, bounded artifact backfill.
 *
 * A schema bump invalidates every session's completion flag, so the pass has to
 * walk all of history again. The 2026-09-18 field case: a customer's 0.1.177
 * froze on launch ("智能工作台 (未响应)") with conversations of 553 / 788 / 1450
 * messages while 0.1.176 was fine — ARTIFACT_SCHEMA_VERSION had gone 4 → 5.
 * Two properties of the old pass turned that into a hang rather than a slow
 * start:
 *
 *   1. a session was ONE synchronous unit — every message unpacked, re-derived
 *      (≈5 statSync each) and written back before the loop yielded, so the main
 *      process could not answer anything for the whole session;
 *   2. the completion flag was written only after that loop finished, so a user
 *      who force-quit the frozen window started again from zero on every launch.
 *
 * Here the unit of work is a bounded SLICE of messages and the cursor is
 * persisted after each slice: a force-quit loses at most one slice, and no tick
 * is ever longer than one slice. Sessions are worked newest-first so the
 * conversation the user is most likely to open is ready first.
 *
 * Failure mode: any error abandons that session for this launch and leaves its
 * flag unwritten — the next launch retries it. A store without the bounded read
 * gets no enrichment at all rather than an unbounded one. Baseline is records
 * displayed from their stored artifacts, which is what 0.1.176 shipped.
 * [gate: resumable-enrichment]
 */

const DEFAULT_BATCH_SIZE = 40;
const DEFAULT_TICK_DELAY_MS = 8;
// A tick has to stay short enough that the window keeps answering. The batch is
// not a constant: the same message costs ~1 ms to re-derive on a warm macOS SSD
// and several times that on a Windows box where every stat goes through an AV
// filter, so the pass measures its own cost PER MESSAGE and sizes each slice to
// this budget, instead of trusting a number picked on the developer's machine.
// (Per-message, not per-slice: a small session's 7-row slice finishes in 7 ms,
// which says nothing about how many rows fit in a tick — reading that as spare
// headroom is what let an early version grow to 200 and spend 214 ms in one.)
const TARGET_TICK_MS = 50;
const MIN_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 200;
const FLAG_PREFIX = "enriched:";
const CURSOR_PREFIX = "enriching:";

function versionSuffix(versions = {}) {
  return `a${versions.artifact}:b${versions.resultBlock}`;
}

function flagKey(sessionId, versions) {
  return `${FLAG_PREFIX}${sessionId}:${versionSuffix(versions)}`;
}

function cursorKey(sessionId, versions) {
  return `${CURSOR_PREFIX}${sessionId}:${versionSuffix(versions)}`;
}

/**
 * A session's recency as a number.
 *
 * SessionManager stores `updatedAt` as an ISO STRING; reading it with Number()
 * yields NaN, and a NaN comparator silently leaves the list unsorted — the
 * ordering would look implemented and do nothing.
 */
function sessionTime(session) {
  const raw = session?.updatedAt ?? session?.createdAt ?? 0;
  const numeric = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readCursor(store, key) {
  const seq = Number(store.meta(key));
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

/**
 * Backfill ONE bounded slice of a session and persist where it stopped.
 *
 * @param {{ store: object, sessionId: string, workspacePath: string,
 *   backfill: (message: object, workspacePath: string) => boolean,
 *   versions: { artifact: number|string, resultBlock: number|string },
 *   batchSize?: number }} input
 * @returns {{ done: boolean, scanned: number, enriched: number, cursor: number }}
 */
function enrichSessionSlice(input = {}) {
  const { store, sessionId, workspacePath, backfill, versions } = input;
  const batchSize = Math.max(1, Number(input.batchSize) || DEFAULT_BATCH_SIZE);
  const flag = flagKey(sessionId, versions);
  if (store.meta(flag)) return { done: true, scanned: 0, enriched: 0, cursor: 0 };

  const cursorAt = cursorKey(sessionId, versions);
  const from = readCursor(store, cursorAt);
  const now = input.now || monotonicNow;
  const startedAt = now();
  const budgetMs = Number(input.budgetMs) > 0 ? Number(input.budgetMs) : 0;
  const slice = store.messageSlice(sessionId, from, batchSize);
  let cursor = from;
  let enriched = 0;
  let scanned = 0;
  for (const row of slice) {
    if (Number.isFinite(Number(row?.seq))) cursor = Number(row.seq);
    scanned += 1;
    const message = row?.message;
    if (message?.record && message.id && backfill(message, workspacePath)) {
      store.updateById(message.id, () => message);
      enriched += 1;
    }
    // Re-derivation cost is heavy-tailed: most records are cheap, a few stat
    // dozens of paths. A count alone cannot bound a tail, so the slice also
    // stops on the clock — the guarantee is then budget + ONE record, whatever
    // the mean says. Anything unread stays behind the cursor for the next tick.
    if (budgetMs && scanned < slice.length && now() - startedAt >= budgetMs) break;
  }

  const done = scanned >= slice.length && slice.length < batchSize;
  if (done) {
    // The terminal marker, written only once the tail is actually reached: an
    // interrupted pass must come back to its cursor, never to a flag that
    // claims work it did not do.
    store.setMeta(flag, `1:${cursor}`);
    store.deleteMeta?.(cursorAt);
  } else {
    store.setMeta(cursorAt, String(cursor));
  }
  return { done, scanned, enriched, cursor };
}

function clampBatch(size) {
  return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, Math.round(size) || MIN_BATCH_SIZE));
}

/** How many messages fit in one tick, given the measured cost of one. */
function nextBatchSize(costMs, targetMs = TARGET_TICK_MS) {
  const cost = Number(costMs);
  if (!(cost > 0)) return DEFAULT_BATCH_SIZE; // nothing measured yet
  return clampBatch(Math.max(1, Number(targetMs) || TARGET_TICK_MS) / cost);
}

/** Exponentially-smoothed ms-per-message, so one slow slice neither sets nor is ignored. */
function observeSliceCost(costMs, scanned, elapsedMs) {
  if (!(scanned > 0)) return costMs; // an early tail says nothing about cost
  const sample = Math.max(0, Number(elapsedMs) || 0) / scanned;
  return costMs > 0 ? costMs * 0.6 + sample * 0.4 : sample;
}

const monotonicNow = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/** Drop cursors left by earlier schema versions; a resumed pass only ever reads its own. */
function sweepStaleCursors(store, versions) {
  if (typeof store.metaKeys !== "function" || typeof store.deleteMeta !== "function") return 0;
  const keep = `:${versionSuffix(versions)}`;
  let removed = 0;
  for (const key of store.metaKeys(CURSOR_PREFIX)) {
    if (key.endsWith(keep)) continue;
    store.deleteMeta(key);
    removed += 1;
  }
  return removed;
}

/**
 * Walk every session that still needs backfill, one bounded slice per tick.
 *
 * @param {{ store: object, sessions: Array<object>, schedule: (fn: Function, delay: number) => any,
 *   workspacePathFor: (session: object) => string,
 *   backfill: (message: object, workspacePath: string) => boolean,
 *   versions: object, batchSize?: number, tickDelayMs?: number,
 *   onDone?: (summary: object) => void }} input
 * @returns {{ pending: number, reason?: string }}
 */
function startResumableEnrichment(input = {}) {
  const { store, schedule, workspacePathFor, backfill, versions } = input;
  if (typeof store?.messageSlice !== "function") return { pending: 0, reason: "NO_BOUNDED_READ" };
  const batchSize = Math.max(1, Number(input.batchSize) || DEFAULT_BATCH_SIZE);
  const tickDelayMs = Math.max(0, Number(input.tickDelayMs ?? DEFAULT_TICK_DELAY_MS));

  let pending = [];
  try {
    sweepStaleCursors(store, versions);
    pending = (input.sessions || [])
      .filter((session) => session?.id && !store.meta(flagKey(session.id, versions)))
      // Newest first: the user opens a recent conversation, not the oldest one.
      .sort((a, b) => sessionTime(b) - sessionTime(a));
  } catch {
    return { pending: 0, reason: "SCAN_FAILED" };
  }
  if (!pending.length) return { pending: 0 };

  const summary = { sessions: 0, slices: 0, enriched: 0, failed: 0, batchSize, slowestTickMs: 0, costMs: 0 };
  const now = input.now || monotonicNow;
  const targetTickMs = Math.max(1, Number(input.targetTickMs) || TARGET_TICK_MS);
  let index = 0;
  let sessionEnriched = 0;

  const step = () => {
    const session = pending[index];
    if (!session) {
      input.onDone?.(summary);
      return;
    }
    let advance = false;
    try {
      const workspacePath = workspacePathFor?.(session) || "";
      if (!workspacePath) {
        // Artifact relevance is decided against the workspace root; without one
        // there is nothing to decide. Retry on a launch where it is known.
        advance = true;
      } else {
        const startedAt = now();
        const result = enrichSessionSlice({
          store, sessionId: session.id, workspacePath, backfill, versions,
          batchSize: summary.batchSize, budgetMs: targetTickMs, now,
        });
        const elapsed = now() - startedAt;
        summary.slices += 1;
        summary.enriched += result.enriched;
        summary.slowestTickMs = Math.max(summary.slowestTickMs, elapsed);
        summary.costMs = observeSliceCost(summary.costMs, result.scanned, elapsed);
        summary.batchSize = nextBatchSize(summary.costMs, targetTickMs);
        sessionEnriched += result.enriched;
        advance = result.done;
      }
    } catch (error) {
      console.warn("[sessions] enrichment failed for", session.id, error?.message || error);
      summary.failed += 1;
      advance = true;
    }
    if (advance) {
      if (sessionEnriched > 0) console.info(`[sessions] enriched ${sessionEnriched} record(s) for ${session.id}`);
      summary.sessions += 1;
      sessionEnriched = 0;
      index += 1;
    }
    schedule(step, tickDelayMs);
  };

  schedule(step, tickDelayMs);
  return { pending: pending.length };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  TARGET_TICK_MS,
  nextBatchSize,
  sessionTime,
  observeSliceCost,
  DEFAULT_TICK_DELAY_MS,
  cursorKey,
  enrichSessionSlice,
  flagKey,
  startResumableEnrichment,
  sweepStaleCursors,
};
