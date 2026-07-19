#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createRuntimeEvent,
  assertRuntimeEvent,
  isTerminalEvent,
  isUserBlockingEvent,
} = require("../src/main/runtime-event-schema.js");
const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");

const event = createRuntimeEvent({
  type: "assistant.delta",
  sessionId: "s1",
  turnId: "t1",
  seq: 1,
  payload: { text: "hello" },
});
assertRuntimeEvent(event);
assert.throws(
  () => createRuntimeEvent({
    type: "assistant.delta",
    sessionId: "s1",
    turnId: "t1",
    payload: { text: 42 },
  }),
  /payload\.text must be string/,
  "typed payload contracts must reject malformed producer output",
);
assert.throws(
  () => createRuntimeEvent({
    type: "tool.started",
    sessionId: "s1",
    turnId: "t1",
    payload: { id: "tool_1" },
  }),
  /payload requires name/,
  "required payload fields must be enforced",
);
if (event.type !== "assistant.delta" || event.payload.text !== "hello") {
  throw new Error("runtime event shape failed");
}
if (isTerminalEvent(event)) throw new Error("delta must not be terminal");

const terminal = createRuntimeEvent({
  type: "turn.completed",
  sessionId: "s1",
  turnId: "t1",
  seq: 2,
  payload: { assistant: "done", toolsSummary: { count: 0 } },
});
if (!isTerminalEvent(terminal)) throw new Error("turn.completed should be terminal");

const blocking = createRuntimeEvent({
  type: "permission.requested",
  sessionId: "s1",
  turnId: "t1",
  seq: 3,
  payload: { requestId: "r1" },
});
if (!isUserBlockingEvent(blocking)) throw new Error("permission should be blocking");

const processEvent = createRuntimeEvent({
  type: "process.event",
  sessionId: "s1",
  turnId: "t1",
  seq: 4,
  payload: {
    rawType: "stream_event",
    rawSubtype: "content_block_delta",
    summary: "thinking",
  },
});
assertRuntimeEvent(processEvent);

const contentBlock = createRuntimeEvent({
  type: "content.block",
  sessionId: "s1",
  turnId: "t1",
  seq: 5,
  payload: { blockType: "image", mediaType: "image/png", data: "abc" },
});
assertRuntimeEvent(contentBlock);

const protocolUnknown = createRuntimeEvent({
  type: "protocol.unknown",
  sessionId: "s1",
  turnId: "t1",
  seq: 6,
  payload: { kind: "unknown_runtime_event", notice: { detail: "x" }, event: { type: "foo" } },
});
assertRuntimeEvent(protocolUnknown);

if (processEvent.payload.rawType !== "stream_event") {
  throw new Error("process.event should preserve CLI process metadata");
}

let sent = null;
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send(channel, payload) {
      sent = { channel, payload };
    },
  },
};
const bus = new RuntimeEventBus(() => fakeWindow);
const emitted = bus.emitBatch("s2", [
  { type: "turn.started", turnId: "t2", payload: { text: "start" } },
  { type: "assistant.delta", turnId: "t2", payload: { text: "x" } },
]);
if (emitted[0].seq !== 1 || emitted[1].seq !== 2) {
  throw new Error("session seq must be monotonic");
}
bus.flush();
if (sent?.channel !== "assistant:runtime-events") {
  throw new Error("runtime bus sent wrong channel");
}
if (sent.payload.events.length !== 2 || sent.payload.batchSeq !== 1) {
  throw new Error("runtime bus batch failed");
}

const persisted = [];
const persistentBus = new RuntimeEventBus(() => fakeWindow, {
  persistEvents: (sessionId, events) => persisted.push({ sessionId, events }),
});
persistentBus.emit("s_persist", {
  type: "turn.started",
  turnId: "t_persist",
  payload: { text: "persist me" },
});
if (persisted.length !== 1 || persisted[0].sessionId !== "s_persist") {
  throw new Error("runtime bus must call persistEvents with normalized events");
}
if (persisted[0].events[0]?.seq !== 1 || persisted[0].events[0]?.payload?.text !== "persist me") {
  throw new Error(`persisted event must be normalized: ${JSON.stringify(persisted)}`);
}

const terminalEvents = bus.emitBatch("s2", [
  { type: "turn.completed", turnId: "t2", payload: { assistant: "done", toolsSummary: { count: 0 } } },
  { type: "turn.failed", turnId: "t2", payload: { assistant: "failed" } },
  { type: "assistant.delta", turnId: "t2", payload: { text: "late" } },
]);
if (terminalEvents.length !== 1 || terminalEvents[0].type !== "turn.completed") {
  throw new Error("runtime bus must reject duplicate terminal and post-terminal events");
}

console.log("runtime-event-schema: ok");
