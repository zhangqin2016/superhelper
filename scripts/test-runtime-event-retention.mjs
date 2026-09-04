#!/usr/bin/env node
/**
 * Deleting a conversation must delete its runtime events.
 *
 * Runtime events were INSERTed and UPDATEd but never DELETEd anywhere in the
 * repo, and clearing a session removed only its messages. Every deleted
 * conversation therefore left its entire event stream behind permanently.
 *
 * Measured on a real install 2026-09-04: a 12 GB messages.db holding 1,156
 * messages and 3,917,891 runtime events across 155 sessions, while only 29
 * sessions still had messages — 2,542,720 events (64.9%) orphaned from 135
 * deleted conversations. Nearly all of it is per-token streaming telemetry
 * (process.event, task.step.progress, assistant.thinking.delta) with no
 * consumer once the turn ends.
 *
 * Safe by construction: the only reader, getRuntimeEvents, is always scoped to
 * a session id, so events belonging to a session that no longer exists cannot
 * affect anything live.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-retention-"));
process.env.LILY_USER_DATA_DIR ||= userData;
process.env.LILY_HOME ||= userData;
process.on("exit", () => fs.rmSync(userData, { recursive: true, force: true }));

const { MessageStore } = require("../src/main/store/message-store.js");
const store = new MessageStore(path.join(userData, "messages.db"));

function events(sessionId, count, type, startSeq = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${sessionId}-${type}-${i}`,
    seq: startSeq + i,
    turnId: `t-${sessionId}`,
    type,
    source: "engine",
    ts: Date.now(),
    payload: { chunk: `x${i}` },
  }));
}

function seed(sessionId, count) {
  store.append(sessionId, { role: "user", content: `hello ${sessionId}`, turnId: `t-${sessionId}` });
  store.appendRuntimeEvents(sessionId, events(sessionId, count, "assistant.thinking.delta"));
}

seed("keep", 30);
seed("gone", 40);
assert.equal(store.getRuntimeEvents("keep", { limit: 2000 }).length, 30, "seeded events must be readable");
assert.equal(store.countOrphanRuntimeEvents(), 0, "both sessions still have messages, so nothing is orphaned yet");

// --- clearing a session takes its events with it -------------------------
store.clear("gone");
assert.equal(store.getRuntimeEvents("gone", { limit: 2000 }).length, 0, "a cleared session must keep no runtime events");
assert.equal(
  store.getRuntimeEvents("keep", { limit: 2000 }).length,
  30,
  "clearing one session must not touch another session's events",
);
assert.equal(store.countOrphanRuntimeEvents(), 0, "clear must not leave its own events behind as orphans");

// --- the existing backlog can be worked off ------------------------------
// Events with no message at all: exactly the shape 135 deleted sessions left.
store.appendRuntimeEvents("never-had-messages", events("never-had-messages", 25, "task.step.progress"));
store.appendRuntimeEvents("also-orphaned", events("also-orphaned", 12, "process.event"));
assert.equal(store.countOrphanRuntimeEvents(), 37, "events for sessions with no messages must count as orphans");

// Bounded BY SESSION, because orphans always belong to whole deleted
// conversations. The first version deleted row by row: 20,000 synchronous
// statements per round on the main process froze the UI for two minutes after
// startup on a real 12 GB install. Whole-session deletes do the same work in a
// handful of statements.
const firstPass = store.pruneOrphanRuntimeEvents({ maxSessions: 1 });
assert.ok(firstPass > 0, "a pass must remove something when there is a backlog");
assert.equal(
  store.countOrphanRuntimeEvents(),
  37 - firstPass,
  "one round must clear exactly the sessions it took and leave the rest for the next",
);
assert.ok(
  store.countOrphanRuntimeEvents() > 0,
  "maxSessions must bound a round, so a large backlog spreads across rounds instead of blocking one",
);
const rest = store.pruneOrphanRuntimeEvents({ maxSessions: 10 });
assert.equal(rest, 37 - firstPass, "a later pass must finish the backlog");
assert.equal(store.countOrphanRuntimeEvents(), 0, "the backlog must reach zero");
assert.equal(store.pruneOrphanRuntimeEvents({ maxSessions: 10 }), 0, "pruning an empty backlog must be a no-op, not an error");

// The regression that caused the freeze must not come back: no per-row delete.
const retention = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src/main/store/runtime-event-retention.js"),
  "utf8",
);
const pruneSource = retention.slice(retention.indexOf("function pruneOrphanRuntimeEvents"), retention.indexOf("function countOrphanRuntimeEvents"));
assert.doesNotMatch(
  pruneSource,
  /DELETE FROM runtime_events WHERE session_id = \? AND seq = \?/,
  "pruning must delete whole sessions, never row by row — node:sqlite is synchronous on the main process",
);
assert.match(pruneSource, /DELETE FROM runtime_events WHERE session_id = \?`/, "the prune must issue one statement per session");

// --- a live session is never touched ------------------------------------
assert.equal(
  store.getRuntimeEvents("keep", { limit: 2000 }).length,
  30,
  "pruning must never remove events of a session that still has messages",
);

// --- wired into startup maintenance -------------------------------------
// A prune method nothing calls is the same defect as a message nothing renders,
// so assert the whole chain: the loop schedules it, and something starts the loop.
const ROOT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const maintenance = fs.readFileSync(path.join(ROOT_DIR, "src/main/store/runtime-event-maintenance.js"), "utf8");
assert.match(maintenance, /pruneOrphanRuntimeEvents\(\{[\s\S]{0,120}maxSessions: ORPHAN_SESSION_BATCH/, "the prune must actually be scheduled, bounded by session");
assert.match(maintenance, /rounds < MAX_ROUNDS/, "maintenance must keep going while there is still a backlog to work off, and stop at a bound");
assert.match(maintenance, /prunedHistory > 0\) && rounds < MAX_ROUNDS/, "an unfinished historical drain must schedule another round");
const wiring = maintenance.slice(maintenance.indexOf("pruneOrphanRuntimeEvents"));
assert.match(wiring.slice(0, 500), /catch \(pruneErr\)/, "pruning must be fail-open — maintenance must never break startup");

const manager = fs.readFileSync(path.join(ROOT_DIR, "src/main/session-manager.js"), "utf8");
assert.match(manager, /startRuntimeEventMaintenance\(\{/, "the extracted loop must still be started by the session manager");
assert.match(manager, /require\("\.\/store\/runtime-event-maintenance"\)/, "and imported from its new home");

// The maintenance loop must be drivable without a session manager, which is
// what the extraction bought — verify it actually runs both jobs.
{
  const { startRuntimeEventMaintenance } = require("../src/main/store/runtime-event-maintenance.js");
  const calls = [];
  let pending = [];
  startRuntimeEventMaintenance({
    store: () => ({
      pruneHistoricalEphemeralEvents: () => ({ done: true, removed: 0, chunks: 0 }),
      pruneOrphanRuntimeEvents: ({ limit, maxSessions }) => { calls.push(`prune:${limit}/${maxSessions}`); return 0; },
      compactRuntimeEventPayloads: () => { calls.push("compact"); return { compacted: 0 }; },
    }),
    schedule: (fn, delay) => { pending.push([fn, delay]); },
  });
  assert.equal(pending.length, 1, "starting maintenance must schedule exactly one first round");
  const [firstFn, firstDelay] = pending.pop();
  assert.ok(firstDelay >= 1000, "the first round must be deferred so it never competes with startup");

  // Default: the backlog prune must NOT run. Discovering orphans costs a full
  // scan of the event table (2.8-3.1 s measured on a real 12 GB install) and
  // node:sqlite is synchronous on the main process — doing that at startup is
  // what froze the UI for two minutes.
  delete process.env.LILY_PRUNE_ORPHAN_EVENTS;
  firstFn();
  assert.deepEqual(calls, ["compact"], "by default a startup must only compact payloads, never scan for orphans");

  // Opt-in: both bounds applied, and orphans before payloads.
  calls.length = 0;
  process.env.LILY_PRUNE_ORPHAN_EVENTS = "1";
  firstFn();
  assert.deepEqual(calls, ["prune:20000/4", "compact"], "when opted in, orphans must be pruned BEFORE payloads, with both bounds applied");
  delete process.env.LILY_PRUNE_ORPHAN_EVENTS;
  assert.equal(pending.length, 0, "with no work found, maintenance must stop instead of spinning");
}

// --- growth is stopped at the source ------------------------------------
// The backlog only existed because nothing deleted a turn's live-painting
// events when the turn ended. Measured: 98.2% of the events of sessions that
// still exist. This is the fix that means customers never accumulate.
{
  const { EPHEMERAL_EVENT_TYPES } = require("../src/main/store/runtime-event-retention.js");
  const S = "turnprune";
  store.append(S, { role: "user", content: "do the thing", turnId: "T1" });

  let seq = 1;
  const push = (type, count = 1) => {
    store.appendRuntimeEvents(S, Array.from({ length: count }, (_, i) => ({
      id: `${type}-${seq + i}`, seq: seq + i, turnId: "T1", type,
      source: "engine", ts: Date.now(), payload: { text: "x" },
    })));
    seq += count;
  };

  for (const type of EPHEMERAL_EVENT_TYPES) push(type, 20);
  // Structural events that must SURVIVE — they are not in the allowlist.
  push("tool.started");
  push("tool.done");
  push("task.evidence.added");
  const beforeCount = store.getRuntimeEvents(S, { limit: 2000 }).length;
  assert.equal(beforeCount, EPHEMERAL_EVENT_TYPES.length * 20 + 3, "seeded events must all be present while the turn runs");

  // The terminal event ends the turn and triggers the prune in the same write.
  push("turn.completed");

  const after = store.getRuntimeEvents(S, { limit: 2000 });
  const types = after.map((e) => e.type);
  for (const type of EPHEMERAL_EVENT_TYPES) {
    assert.ok(!types.includes(type), `${type} paints a running turn and must be gone once it ends`);
  }
  // Load-bearing survivors. The history query rebuilds assistant text from the
  // terminal payload, so deleting it would silently empty past turns.
  assert.ok(types.includes("turn.completed"), "the terminal event MUST survive — getProjectedConversation rebuilds assistant text from it");
  for (const type of ["tool.started", "tool.done", "task.evidence.added"]) {
    assert.ok(types.includes(type), `${type} is not in the ephemeral allowlist and must survive`);
  }
  assert.equal(after.filter((e) => e.turnId === "T1").length, 4, "exactly the three structural events plus the terminal one remain for T1");

  // Scoping. Both of these are set up so the assertion actually BITES:
  //   - another session with an event on the SAME turn id being pruned, so a
  //     query missing `session_id = ?` is caught;
  //   - a second, still-running turn in the SAME session, so a query missing
  //     `turn_id = ?` is caught.
  // An earlier version used a different turn id for the other session and had
  // no concurrent turn, so dropping either predicate passed the gate.
  store.append("other-session", { role: "user", content: "hi", turnId: "T9" });
  store.appendRuntimeEvents("other-session", [
    { id: "o1", seq: 1, turnId: "T9", type: "assistant.delta", source: "engine", ts: Date.now(), payload: {} },
  ]);
  // A second turn in S that is still running when T9 finalizes elsewhere.
  store.appendRuntimeEvents(S, [
    { id: "s-t9-a", seq: seq + 1, turnId: "T9", type: "assistant.delta", source: "engine", ts: Date.now(), payload: {} },
    { id: "s-t9-b", seq: seq + 2, turnId: "T9", type: "process.event", source: "engine", ts: Date.now(), payload: {} },
    { id: "s-run-a", seq: seq + 3, turnId: "T_RUNNING", type: "assistant.delta", source: "engine", ts: Date.now(), payload: {} },
    { id: "s-run-b", seq: seq + 4, turnId: "T_RUNNING", type: "task.step.progress", source: "engine", ts: Date.now(), payload: {} },
  ]);
  seq += 4;

  // Finalize T9 in session S only.
  store.appendRuntimeEvents(S, [
    { id: "s-t9-term", seq: seq + 1, turnId: "T9", type: "turn.completed", source: "engine", ts: Date.now(), payload: {} },
  ]);

  const sAfter = store.getRuntimeEvents(S, { limit: 2000 });
  const running = sAfter.filter((e) => e.turnId === "T_RUNNING");
  assert.equal(
    running.length,
    2,
    "a turn still RUNNING in the same session must keep its events — the delete must be scoped by turn_id",
  );
  assert.equal(
    sAfter.filter((e) => e.turnId === "T9" && e.type !== "turn.completed").length,
    0,
    "the finalized turn's ephemerals must be gone",
  );
  assert.equal(
    store.getRuntimeEvents("other-session", { limit: 100 }).length,
    1,
    "another session's event on the SAME turn id must survive — the delete must be scoped by session_id",
  );

  // Kill switch.
  process.env.LILY_PRUNE_TURN_EVENTS = "0";
  const S2 = "killswitch";
  store.append(S2, { role: "user", content: "x", turnId: "T1" });
  store.appendRuntimeEvents(S2, [
    { id: "k1", seq: 1, turnId: "T1", type: "assistant.delta", source: "engine", ts: Date.now(), payload: {} },
    { id: "k2", seq: 2, turnId: "T1", type: "turn.completed", source: "engine", ts: Date.now(), payload: {} },
  ]);
  assert.equal(store.getRuntimeEvents(S2, { limit: 100 }).length, 2, "the kill switch must keep the previous behaviour");
  delete process.env.LILY_PRUNE_TURN_EVENTS;

  // The allowlist must never contain a type the history query depends on.
  for (const terminal of ["turn.completed", "turn.failed", "turn.interrupted", "turn.stalled", "turn.dispatch_outcome_unknown", "turn.dispatch_blocked"]) {
    assert.ok(
      !EPHEMERAL_EVENT_TYPES.includes(terminal),
      `${terminal} is JOINed by getProjectedConversation; putting it in the ephemeral allowlist would empty past turns`,
    );
  }
}

// --- the historical backlog drains silently ------------------------------
// The obvious DELETE ... WHERE type IN (...) is a full table SCAN (nothing
// indexes `type`): a single 19.8-second block on a real 12 GB install, on a
// synchronous main-process connection. Bounding by the PRIMARY KEY makes each
// chunk an index range scan — 30 ms per 20,000-seq window measured — so the
// same work lands 30 ms at a time.
{
  const { HISTORY_CURSOR_KEY } = require("../src/main/store/runtime-event-retention.js");
  const sessions = ["h-a", "h-b", "h-c"];
  for (const id of sessions) {
    store.append(id, { role: "user", content: "x", turnId: "T" });
    // Ephemeral rows plus structural ones that must survive, interleaved.
    const rows = [];
    for (let i = 1; i <= 60; i += 1) {
      rows.push({
        id: `${id}-${i}`, seq: i, turnId: "T",
        type: i % 5 === 0 ? "tool.done" : "assistant.thinking.delta",
        source: "engine", ts: Date.now(), payload: { i },
      });
    }
    store.appendRuntimeEvents(id, rows);
  }
  // Also an orphan session: the drain must cover it WITHOUT any NOT EXISTS scan.
  store.appendRuntimeEvents("h-orphan", Array.from({ length: 30 }, (_, i) => ({
    id: `ho-${i}`, seq: i + 1, turnId: "T", type: "process.event",
    source: "engine", ts: Date.now(), payload: {},
  })));

  const totalBefore = sessions.reduce((n, id) => n + store.getRuntimeEvents(id, { limit: 500 }).length, 0)
    + store.getRuntimeEvents("h-orphan", { limit: 500 }).length;
  assert.equal(totalBefore, 3 * 60 + 30, "fixture must be fully seeded");

  // One bounded round must NOT finish everything — that is what keeps it silent.
  const first = store.pruneHistoricalEphemeralEvents({ maxChunks: 1, seqWindow: 1_000 });
  assert.ok(first.removed > 0, "a round must make progress");
  assert.equal(first.done, false, "one bounded round must not claim completion");
  assert.equal(first.chunks, 1, "maxChunks must bound the round");

  // Resumes from the cursor across calls (and therefore across restarts).
  const cursorAfterFirst = store.meta(HISTORY_CURSOR_KEY);
  assert.ok(cursorAfterFirst && cursorAfterFirst !== "done", "progress must be persisted, not restarted each time");

  let guard = 0;
  let result = first;
  while (!result.done && guard < 200) {
    result = store.pruneHistoricalEphemeralEvents({ maxChunks: 2, seqWindow: 1_000 });
    guard += 1;
  }
  assert.equal(result.done, true, `the drain must finish; stopped after ${guard} rounds`);
  assert.equal(store.meta(HISTORY_CURSOR_KEY), "done", "completion must be recorded");

  // Only the allowlist went. Structural rows and the orphan's non-ephemeral
  // rows are untouched.
  for (const id of sessions) {
    const left = store.getRuntimeEvents(id, { limit: 500 });
    assert.equal(left.length, 12, `${id}: the 12 tool.done rows must survive`);
    assert.ok(left.every((e) => e.type === "tool.done"), `${id}: only structural rows may remain`);
  }
  assert.equal(
    store.getRuntimeEvents("h-orphan", { limit: 500 }).length,
    0,
    "an orphaned session's ephemerals drain here too — no NOT EXISTS scan needed",
  );

  // Finished means finished: no further work, and no re-scanning forever.
  const after = store.pruneHistoricalEphemeralEvents({ maxChunks: 8 });
  assert.deepEqual(after, { done: true, removed: 0, chunks: 0 }, "a finished drain must become a no-op");

  // The whole design is the QUERY SHAPE, and behaviour alone cannot see it: a
  // full-table `type IN (...)` delete removes the same rows, just in one
  // 19.8-second block. Assert the delete is bounded by the primary key, and
  // verify with the planner that this really is an index range scan.
  {
    const source = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src/main/store/runtime-event-retention.js"),
      "utf8",
    );
    const fn = source.slice(source.indexOf("function pruneHistoricalEphemeralEvents"), source.indexOf("function countOrphanRuntimeEvents"));
    assert.match(
      fn,
      /DELETE FROM runtime_events\s*\n\s*WHERE session_id = \? AND seq >= \? AND seq < \? AND type IN/,
      "the drain must bound each chunk by session_id and a seq range — a type-only DELETE is a full table scan",
    );
    const plan = store.explainRuntimeEventChunkPlan?.();
    if (plan) {
      assert.match(plan, /USING INDEX/, `each chunk must use an index, got: ${plan}`);
      assert.doesNotMatch(plan, /^SCAN runtime_events$/m, "a full table SCAN is the thing this design exists to avoid");
    }
  }

  // Kill switch.
  store.setMeta(HISTORY_CURSOR_KEY, "");
  process.env.LILY_PRUNE_EVENT_HISTORY = "0";
  assert.deepEqual(
    store.pruneHistoricalEphemeralEvents({ maxChunks: 4 }),
    { done: true, removed: 0, chunks: 0 },
    "the kill switch must stop the drain",
  );
  delete process.env.LILY_PRUNE_EVENT_HISTORY;
}

// --- the maintenance loop drains history BEFORE anything else ------------
{
  const { startRuntimeEventMaintenance } = require("../src/main/store/runtime-event-maintenance.js");
  const calls = [];
  const pending = [];
  startRuntimeEventMaintenance({
    store: () => ({
      pruneHistoricalEphemeralEvents: ({ maxChunks }) => { calls.push(`history:${maxChunks}`); return { done: false, removed: 0, chunks: 0 }; },
      pruneOrphanRuntimeEvents: () => { calls.push("orphan"); return 0; },
      compactRuntimeEventPayloads: () => { calls.push("compact"); return { compacted: 0 }; },
    }),
    schedule: (fn, delay) => pending.push([fn, delay]),
  });
  const [fn] = pending.pop();
  delete process.env.LILY_PRUNE_ORPHAN_EVENTS;
  fn();
  assert.deepEqual(
    calls,
    ["history:4", "compact"],
    "the default round drains history then compacts payloads, and never runs the superseded orphan scan",
  );
}

console.log("runtime event retention: ok");
console.log("  clearing a session drops its events; orphan backlog prunes in bounded passes");
console.log("  a session that still has messages is never touched");
