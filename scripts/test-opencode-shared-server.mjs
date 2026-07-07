#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  OpencodeSharedServer,
  getSharedServer,
  resetSharedServer,
} = require("../src/main/runtime/opencode-shared-server.js");

try {
  resetSharedServer();

  const first = getSharedServer({
    serverCommand: "/bin/true",
    cwd: process.cwd(),
    dataDir: ":memory:",
    configContent: "CONFIG_A",
  });
  const release = first.retainView();
  let terminated = false;
  const originalTerminate = first.terminate.bind(first);
  first.terminate = () => {
    terminated = true;
    originalTerminate();
  };

  const whileActive = getSharedServer({
    serverCommand: "/bin/true",
    cwd: process.cwd(),
    dataDir: ":memory:",
    configContent: "CONFIG_B",
  });
  assert.notEqual(whileActive, first, "config drift starts a replacement serve for new requests");
  assert.equal(terminated, false, "old active serve is not terminated until its views detach");
  assert.equal(first._retireWhenIdle, true, "old serve is marked for retirement");

  release();
  assert.equal(terminated, true, "retired old serve terminates when its last view detaches");

  resetSharedServer();
  const staleEnv = getSharedServer({
    serverCommand: "/bin/true",
    cwd: process.cwd(),
    dataDir: ":memory:",
    configContent: "CONFIG_TOKEN",
    env: { LILY_API_KEY: "stale-token" },
  });
  const freshEnv = getSharedServer({
    serverCommand: "/bin/true",
    cwd: process.cwd(),
    dataDir: ":memory:",
    configContent: "CONFIG_TOKEN",
    env: { LILY_API_KEY: "fresh-token" },
  });
  assert.notEqual(freshEnv, staleEnv, "env drift rebuilds shared serve so refreshed gateway tokens take effect");

  const shared = new OpencodeSharedServer({
    serverCommand: "/bin/true",
    cwd: process.cwd(),
    dataDir: ":memory:",
  });
  const seen = [];
  shared.onEvent((directory, event) => seen.push({ directory, event }));
  shared._enqueueEvent("/workspace", {
    type: "message.part.delta",
    properties: { messageID: "msg_1", partID: "prt_1", field: "text", delta: "hel" },
  });
  shared._enqueueEvent("/workspace", {
    type: "message.part.delta",
    properties: { messageID: "msg_1", partID: "prt_1", field: "text", delta: "lo" },
  });
  shared._flushEvents();
  assert.equal(seen.length, 1, "consecutive deltas are coalesced like official desktop");
  assert.equal(seen[0].event.properties.delta, "hello", "delta text is appended during coalesce");
  let diag = shared.diagnostics();
  assert.equal(diag.eventStats.received, 2, "diagnostics counts received events");
  assert.equal(diag.eventStats.delivered, 1, "diagnostics counts delivered events");
  assert.equal(diag.eventStats.coalesced, 1, "diagnostics counts coalesced events");
  assert.equal(diag.eventStats.byType["message.part.delta"], 2, "diagnostics groups by event type");
  assert(diag.recentEvents.some((event) => event.direction === "delivered" && event.type === "message.part.delta"),
    "diagnostics keeps a recent delivered-event ring");

  seen.length = 0;
  shared._enqueueEvent("/workspace", {
    type: "message.part.delta",
    properties: { messageID: "msg_2", partID: "prt_2", field: "text", delta: "final words" },
  });
  shared._enqueueEvent("/workspace", {
    type: "message.part.updated",
    properties: { part: { messageID: "msg_2", id: "prt_2", type: "text", text: "fresh" } },
  });
  shared._flushEvents();
  assert.equal(seen.length, 2, "text part.updated must not drop queued answer deltas");
  assert.equal(seen[0].event.type, "message.part.delta", "answer delta is delivered before text snapshot update");
  assert.equal(seen[0].event.properties.delta, "final words", "answer delta text is preserved");
  assert.equal(seen[1].event.type, "message.part.updated", "text snapshot update still reaches the reducer");

  seen.length = 0;
  shared._enqueueEvent("/workspace", {
    type: "message.part.delta",
    properties: { messageID: "msg_3", partID: "prt_3", field: "text", delta: "reasoning fragment" },
  });
  shared._enqueueEvent("/workspace", {
    type: "message.part.updated",
    properties: { part: { messageID: "msg_3", id: "prt_3", type: "reasoning", text: "reasoning fragment" } },
  });
  shared._flushEvents();
  assert.equal(seen.length, 2, "first part.updated does not stale prior deltas, matching official desktop");
  assert.equal(seen[0].event.type, "message.part.delta", "reasoning delta is delivered first for reducer classification");
  assert.equal(seen[1].event.type, "message.part.updated", "reasoning snapshot follows the buffered delta");

  seen.length = 0;
  shared._enqueueEvent("/workspace", {
    type: "message.part.delta",
    properties: { messageID: "msg_4", partID: "prt_4", field: "text", delta: "a" },
  });
  shared._enqueueEvent("/workspace", {
    type: "message.part.updated",
    properties: { part: { messageID: "msg_4", id: "prt_4", type: "text", text: "a" } },
  });
  shared._enqueueEvent("/workspace", {
    type: "message.part.delta",
    properties: { messageID: "msg_4", partID: "prt_4", field: "text", delta: "b" },
  });
  shared._flushEvents();
  assert.equal(seen.length, 3, "delta coalescing resets across non-delta events");
  assert.deepEqual(seen.map((item) => item.event.type), [
    "message.part.delta",
    "message.part.updated",
    "message.part.delta",
  ], "event order is preserved across part snapshots");

  seen.length = 0;
  shared._enqueueEvent("/workspace", {
    type: "message.part.updated",
    properties: { part: { messageID: "msg_5", id: "prt_5", type: "reasoning", text: "old" } },
  });
  shared._enqueueEvent("/workspace", {
    type: "message.part.delta",
    properties: { messageID: "msg_5", partID: "prt_5", field: "text", delta: "stale" },
  });
  shared._enqueueEvent("/workspace", {
    type: "message.part.updated",
    properties: { part: { messageID: "msg_5", id: "prt_5", type: "reasoning", text: "fresh" } },
  });
  shared._flushEvents();
  assert.equal(seen.length, 1, "replacement part.updated stales older queued deltas like official desktop");
  assert.equal(seen[0].event.properties.part.text, "fresh", "latest replacement update wins");
  diag = shared.diagnostics();
  assert.equal(diag.eventStats.droppedStaleDelta, 1, "diagnostics counts stale delta drops");

  // Event-stream reconnect churn must not be treated as a fatal shared-server
  // error. One global SSE stream serves every session; broadcasting an error here
  // fails unrelated turns halfway through their answer. Process exit/error and
  // health probes still cover real engine death.
  {
    const reconnecting = new OpencodeSharedServer({
      serverCommand: "/bin/true",
      cwd: process.cwd(),
      dataDir: ":memory:",
    });
    let fatal = false;
    reconnecting.on("error", () => { fatal = true; });
    reconnecting._baseClient = {
      global: {
        event: async () => {
          throw new Error("transient SSE failure");
        },
      },
    };
    reconnecting._sseRetries = 31;
    const oldSetTimeout = global.setTimeout;
    global.setTimeout = () => ({ unref() {} });
    try {
      await reconnecting._subscribeEvents();
    } finally {
      global.setTimeout = oldSetTimeout;
      reconnecting.terminate();
    }
    assert.equal(fatal, false, "SSE reconnect exhaustion must not emit fatal shared error");
  }

  // Cold-start guard: prompt/session work must not begin before the global
  // event stream is actually established. Otherwise the first turn after app
  // restart can run in a blind window and look like a model interruption while a
  // retry works because the stream is then warm.
  {
    const cold = new OpencodeSharedServer({
      serverCommand: "/bin/true",
      cwd: process.cwd(),
      dataDir: ":memory:",
    });
    let releaseStream;
    cold._baseClient = {
      global: {
        event: async () => {
          await new Promise((resolve) => { releaseStream = resolve; });
          return { stream: (async function* () {})() };
        },
      },
    };
    const ready = cold._waitForEventStreamReady(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let resolved = false;
    ready.then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resolved, false, "event ready wait stays pending until global.event resolves");
    releaseStream();
    await ready;
    assert.equal(cold._eventStreamReady, true, "event stream readiness is latched");
    cold.terminate();
  }

  console.log("opencode-shared-server: ok");
} finally {
  resetSharedServer();
}
