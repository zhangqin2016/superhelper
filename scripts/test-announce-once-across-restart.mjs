#!/usr/bin/env node
/**
 * A turn whose outcome is unknown is announced ONCE, not once per restart.
 *
 * When the app restarts mid-turn it closes what was in flight as
 * "outcome unknown" and asks the user to re-send, deliberately without an
 * automatic retry. That part is fine. What was not: the guard against
 * announcing the same turn twice lived only in memory, and the thing it had to
 * survive was a restart — which empties it. Nothing moved the row out of its
 * dispatch status either, so every restart rediscovered every past unknown
 * outcome as if it were new.
 *
 * Measured on a real machine 2026-09-17: 228 announcements for 10 turns; one
 * turn from 09-01 re-announced 52 times across four days, each restart telling
 * the user to re-send something from a conversation they had long finished.
 *
 * [gate: announce-once-across-restart]
 * Run: node scripts/test-announce-once-across-restart.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");
const { createTurnQueueRecoveryMethods } = require("../src/main/turn-queue-recovery.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-announce-once-"));
const SESSION = "s-restart";
const OWNER = "profile:account:owner-a";

function admitInFlight(store, turnId, text) {
  store.db.run(
    `INSERT INTO turn_inputs (session_id, admitted_seq, turn_id, delivery, status, user_text,
        files_json, metadata_json, created_at, owner_scope, migration_status, migration_reason)
     VALUES (?, (SELECT COALESCE(MAX(admitted_seq), 0) + 1 FROM turn_inputs WHERE session_id = ?),
        ?, 'direct', 'promoted', ?, '[]', '{}', ?, ?, 'owned', 'owned')`,
    SESSION, SESSION, turnId, text, Date.now(), OWNER,
  );
}

/** One app run: fresh in-memory state, same durable store. */
function bootRun(store) {
  const emitted = [];
  const states = new Map();
  const host = {
    ctx: {
      sessionManager: {
        outcomeUnknownTurnInputs: () => store.outcomeUnknownTurnInputs(SESSION, OWNER),
        markTurnInputOutcomeUnknown: (sessionId, turnId) =>
          store.markTurnInputOutcomeUnknown(sessionId, turnId, OWNER),
        getTurnInputByTurnId: () => null,
      },
    },
    _state(sessionId) {
      if (!states.has(sessionId)) states.set(sessionId, {});
      return states.get(sessionId);
    },
    _emit(sessionId, type, info) {
      emitted.push({ type, turnId: info?.turnId });
    },
    ...createTurnQueueRecoveryMethods({
      log: { warn() {} },
      queueDispatchOptions: (options) => options,
    }),
  };
  return { host, emitted, states };
}

try {
  const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
  try {
    admitInFlight(store, "turn-a", "还有那些人人都得用的工具");
    admitInFlight(store, "turn-b", "继续找高价值的实现");

    let firstRun;
    check("the first restart announces each in-flight turn once, and writes it down", () => {
      firstRun = bootRun(store);
      firstRun.host._restoreOutcomeUnknownIntoState(SESSION);
      assert.deepEqual(firstRun.emitted.map((e) => e.turnId).sort(), ["turn-a", "turn-b"]);
      assert.ok(firstRun.emitted.every((e) => e.type === "turn.dispatch_outcome_unknown"));
      const rows = store.outcomeUnknownTurnInputs(SESSION, OWNER);
      assert.deepEqual(rows.map((r) => r.status).sort(), ["outcome_unknown", "outcome_unknown"],
        "the durable row now carries the fact, so the next run can tell");
    });

    check("the field case: later restarts stay silent about the same turns", () => {
      for (let restart = 2; restart <= 6; restart += 1) {
        const run = bootRun(store);
        run.host._restoreOutcomeUnknownIntoState(SESSION);
        assert.deepEqual(run.emitted, [], `restart ${restart} must not re-announce anything`);
        assert.equal(run.states.get(SESSION).outcomeUnknownTurnIds.size, 2,
          "but the turns are still restored, so the list the user sees is unchanged");
        assert.equal(run.states.get(SESSION).outcomeUnknownTurns.length, 2);
      }
    });

    check("a genuinely new unknown outcome is still announced, after all those restarts", () => {
      admitInFlight(store, "turn-c", "继续");
      const run = bootRun(store);
      run.host._restoreOutcomeUnknownIntoState(SESSION);
      assert.deepEqual(run.emitted.map((e) => e.turnId), ["turn-c"],
        "silence must not become deafness");
      assert.equal(run.states.get(SESSION).outcomeUnknownTurnIds.size, 3);
    });

    check("within one run the in-memory guard still holds", () => {
      const run = bootRun(store);
      run.host._restoreOutcomeUnknownIntoState(SESSION);
      run.host._restoreOutcomeUnknownIntoState(SESSION);
      assert.deepEqual(run.emitted, [], "already-announced rows stay silent on a second sweep too");
    });

    check("the transition is guarded, and bookkeeping never blocks the notice", () => {
      assert.equal(store.markTurnInputOutcomeUnknown(SESSION, "turn-a", OWNER), false,
        "a row already at outcome_unknown does not transition again");
      assert.equal(store.markTurnInputOutcomeUnknown(SESSION, "no-such-turn", OWNER), false);
      assert.equal(store.markTurnInputOutcomeUnknown(SESSION, "", OWNER), false);

      // If persistence fails, the announcement still happens — the previous
      // behaviour is the floor, never a swallowed notice.
      admitInFlight(store, "turn-d", "再来一次");
      const run = bootRun(store);
      run.host.ctx.sessionManager.markTurnInputOutcomeUnknown = () => { throw new Error("db down"); };
      run.host._restoreOutcomeUnknownIntoState(SESSION);
      assert.deepEqual(run.emitted.map((e) => e.turnId), ["turn-d"]);
    });

    console.log(`\n${checks} checks passed (announce once across restart)`);
  } finally {
    store.close?.();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
