#!/usr/bin/env node
/**
 * A failure has to say WHY, somewhere a human can reach.
 *
 * The reason a turn ended was normalized and persisted, then dropped before it
 * reached anything that reads quickly: the projection kept only that a turn had
 * failed. So a dozen unrelated causes — a knowledge pack alone raises more than
 * that — were indistinguishable in practice, every one of them reaching the
 * user as the same sentence, and a support report could not name a single one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-failure-vis-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = os.homedir();
process.env.LILY_DOCUMENTS_DIR = tmp;

const require = createRequire(import.meta.url);
const { applyTerminalPayload, DISPATCH_RECOVERY_FIELDS } = require("../src/main/store/turn-projection-payload.js");
const { recentFailureCodes } = require("../src/main/store/turn-failure-history.js");
const { MessageStore } = require("../src/main/store/message-store.js");

let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

// ------------------------------------------------- the payload shaping rule
{
  const out = applyTerminalPayload({ lastEventType: "x" }, { errorCode: "LEGAL_KB_DOWNLOAD_FAILED" }, "turn.failed");
  assert.equal(out.failureCode, "LEGAL_KB_DOWNLOAD_FAILED", "a failed turn records why it failed");
  assert.equal(out.lastEventType, "x", "unrelated accumulated payload survives");
  check("a failed turn keeps the reason it failed");
}

{
  // The delete that was already here is still right: a turn that detoured
  // through dispatch recovery and then really ended must not keep advertising
  // a recovery that no longer applies.
  const stale = Object.fromEntries(DISPATCH_RECOVERY_FIELDS.map((field) => [field, "stale"]));
  const out = applyTerminalPayload(stale, { errorCode: "MODEL_OVERLOADED" }, "turn.failed");
  for (const field of DISPATCH_RECOVERY_FIELDS) {
    assert.equal(out[field], undefined, `superseded dispatch-recovery field ${field} is cleared`);
  }
  assert.equal(out.failureCode, "MODEL_OVERLOADED", "clearing the detour does not clear the reason");
  check("superseded dispatch-recovery state is still cleared, without taking the reason with it");
}

{
  assert.equal(applyTerminalPayload({}, { errorCode: "ANYTHING" }, "turn.completed").failureCode, undefined, "a completed turn has no failure to report");
  assert.equal(applyTerminalPayload({ failureCode: "OLD" }, {}, "turn.completed").failureCode, undefined, "a later success clears an earlier code");
  assert.equal(applyTerminalPayload({}, {}, "turn.failed").failureCode, undefined, "no code supplied, none invented");
  assert.equal(applyTerminalPayload({}, { errorCode: "X".repeat(500) }, "turn.failed").failureCode.length, 120, "a malformed code cannot bloat every row");
  assert.doesNotThrow(() => applyTerminalPayload(null, null, "turn.failed"), "the persistence path is never broken by a diagnostic");
  check("success, absence and malformed input are all handled without inventing a cause");
}

// --------------------------------------------------- end to end through SQLite
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const NOW = Date.now();
let seq = 0;
const endTurn = (sessionId, turnId, type, errorCode, ts = NOW) => {
  // A real caller supplies a per-session sequence; without one the INSERT OR
  // IGNORE collides and the event is silently dropped before projection.
  store.appendRuntimeEvents(sessionId, [{
    id: `ev_${(seq += 1)}`,
    seq,
    turnId,
    type,
    source: "test",
    ts,
    payload: errorCode ? { errorCode } : {},
  }]);
};

{
  endTurn("s1", "t1", "turn.failed", "LEGAL_KB_DOWNLOAD_FAILED");
  const projection = store.getTurnProjection("s1", "t1");
  assert.equal(projection?.payload?.failureCode, "LEGAL_KB_DOWNLOAD_FAILED", "the reason survives the round trip through SQLite");
  check("the reason reaches the fast read path, not only the event stream");
}

{
  endTurn("s1", "t2", "turn.failed", "LEGAL_KB_DOWNLOAD_FAILED");
  endTurn("s2", "t3", "turn.failed", "LEGAL_KB_DOWNLOAD_FAILED");
  endTurn("s2", "t4", "turn.failed", "MODEL_OVERLOADED");
  endTurn("s2", "t5", "turn.completed", "");
  const groups = store.recentFailureCodes({ now: NOW });
  const byCode = Object.fromEntries(groups.map((group) => [group.code, group.count]));
  assert.equal(byCode.LEGAL_KB_DOWNLOAD_FAILED, 3, "the same cause is counted across sessions — which is the question support asks");
  assert.equal(byCode.MODEL_OVERLOADED, 1);
  assert.ok(!("" in byCode), "a completed turn contributes nothing");
  assert.equal(groups[0].code, "LEGAL_KB_DOWNLOAD_FAILED", "the recurring cause sorts first");
  check("recurring causes are countable across the whole install");
}

{
  endTurn("s3", "t6", "turn.failed", "ANCIENT_PROBLEM", NOW - (30 * 24 * 60 * 60 * 1_000));
  const codes = store.recentFailureCodes({ now: NOW }).map((group) => group.code);
  assert.ok(!codes.includes("ANCIENT_PROBLEM"), "a month-old failure does not keep reporting itself");
  assert.ok(codes.includes("MODEL_OVERLOADED"), "recent ones still do");
  check("the window is bounded, so a fixed problem stops appearing");
}

{
  // A diagnostic must never be the thing that breaks.
  assert.deepEqual(recentFailureCodes({ all() { throw new Error("no such column"); } }), [], "an install predating the column reports nothing rather than failing");
  check("reading the history can never break the report that reads it");
}

// ------------------------------------------------------- the support report
{
  const deepChecks = require("../src/main/support-diagnostics-recent-failures.js");
  const result = deepChecks.recentFailuresCheck({ messageDbPath: path.join(tmp, "messages.db") });
  assert.equal(result.id, "turns.recentFailures");
  assert.match(result.detail, /LEGAL_KB_DOWNLOAD_FAILED/, "the support report names the cause instead of saying something failed");
  assert.equal(result.status, "warning", "three of the same code is a defect, not weather");
  const none = deepChecks.recentFailuresCheck({ messageDbPath: path.join(tmp, "absent.db") });
  assert.equal(none.status, "ok", "an install with no history is not a problem");
  check("the support report can name what keeps failing on this install");
}

store.close?.();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`turn-failure-visibility: ok (${checks} checks)`);
