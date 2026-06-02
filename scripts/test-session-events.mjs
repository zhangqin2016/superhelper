#!/usr/bin/env node
/**
 * Session event batch builders + monotonic seq (no Electron).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  emitSessionEvents,
  buildTurnEndedEvent,
  buildUserCommittedEvent,
} = require("../src/main/session-events.js");

const sid = "sess_events_test";
const sent = [];

const ctx = {
  mainWindow: {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        sent.push({ channel, payload });
      },
    },
  },
};

emitSessionEvents(ctx, sid, [buildTurnEndedEvent(sid, { endReason: "completed" })]);
emitSessionEvents(ctx, sid, [
  buildUserCommittedEvent(sid, "hello", null, { immediate: true }),
]);

if (sent.length !== 2) throw new Error(`expected 2 sends, got ${sent.length}`);
if (sent[0].channel !== "assistant:session-events") throw new Error("wrong channel");
if (sent[0].payload.seq !== 1) throw new Error(`expected seq 1, got ${sent[0].payload.seq}`);
if (sent[1].payload.seq !== 2) throw new Error(`expected seq 2, got ${sent[1].payload.seq}`);

const turn = sent[0].payload.events[0];
if (turn.type !== "turn-ended" || turn.endReason !== "completed") {
  throw new Error("turn-ended shape mismatch");
}

const user = sent[1].payload.events[0];
if (user.type !== "user-committed" || user.text !== "hello" || !user.immediate) {
  throw new Error("user-committed shape mismatch");
}

const batch = [
  buildTurnEndedEvent(sid, { interrupted: true, assistant: { text: "partial", failed: false } }),
  buildUserCommittedEvent(sid, "queued", [], { fromQueue: true }),
];
emitSessionEvents(ctx, sid, batch);
if (sent[2].payload.events.length !== 2) throw new Error("atomic batch expected 2 events");
if (sent[2].payload.seq !== 3) throw new Error("seq should monotonically increase");

console.log("session-events: ok");
