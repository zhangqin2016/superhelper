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
assert.equal(store.countOrphanRuntimeEvents(), 25, "events for a session with no messages must count as orphans");

const firstPass = store.pruneOrphanRuntimeEvents({ limit: 10 });
assert.equal(firstPass, 10, "pruning must respect its bound so a huge backlog cannot block a startup");
assert.equal(store.countOrphanRuntimeEvents(), 15, "a bounded pass must leave the rest for the next one");
const rest = store.pruneOrphanRuntimeEvents({ limit: 1000 });
assert.equal(rest, 15, "a later pass must finish the backlog");
assert.equal(store.countOrphanRuntimeEvents(), 0, "the backlog must reach zero");
assert.equal(store.pruneOrphanRuntimeEvents({ limit: 1000 }), 0, "pruning an empty backlog must be a no-op, not an error");

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
assert.match(maintenance, /pruneOrphanRuntimeEvents\(\{ limit: ORPHAN_BATCH_SIZE \}\)/, "the prune must actually be scheduled, with a bound");
assert.match(maintenance, /prunedOrphans > 0\) && rounds < MAX_ROUNDS/, "maintenance must keep going while there is still a backlog to work off");
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
      pruneOrphanRuntimeEvents: ({ limit }) => { calls.push(`prune:${limit}`); return 0; },
      compactRuntimeEventPayloads: () => { calls.push("compact"); return { compacted: 0 }; },
    }),
    schedule: (fn, delay) => { pending.push([fn, delay]); },
  });
  assert.equal(pending.length, 1, "starting maintenance must schedule exactly one first round");
  const [firstFn, firstDelay] = pending.pop();
  assert.ok(firstDelay >= 1000, "the first round must be deferred so it never competes with startup");
  firstFn();
  assert.deepEqual(calls, ["prune:20000", "compact"], "orphans must be pruned BEFORE payloads are compacted, with the bound applied");
  assert.equal(pending.length, 0, "with no work found, maintenance must stop instead of spinning");
}

console.log("runtime event retention: ok");
console.log("  clearing a session drops its events; orphan backlog prunes in bounded passes");
console.log("  a session that still has messages is never touched");
