#!/usr/bin/env node
/**
 * TurnController state machine tests (no Electron).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TurnController } = require("../src/main/turn-controller.js");

const tc = new TurnController();
const sid = "sess_test";

function snap(phase) {
  const s = tc.snapshot(sid);
  if (s.phase !== phase) {
    throw new Error(`expected phase ${phase}, got ${JSON.stringify(s)}`);
  }
  return s;
}

function assertCaps(s, { canSend, canInterrupt }) {
  if (s.canSend !== canSend || s.canInterrupt !== canInterrupt) {
    throw new Error(`bad caps: ${JSON.stringify(s)}`);
  }
}

// idle
let s = snap("idle");
assertCaps(s, { canSend: true, canInterrupt: false });

// sending → streaming → completed
tc.beginTurn(sid);
s = snap("sending");
assertCaps(s, { canSend: false, canInterrupt: true });
tc.transition(sid, "engineAccepted");
s = snap("streaming");
assertCaps(s, { canSend: false, canInterrupt: true });
tc.appendOutput(sid, "hello");
const done = tc.completeTurn(sid, "completed");
if (!done.wasActive || done.output !== "hello") {
  throw new Error(`completeTurn failed: ${JSON.stringify(done)}`);
}
s = snap("closing");
assertCaps(s, { canSend: false, canInterrupt: false });
tc.finalizeTurn(sid);
s = snap("idle");
if (s.endReason !== "completed") throw new Error("endReason missing");

// tool round-trip
tc.beginTurn(sid);
tc.transition(sid, "engineAccepted");
tc.transition(sid, "toolStart");
snap("tool");
tc.transition(sid, "toolEnd");
snap("streaming");
tc.completeTurn(sid, "completed");
tc.finalizeTurn(sid);

// interrupt path
tc.beginTurn(sid);
tc.transition(sid, "engineAccepted");
tc.transition(sid, "userInterrupt");
s = snap("stopping");
assertCaps(s, { canSend: false, canInterrupt: false });
tc.transition(sid, "interruptDone");
snap("idle");

// send failed
tc.beginTurn(sid);
tc.transition(sid, "sendFailed");
snap("idle");

// permission
tc.beginTurn(sid);
tc.transition(sid, "permissionRequest");
snap("permission");
tc.transition(sid, "permissionResolved");
snap("streaming");

// seq monotonic + out-of-order discard (renderer contract)
const seqBefore = tc.snapshot(sid).seq;
tc.transition(sid, "toolStart");
const seqAfter = tc.snapshot(sid).seq;
if (seqAfter <= seqBefore) throw new Error("seq should increase on transition");

// running ids
tc.finalizeTurn(sid);
tc.beginTurn("other");
const running = tc.getRunningSessionIds();
if (!running.includes("other") || running.includes(sid)) {
  throw new Error(`getRunningSessionIds failed: ${running}`);
}
tc.completeTurn("other", "completed");
tc.finalizeTurn("other");

console.log("test-turn-controller: ok");
