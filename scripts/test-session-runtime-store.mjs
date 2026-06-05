#!/usr/bin/env node

const store = await import("../src/renderer/modules/session-runtime-store.js");

store.applyRuntimeBatch({
  sessionId: "s1",
  batchSeq: 1,
  events: [
    {
      id: "e1",
      type: "turn.started",
      sessionId: "s1",
      turnId: "t1",
      seq: 1,
      ts: 1000,
      source: "test",
      payload: {},
    },
    {
      id: "e2",
      type: "assistant.delta",
      sessionId: "s1",
      turnId: "t1",
      seq: 2,
      ts: 1001,
      source: "test",
      payload: { text: "hello" },
    },
    {
      id: "e-thinking",
      type: "assistant.thinking.delta",
      sessionId: "s1",
      turnId: "t1",
      seq: 3,
      ts: 1002,
      source: "test",
      payload: { text: "I should inspect files." },
    },
    {
      id: "e-process",
      type: "process.event",
      sessionId: "s1",
      turnId: "t1",
      seq: 4,
      ts: 1003,
      source: "test",
      payload: {
        rawType: "stream_event",
        rawSubtype: "content_block_delta",
        summary: "I should inspect files.",
        actions: [{ kind: "assistant_thinking", text: "I should inspect files." }],
      },
    },
  ],
});

let runtime = store.getRuntimeSession("s1");
if (runtime.liveTurn?.assistantText !== "hello") {
  throw new Error("initial delta failed");
}
if (runtime.liveTurn?.thinkingText !== "I should inspect files.") {
  throw new Error(`thinking delta failed: ${runtime.liveTurn?.thinkingText}`);
}
if (runtime.liveTurn?.processEvents.length !== 1) {
  throw new Error(`process.event should be retained, got ${runtime.liveTurn?.processEvents.length}`);
}

store.applyRuntimeBatch({
  sessionId: "s1",
  batchSeq: 1,
  events: [
    {
      id: "e-old-batch",
      type: "assistant.delta",
      sessionId: "s1",
      turnId: "t1",
      seq: 4,
      ts: 1002,
      source: "test",
      payload: { text: " duplicate" },
    },
  ],
});
runtime = store.getRuntimeSession("s1");
if (runtime.liveTurn?.assistantText !== "hello") {
  throw new Error("duplicate batch should be ignored");
}

store.applyRuntimeBatch({
  sessionId: "s1",
  batchSeq: 2,
  events: [
    {
      id: "e-usage",
      type: "usage.updated",
      sessionId: "s1",
      turnId: "t1",
      seq: 5,
      ts: 1002,
      source: "test",
      payload: { estimatedTokens: 203 },
    },
    {
      id: "e-old-seq",
      type: "assistant.delta",
      sessionId: "s1",
      turnId: "t1",
      seq: 2,
      ts: 1003,
      source: "test",
      payload: { text: " old" },
    },
    {
      id: "e3",
      type: "turn.completed",
      sessionId: "s1",
      turnId: "t1",
      seq: 6,
      ts: 1004,
      source: "test",
      payload: { assistant: "hello" },
    },
  ],
});

runtime = store.getRuntimeSession("s1");
if (runtime.committedMessages.filter((m) => m.role === "assistant").length !== 1) {
  throw new Error("terminal should commit one assistant message");
}
if (runtime.liveTurn?.notices.some((event) => event.type === "usage.updated")) {
  throw new Error("usage updates should not be rendered as process notices");
}

store.applyRuntimeBatch({
  sessionId: "s1",
  batchSeq: 3,
  events: [
    {
      id: "e-late",
      type: "assistant.delta",
      sessionId: "s1",
      turnId: "t1",
      seq: 4,
      ts: 1005,
      source: "test",
      payload: { text: " late" },
    },
  ],
});
runtime = store.getRuntimeSession("s1");
const assistant = runtime.committedMessages.find((m) => m.role === "assistant");
if (assistant.content !== "hello") {
  throw new Error("late post-terminal delta must not mutate committed assistant");
}

store.applyRuntimeBatch({
  sessionId: "s2",
  batchSeq: 1,
  events: [
    {
      id: "s2-start",
      type: "turn.started",
      sessionId: "s2",
      turnId: "t2",
      seq: 1,
      ts: 2000,
      source: "test",
      payload: {},
    },
    {
      id: "s2-notice-1",
      type: "engine.notice",
      sessionId: "s2",
      turnId: "t2",
      seq: 2,
      ts: 2001,
      source: "test",
      payload: { notice: { code: "waitingForFirstResponse", panel: true, replace: true } },
    },
    {
      id: "s2-notice-2",
      type: "engine.notice",
      sessionId: "s2",
      turnId: "t2",
      seq: 3,
      ts: 2002,
      source: "test",
      payload: { notice: { code: "waitingForFirstResponse", panel: true, replace: true } },
    },
    {
      id: "s2-hidden",
      type: "engine.notice",
      sessionId: "s2",
      turnId: "t2",
      seq: 4,
      ts: 2003,
      source: "test",
      payload: { notice: { code: "sessionReady", panel: false } },
    },
  ],
});
runtime = store.getRuntimeSession("s2");
if (runtime.liveTurn?.notices.length !== 1) {
  throw new Error(`replace notices should be aggregated, got ${runtime.liveTurn?.notices.length}`);
}

console.log("session-runtime-store: ok");
