#!/usr/bin/env node
// Artifact backfill is bounded and resumable: one slice of one session per tick,
// the cursor persisted after every slice, the completion flag written only when
// the tail is reached. A force-quit mid-pass must resume — the field case was a
// customer's 0.1.177 freezing on launch (553 / 788 / 1450-message conversations)
// after ARTIFACT_SCHEMA_VERSION went 4 → 5, and never getting past it because
// the flag was written only after a whole session had been re-derived.
// [gate: resumable-enrichment]
// Run: node scripts/test-resumable-enrichment.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const {
  cursorKey,
  enrichSessionSlice,
  flagKey,
  startResumableEnrichment,
  sweepStaleCursors,
  nextBatchSize,
  observeSliceCost,
  BIG_RECORD_BYTES,
  versionsUsable,
  nextBigRecordBytes,
  observeByteCost,
  MIN_BIG_RECORD_BYTES,
  MAX_BIG_RECORD_BYTES,
  sessionTime,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  TARGET_TICK_MS,
} = require("../src/main/session-enrichment.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resumable-enrichment-"));
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const V4 = { artifact: 4, resultBlock: 2 };
const V5 = { artifact: 5, resultBlock: 2 };
const WORKSPACE = tmp;

function seed(sessionId, count) {
  for (let i = 0; i < count; i += 1) {
    store.append(sessionId, {
      id: `${sessionId}-m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
      record: { kind: "turn", turnId: `${sessionId}-t${i}`, status: "completed" },
    });
  }
}

// A backfill stand-in that touches every record, so every message is real work.
let backfillCalls = [];
const backfill = (message) => { backfillCalls.push(message.id); message.record.touched = true; return true; };

// A scheduler that runs ticks on demand, so a "force-quit" is simply not
// draining the queue.
function manualScheduler() {
  const queue = [];
  return {
    schedule: (fn) => { queue.push(fn); return null; },
    runTicks(max = Infinity) {
      let ran = 0;
      while (queue.length && ran < max) { queue.shift()(); ran += 1; }
      return ran;
    },
    get depth() { return queue.length; },
  };
}

try {
  seed("big", 1450);
  seed("small", 7);

  check("a slice never exceeds its batch, and the completion flag is withheld until the tail", () => {
    backfillCalls = [];
    const first = enrichSessionSlice({ store, sessionId: "big", workspacePath: WORKSPACE, backfill, versions: V5, batchSize: 40 });
    assert.equal(first.scanned, 40, "a slice is bounded by batchSize, not by the session size");
    assert.equal(first.enriched, 40);
    assert.equal(first.done, false);
    assert.equal(store.meta(flagKey("big", V5)), null, "no completion flag while work remains");
    assert.equal(store.meta(cursorKey("big", V5)), String(first.cursor), "the cursor is persisted after the slice");
    const second = enrichSessionSlice({ store, sessionId: "big", workspacePath: WORKSPACE, backfill, versions: V5, batchSize: 40 });
    assert.ok(second.cursor > first.cursor);
    assert.equal(backfillCalls.length, 80, "the second slice re-derives nothing the first one did");
    assert.deepEqual(backfillCalls.slice(0, 2), ["big-m0", "big-m1"]);
    assert.equal(new Set(backfillCalls).size, 80, "no message is visited twice");
  });

  check("a force-quit mid-pass resumes at the cursor instead of restarting", () => {
    // Where run #1 stopped, from the rows already written above.
    const interrupted = Number(store.meta(cursorKey("big", V5)));
    assert.ok(interrupted >= 80);
    backfillCalls = [];
    let slices = 0;
    for (;;) {
      const result = enrichSessionSlice({ store, sessionId: "big", workspacePath: WORKSPACE, backfill, versions: V5, batchSize: 40 });
      slices += 1;
      if (result.done) break;
      assert.ok(slices < 200, "the pass terminates");
    }
    assert.equal(backfillCalls.length, 1450 - 80, "resumption covers exactly the remaining tail");
    assert.equal(new Set(backfillCalls).size, backfillCalls.length);
    assert.ok(store.meta(flagKey("big", V5)), "reaching the tail writes the terminal flag");
    assert.equal(store.meta(cursorKey("big", V5)), null, "the cursor is released once the session is done");
    backfillCalls = [];
    const after = enrichSessionSlice({ store, sessionId: "big", workspacePath: WORKSPACE, backfill, versions: V5, batchSize: 40 });
    assert.equal(after.done, true);
    assert.equal(backfillCalls.length, 0, "a flagged session is never walked again");
  });

  check("the scheduler yields between slices — no tick carries a whole session", () => {
    const sessions = [{ id: "big", projectId: "p", updatedAt: 2 }, { id: "small", projectId: "p", updatedAt: 1 }];
    store.deleteMeta(flagKey("big", V5));
    backfillCalls = [];
    const scheduler = manualScheduler();
    const perTick = [];
    const started = startResumableEnrichment({
      store,
      sessions,
      schedule: scheduler.schedule,
      workspacePathFor: () => WORKSPACE,
      backfill: (message, workspace) => { const before = backfillCalls.length; backfill(message, workspace); return backfillCalls.length > before; },
      versions: V5,
      batchSize: 40,
    });
    assert.equal(started.pending, 2);
    let guard = 0;
    while (scheduler.depth && guard < 200) {
      const before = backfillCalls.length;
      scheduler.runTicks(1);
      perTick.push(backfillCalls.length - before);
      guard += 1;
    }
    assert.ok(Math.max(...perTick) <= MAX_BATCH_SIZE, `no tick exceeds the hard batch ceiling: max ${Math.max(...perTick)}`);
    assert.equal(backfillCalls.length, 1450 + 7, "both sessions are fully covered");
    assert.ok(store.meta(flagKey("small", V5)));
  });

  check("the batch converges on the tick budget instead of trusting a fixed number", () => {
    assert.equal(nextBatchSize(1, 50), 50, "1 ms per message and a 50 ms budget is 50 messages");
    assert.equal(nextBatchSize(10, 50), 5, "a machine 10x slower gets slices 10x smaller");
    assert.equal(nextBatchSize(100, 50), MIN_BATCH_SIZE, "never below the floor");
    assert.equal(nextBatchSize(0.001, 50), MAX_BATCH_SIZE, "never above the ceiling");
    assert.equal(nextBatchSize(0), DEFAULT_BATCH_SIZE, "with nothing measured, the default");
    assert.equal(observeSliceCost(0, 0, 900), 0, "an early tail is not a cost sample");
    assert.equal(observeSliceCost(0, 10, 50), 5, "the first sample sets the cost");
    assert.ok(observeSliceCost(5, 10, 200) > 5, "a slower slice raises the estimate");

    // A machine where each message costs 10 ms — a Windows box behind an AV
    // filter. The fake clock advances with the work actually done, so the
    // controller sees a real per-message cost.
    store.deleteMeta(flagKey("big", V5));
    const slow = manualScheduler();
    const sizes = [];
    let visited = 0;
    startResumableEnrichment({
      store,
      sessions: [{ id: "big", projectId: "p", updatedAt: 1 }],
      schedule: slow.schedule,
      workspacePathFor: () => WORKSPACE,
      // One call per message in the slice: the count IS the batch actually used.
      backfill: () => { visited += 1; return false; },
      versions: V5,
      batchSize: MAX_BATCH_SIZE,
      targetTickMs: 50,
      now: () => visited * 10,
    });
    for (let i = 0; i < 6 && slow.depth; i += 1) {
      const before = visited;
      slow.runTicks(1);
      sizes.push(visited - before);
    }
    // 50 ms of budget at 10 ms a message: the in-slice clock stops the FIRST
    // tick at ~5 records even though it was handed a batch of 200.
    assert.ok(Math.max(...sizes) <= 6, `the time budget bounds every tick, first one included: ${sizes.join(",")}`);
    assert.ok(Math.min(...sizes) >= 1, `and each tick still makes progress: ${sizes.join(",")}`);

    // One pathological record — a turn that stats dozens of paths — spends the
    // whole budget by itself. The guarantee is budget + one record, so the
    // slice must end right after it rather than running the other 199.
    store.deleteMeta(flagKey("big", V5));
    store.deleteMeta(cursorKey("big", V5));
    let seen = 0;
    let clock = 0;
    const tail = enrichSessionSlice({
      store, sessionId: "big", workspacePath: WORKSPACE, versions: V5, batchSize: MAX_BATCH_SIZE,
      budgetMs: 50, now: () => clock,
      backfill: () => { seen += 1; clock += seen === 3 ? 900 : 1; return false; },
    });
    assert.equal(seen, 3, `a record that blows the budget ends the slice: ${seen}`);
    assert.equal(tail.done, false, "and the session is not marked finished");
    assert.ok(Number(store.meta(cursorKey("big", V5))) > 0, "the cursor points just past it");

    // The same controller on a fast machine grows to the ceiling rather than
    // crawling: bounded must not mean slow.
    store.setMeta(flagKey("big", V5), "1:done");
    store.deleteMeta(flagKey("small", V5));
    const fast = manualScheduler();
    let fastVisited = 0;
    let fastBatch = 0;
    startResumableEnrichment({
      store, sessions: [{ id: "small", projectId: "p", updatedAt: 1 }], schedule: fast.schedule,
      workspacePathFor: () => WORKSPACE, backfill: () => { fastVisited += 1; return false; },
      versions: V5, batchSize: MIN_BATCH_SIZE, now: () => fastVisited * 0.01,
      onDone: (s) => { fastBatch = s.batchSize; },
    });
    fast.runTicks(50);
    assert.equal(fastBatch, MAX_BATCH_SIZE, `0.01 ms per message earns the ceiling, not the floor: ${fastBatch}`);
    store.setMeta(flagKey("big", V5), "1:done");
  });

  check("sessions are worked newest-first, with the ISO timestamps SessionManager actually stores", () => {
    // The field shape is a string: Number("2026-09-18T…") is NaN, and a NaN
    // comparator leaves the list untouched — ordering that looks implemented
    // and does nothing.
    assert.ok(sessionTime({ updatedAt: "2026-09-18T00:00:00.000Z" }) > sessionTime({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    assert.equal(sessionTime({ updatedAt: 1700 }), 1700, "a numeric timestamp still works");
    assert.equal(sessionTime({ updatedAt: "not a date" }), 0, "an unparseable value sorts last, never NaN");
    assert.equal(sessionTime({ createdAt: "2026-09-18T00:00:00.000Z" }), Date.parse("2026-09-18T00:00:00.000Z"), "falls back to createdAt");
    assert.equal(sessionTime(null), 0);

    store.deleteMeta(flagKey("big", V5));
    store.deleteMeta(flagKey("small", V5));
    const order = [];
    const scheduler = manualScheduler();
    startResumableEnrichment({
      store,
      sessions: [{ id: "big", projectId: "p", updatedAt: "2026-01-01T00:00:00.000Z" }, { id: "small", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }],
      schedule: scheduler.schedule,
      workspacePathFor: () => WORKSPACE,
      backfill: (message) => { order.push(message.id.split("-")[0]); return false; },
      versions: V5,
      batchSize: 40,
    });
    scheduler.runTicks(400);
    assert.equal(order[0], "small", "the most recently updated conversation is enriched first");
  });

  check("a schema bump re-walks history and sweeps the previous version's cursors", () => {
    store.setMeta(cursorKey("big", V4), "120");
    store.setMeta(cursorKey("small", V4), "3");
    assert.equal(sweepStaleCursors(store, V5), 2, "cursors from another schema version are dropped");
    assert.equal(store.meta(cursorKey("big", V4)), null);
    assert.ok(store.meta(flagKey("big", V5)), "the current version's own flag survives the sweep");
    const scheduler = manualScheduler();
    const bumped = { artifact: 6, resultBlock: 2 };
    const started = startResumableEnrichment({
      store, sessions: [{ id: "big", projectId: "p", updatedAt: 1 }], schedule: scheduler.schedule,
      workspacePathFor: () => WORKSPACE, backfill: () => false, versions: bumped, batchSize: 500,
    });
    assert.equal(started.pending, 1, "a bumped schema re-queues the session");
  });

  check("never worse than baseline: no bounded read, no workspace, or a throwing backfill all fail open", () => {
    const noSlice = startResumableEnrichment({
      store: { messageSlice: undefined }, sessions: [{ id: "big" }], schedule: () => {},
      workspacePathFor: () => WORKSPACE, backfill, versions: V5,
    });
    assert.equal(noSlice.reason, "NO_BOUNDED_READ", "an older store gets no enrichment rather than an unbounded one");

    store.deleteMeta(flagKey("small", V5));
    const scheduler = manualScheduler();
    startResumableEnrichment({
      store, sessions: [{ id: "small", projectId: "p", updatedAt: 1 }], schedule: scheduler.schedule,
      workspacePathFor: () => "", backfill, versions: V5, batchSize: 40,
    });
    scheduler.runTicks(10);
    assert.equal(store.meta(flagKey("small", V5)), null, "a session with no workspace is left for a later launch, not flagged");

    // Contract change, 2026-09-18: a throwing backfill used to abandon the whole
    // session with its cursor unpersisted, so every launch re-read the same slice
    // and failed on the same record — that session was never enriched again.
    // Failure is now per record: the bad one keeps its stored artifacts (the
    // baseline) and the rest of the history still gets done.
    store.deleteMeta(flagKey("small", V5));
    store.deleteMeta(cursorKey("small", V5));
    const thrower = manualScheduler();
    let summary = null;
    startResumableEnrichment({
      store, sessions: [{ id: "small", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }], schedule: thrower.schedule,
      workspacePathFor: () => WORKSPACE, backfill: () => { throw new Error("boom"); }, versions: V5, batchSize: 40,
      onDone: (s) => { summary = s; },
    });
    thrower.runTicks(10);
    assert.ok(store.meta(flagKey("small", V5)), "the session still completes rather than retrying the same record every launch");
    assert.equal(summary.skipped, 7, "every skip is counted");
    assert.equal(summary.enriched, 0, "and nothing is claimed as enriched");
  });

  check("an oversized record gets a tick to itself and the read reports size without inflating", () => {
    assert.ok(BIG_RECORD_BYTES > 0);
    const rows = store.messageSlice("small", 0, 5);
    assert.ok(rows.every((row) => Number.isFinite(row.bytes) && row.bytes > 0), "every row carries its compressed size");

    // A slice where row #3 is pathological: the first two are processed, then
    // the slice ends so the big one starts the next tick alone.
    store.deleteMeta(flagKey("wide", V5));
    store.deleteMeta(cursorKey("wide", V5));
    seed("wide", 6);
    const order = [];
    const patched = store.messageSlice.bind(store);
    store.messageSlice = (sessionId, after, limit) => patched(sessionId, after, limit)
      .map((row, i) => ({ seq: row.seq, bytes: i === 2 ? BIG_RECORD_BYTES + 1 : 100, get message() { return row.message; } }));
    try {
      const first = enrichSessionSlice({
        store, sessionId: "wide", workspacePath: WORKSPACE, versions: V5, batchSize: 6,
        backfill: (message) => { order.push(message.id); return false; },
      });
      assert.equal(first.scanned, 2, `the slice stops before the oversized record: ${first.scanned}`);
      assert.equal(first.done, false, "and the session is not finished");
      const second = enrichSessionSlice({
        store, sessionId: "wide", workspacePath: WORKSPACE, versions: V5, batchSize: 6,
        backfill: (message) => { order.push(message.id); return false; },
      });
      assert.ok(second.scanned >= 1, "the next tick starts with it");
      assert.equal(order[2], "wide-m2", "and it is the one that was deferred, in order");
      assert.equal(new Set(order).size, order.length, "nothing is processed twice across the boundary");
    } finally {
      store.messageSlice = patched;
    }
  });

  check("a slice that cannot advance its cursor stops the session instead of spinning forever", () => {
    // Every key and the resume itself hang off the sequence number. A row whose
    // seq cannot be read would leave the cursor where it was, so the next tick
    // reads the same rows — a busy loop for the life of the process.
    store.deleteMeta(flagKey("small", V5));
    store.deleteMeta(cursorKey("small", V5));
    const real = store.messageSlice.bind(store);
    store.messageSlice = (sid, after, limit) => real(sid, after, limit)
      .map((row) => (sid === "small" ? { seq: undefined, bytes: row.bytes, get message() { return row.message; } } : row));
    try {
      const slice = enrichSessionSlice({ store, sessionId: "small", workspacePath: WORKSPACE, versions: V5, batchSize: 3, backfill: () => true });
      assert.equal(slice.stalled, true, "the slice reports that it could not advance");
      assert.equal(slice.done, true, "and asks the scheduler to move on");
      assert.equal(store.meta(flagKey("small", V5)), null, "without claiming the session is finished");
      assert.equal(store.meta(cursorKey("small", V5)), null, "and without writing a cursor that would not move");

      store.deleteMeta(flagKey("tail", V5));
      seed("tail", 3);
      const scheduler = manualScheduler();
      let ticks = 0;
      startResumableEnrichment({
        store,
        sessions: [{ id: "small", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }, { id: "tail", projectId: "p", updatedAt: "2026-09-17T00:00:00.000Z" }],
        schedule: scheduler.schedule, workspacePathFor: () => WORKSPACE, versions: V5, batchSize: 3, backfill: () => false,
      });
      while (scheduler.depth && ticks < 200) { scheduler.runTicks(1); ticks += 1; }
      assert.ok(ticks < 200, `the scheduler terminates: ${ticks} ticks`);
      assert.ok(store.meta(flagKey("tail", V5)), "and the next session is still worked — one bad session is not contagious");
    } finally {
      store.messageSlice = real;
    }
  });

  check("missing schema versions refuse to build or delete a single key", () => {
    // Keys embed both versions, so a missing one yields "aundefined:bundefined":
    // no live cursor matches it, the sweep would delete every one of them, and
    // every session would re-queue from zero — the exact restart-forever
    // behaviour this module exists to remove.
    assert.equal(versionsUsable(V5), true);
    assert.equal(versionsUsable({ artifact: 5 }), false, "half a version is not a version");
    assert.equal(versionsUsable({}), false);
    assert.equal(versionsUsable(null), false);
    assert.equal(versionsUsable({ artifact: "5", resultBlock: "2" }), true, "strings are fine — they are only key material");
    assert.equal(versionsUsable({ artifact: Number.NaN, resultBlock: 2 }), false);

    store.setMeta(cursorKey("big", V5), "40");
    assert.equal(sweepStaleCursors(store, {}), 0, "a malformed version sweeps nothing");
    assert.equal(store.meta(cursorKey("big", V5)), "40", "the live cursor is untouched");
    assert.equal(startResumableEnrichment({
      store, sessions: [{ id: "big", projectId: "p" }], schedule: () => {},
      workspacePathFor: () => WORKSPACE, backfill: () => false, versions: {},
    }).reason, "NO_SCHEMA_VERSIONS");
    const refused = enrichSessionSlice({ store, sessionId: "big", workspacePath: WORKSPACE, versions: {}, batchSize: 5, backfill: () => true });
    assert.equal(refused.reason, "NO_SCHEMA_VERSIONS");
    assert.equal(refused.enriched, 0);
    store.deleteMeta(cursorKey("big", V5));
  });

  check("one unreadable record is skipped, not allowed to cost the session its remaining history", () => {
    store.deleteMeta(flagKey("poison", V5));
    store.deleteMeta(cursorKey("poison", V5));
    seed("poison", 6);
    const seen = [];
    const scheduler = manualScheduler();
    let summary = null;
    startResumableEnrichment({
      store, sessions: [{ id: "poison", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }],
      schedule: scheduler.schedule, workspacePathFor: () => WORKSPACE, versions: V5, batchSize: 4,
      backfill: (message) => { seen.push(message.id); if (message.id === "poison-m2") throw new Error("corrupt envelope"); return false; },
      onDone: (s) => { summary = s; },
    });
    scheduler.runTicks(60);
    assert.deepEqual(seen, ["poison-m0", "poison-m1", "poison-m2", "poison-m3", "poison-m4", "poison-m5"], `the pass walks past the bad record: ${seen.join(",")}`);
    assert.ok(store.meta(flagKey("poison", V5)), "and the session finishes");
    assert.equal(summary?.skipped, 1, "the skip is counted, not swallowed");
  });

  check("a pathological record does not teach the cost controller about ordinary ones", () => {
    store.deleteMeta(flagKey("wide", V5));
    store.deleteMeta(cursorKey("wide", V5));
    const real = store.messageSlice.bind(store);
    store.messageSlice = (sid, after, limit) => real(sid, after, limit)
      .map((row) => ({ seq: row.seq, bytes: BIG_RECORD_BYTES + 1, get message() { return row.message; } }));
    try {
      let visited = 0;
      let summary = null;
      const scheduler = manualScheduler();
      startResumableEnrichment({
        store, sessions: [{ id: "wide", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }],
        schedule: scheduler.schedule, workspacePathFor: () => WORKSPACE, versions: V5,
        batchSize: 40, backfill: () => { visited += 1; return false; },
        // Every record "costs" 900 ms, far over the budget.
        now: () => visited * 900, onDone: (s) => { summary = s; },
      });
      scheduler.runTicks(60);
      assert.equal(summary.costMs, 0, "an oversized slice contributes no cost sample");
      assert.equal(summary.batchSize, 40, `so the batch is not dragged to the floor by it: ${summary.batchSize}`);
    } finally {
      store.messageSlice = real;
    }
  });

  check("the oversized threshold is measured too, not a number from the developer's machine", () => {
    assert.equal(nextBigRecordBytes(0), BIG_RECORD_BYTES, "until something is measured, the documented default");
    // Cost per byte on the machine this was written on is ~1e-4 ms; a 50 ms tick
    // therefore holds about half a megabyte.
    assert.ok(Math.abs(nextBigRecordBytes(0.0001, 50) - 500_000) < 60_000, nextBigRecordBytes(0.0001, 50));
    assert.ok(nextBigRecordBytes(0.001, 50) < nextBigRecordBytes(0.0001, 50), "a slower machine isolates smaller records");
    assert.equal(nextBigRecordBytes(1, 50), MIN_BIG_RECORD_BYTES, "clamped below");
    assert.equal(nextBigRecordBytes(1e-9, 50), MAX_BIG_RECORD_BYTES, "clamped above");
    assert.equal(observeByteCost(0, 0, 900), 0, "a slice with no bytes is not a sample");
    assert.equal(observeByteCost(0, 1000, 50), 0.05);

    // End to end: a machine 10x slower than this one converges to a smaller
    // threshold than the default it started from.
    store.deleteMeta(flagKey("big", V5));
    store.deleteMeta(cursorKey("big", V5));
    let visited = 0;
    let summary = null;
    const scheduler = manualScheduler();
    startResumableEnrichment({
      store, sessions: [{ id: "big", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }],
      schedule: scheduler.schedule, workspacePathFor: () => WORKSPACE, versions: V5, batchSize: 40,
      backfill: () => { visited += 1; return false; },
      now: () => visited * 8, onDone: (s) => { summary = s; },
    });
    scheduler.runTicks(4000);
    assert.ok(summary.costPerByteMs > 0, "a byte cost was measured");
    assert.ok(summary.bigRecordBytes < BIG_RECORD_BYTES, `and it moved the threshold off the default: ${summary.bigRecordBytes}`);
    assert.ok(summary.bigRecordBytes >= MIN_BIG_RECORD_BYTES, "never below the floor");
  });

  check("the kill switch leaves records on their stored artifacts, the pre-backfill baseline", () => {
    store.deleteMeta(flagKey("small", V5));
    process.env.LILY_SESSION_ENRICHMENT = "0";
    try {
      const off = startResumableEnrichment({
        store, sessions: [{ id: "small", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }],
        schedule: () => { throw new Error("must not schedule"); },
        workspacePathFor: () => WORKSPACE, backfill: () => true, versions: V5,
      });
      assert.equal(off.reason, "DISABLED");
      assert.equal(off.pending, 0);
      assert.equal(store.meta(flagKey("small", V5)), null, "and nothing is marked done");
    } finally {
      delete process.env.LILY_SESSION_ENRICHMENT;
    }
  });

  check("progress is reported in messages, and a resumed launch counts only what is left", () => {
    store.deleteMeta(flagKey("small", V5));
    store.deleteMeta(cursorKey("small", V5));
    const events = [];
    const scheduler = manualScheduler();
    startResumableEnrichment({
      store, sessions: [{ id: "small", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }],
      schedule: scheduler.schedule, workspacePathFor: () => WORKSPACE, versions: V5, batchSize: 3,
      backfill: () => false, onProgress: (payload) => events.push(payload),
    });
    scheduler.runTicks(40);
    assert.equal(events[0].total, 7, "the unit is messages — a 1450-message conversation is exactly the case a session counter would not move for");
    assert.equal(events[0].kind, "enrichment", "the renderer picks its wording from the kind");
    assert.ok(events.every((e, i) => i === 0 || e.done >= events[i - 1].done), "done never goes backwards");
    assert.equal(events[events.length - 1].phase, "done");
    assert.equal(events[events.length - 1].done, 7);

    // Resume: three messages are already behind the cursor, so the bar must
    // start from the remaining four rather than re-announcing the whole session.
    store.deleteMeta(flagKey("small", V5));
    store.setMeta(cursorKey("small", V5), "3");
    const resumed = [];
    const later = manualScheduler();
    const started = startResumableEnrichment({
      store, sessions: [{ id: "small", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }],
      schedule: later.schedule, workspacePathFor: () => WORKSPACE, versions: V5, batchSize: 3,
      backfill: () => false, onProgress: (payload) => resumed.push(payload),
    });
    assert.equal(started.total, 4, `a resumed pass counts only the tail: ${started.total}`);
    later.runTicks(40);
    assert.equal(resumed[resumed.length - 1].done, 4);

    // A progress listener is never allowed to affect the work.
    store.deleteMeta(flagKey("small", V5));
    store.deleteMeta(cursorKey("small", V5));
    const hostile = manualScheduler();
    startResumableEnrichment({
      store, sessions: [{ id: "small", projectId: "p", updatedAt: "2026-09-18T00:00:00.000Z" }],
      schedule: hostile.schedule, workspacePathFor: () => WORKSPACE, versions: V5, batchSize: 3,
      backfill: () => false, onProgress: () => { throw new Error("listener blew up"); },
    });
    hostile.runTicks(40);
    assert.ok(store.meta(flagKey("small", V5)), "a throwing listener does not stop the pass");
  });

  check("the bounded read pages without gaps or overlap and clamps its limit", () => {
    const seen = [];
    let cursor = 0;
    for (;;) {
      const rows = store.messageSlice("small", cursor, 3);
      if (!rows.length) break;
      for (const row of rows) seen.push(row.seq);
      cursor = rows[rows.length - 1].seq;
    }
    assert.equal(seen.length, 7);
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "slices arrive in sequence order");
    assert.equal(new Set(seen).size, 7, "no row is returned twice");
    assert.equal(store.messageSlice("small", 0, 10_000).length, 7);
    assert.equal(store.messageSlice("small", 0, 0).length, 7, "a nonsense limit falls back to the bounded default, never to unbounded");
    assert.equal(store.messageSlice("small", -5, 3).length, 3, "a nonsense cursor reads from the head");
  });

  console.log(`\n${checks} checks passed (resumable enrichment)`);
} finally {
  store.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
