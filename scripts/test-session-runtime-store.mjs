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

// Block model: prose and thinking are ordered content blocks, and a thinking
// delta seals the open text block so the narrative order survives.
{
  const kinds = (runtime.liveTurn?.timeline || []).map((entry) => entry.kind).join(",");
  if (kinds !== "text,thinking") {
    throw new Error(`block timeline failed: ${JSON.stringify(runtime.liveTurn?.timeline)}`);
  }
  if (runtime.liveTurn.timeline[0].status !== "done") {
    throw new Error("thinking delta must seal the open text block");
  }
}

store.applyRuntimeBatch({
  sessionId: "s1",
  batchSeq: 2,
  events: [
    {
      id: "e-tool",
      type: "tool.started",
      sessionId: "s1",
      turnId: "t1",
      seq: 5,
      ts: 1004,
      source: "test",
      payload: { id: "tool_1", name: "Read", input: { file_path: "src/a.js" } },
    },
    {
      id: "e-status",
      type: "process.event",
      sessionId: "s1",
      turnId: "t1",
      seq: 6,
      ts: 1005,
      source: "test",
      payload: {
        rawSubtype: "status",
        event: { status: "Reading recent chapters" },
        actions: [],
      },
    },
  ],
});

runtime = store.getRuntimeSession("s1");
if (runtime.liveTurn?.activityLabel !== "Read src/a.js") {
  throw new Error(`running tool should win over CLI status: ${runtime.liveTurn?.activityLabel}`);
}
{
  const kinds = (runtime.liveTurn?.timeline || []).map((entry) => entry.kind).join(",");
  if (kinds !== "text,thinking,tool") {
    throw new Error(`expected text + thinking + tool timeline, got ${kinds}`);
  }
}

store.applyRuntimeBatch({
  sessionId: "s1",
  batchSeq: 3,
  events: [
    {
      id: "e-usage",
      type: "usage.updated",
      sessionId: "s1",
      turnId: "t1",
      seq: 7,
      ts: 1006,
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
      seq: 8,
      ts: 1007,
      source: "test",
      payload: { assistant: "hello", durationMs: 30584, totalCostUsd: 0.12 },
    },
  ],
});

runtime = store.getRuntimeSession("s1");
if (runtime.committedMessages.filter((m) => m.role === "assistant").length !== 1) {
  throw new Error("terminal should commit one assistant message");
}
if (runtime.liveTurn?.durationMs !== 30584) {
  throw new Error(`durationMs should flow from turn.completed: ${runtime.liveTurn?.durationMs}`);
}
if (runtime.liveTurn?.notices.some((event) => event.type === "usage.updated")) {
  throw new Error("usage updates should not be rendered as process notices");
}
if (runtime.liveTurn?.timeline.some((entry) => entry.status === "streaming")) {
  throw new Error("terminal events must seal streaming timeline blocks");
}

store.applyRuntimeBatch({
  sessionId: "s1",
  batchSeq: 4,
  events: [
    {
      id: "e-late",
      type: "assistant.delta",
      sessionId: "s1",
      turnId: "t1",
      seq: 9,
      ts: 1008,
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
  sessionId: "s1_record_timeline",
  batchSeq: 1,
  events: [
    {
      id: "s1-record-start",
      type: "turn.started",
      sessionId: "s1_record_timeline",
      turnId: "t_record",
      seq: 1,
      ts: 5000,
      source: "test",
      payload: {},
    },
    {
      id: "s1-record-done",
      type: "turn.completed",
      sessionId: "s1_record_timeline",
      turnId: "t_record",
      seq: 2,
      ts: 5001,
      source: "test",
      payload: {
        assistant: "done",
        record: {
          timeline: [
            { kind: "thinking", id: "think_1", text: "plan", status: "streaming", startTs: 5000, ts: 5000 },
            { kind: "text", id: "text_1", text: "done", status: "streaming", ts: 5000 },
          ],
        },
      },
    },
  ],
});
runtime = store.getRuntimeSession("s1_record_timeline");
if (runtime.liveTurn?.timeline.some((entry) => entry.status === "streaming")) {
  throw new Error("record timeline replacement must also seal streaming blocks");
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
      payload: { notice: { code: "permissionDenied", level: "warning", panel: true, replace: true, detail: "denied" } },
    },
    {
      id: "s2-notice-2",
      type: "engine.notice",
      sessionId: "s2",
      turnId: "t2",
      seq: 3,
      ts: 2002,
      source: "test",
      payload: { notice: { code: "permissionDenied", level: "warning", panel: true, replace: true, detail: "denied again" } },
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
    {
      id: "s2-long-running",
      type: "engine.notice",
      sessionId: "s2",
      turnId: "t2",
      seq: 5,
      ts: 2004,
      source: "test",
      payload: {
        notice: {
          code: "shellLongRunning",
          level: "progress",
          panel: true,
          replace: true,
          detail: "docker push registry.example.com/app:latest",
        },
      },
    },
  ],
});
runtime = store.getRuntimeSession("s2");
if (runtime.liveTurn?.notices.length !== 2) {
  throw new Error(`replace notices should be aggregated, got ${runtime.liveTurn?.notices.length}`);
}
if (!runtime.liveTurn?.notices.some((event) => event.payload?.notice?.code === "shellLongRunning")) {
  throw new Error(`long-running shell notice should survive renderer policy: ${JSON.stringify(runtime.liveTurn?.notices)}`);
}

store.applyRuntimeEvent({
  id: "s2-suggest",
  type: "prompt_suggestions.updated",
  sessionId: "s2",
  turnId: null,
  seq: 6,
  ts: 2005,
  source: "test",
  payload: { suggestions: ["Try this", "Or that"] },
});
runtime = store.getRuntimeSession("s2");
if (runtime.promptSuggestions.join(",") !== "Try this,Or that") {
  throw new Error(`prompt suggestions should hydrate store, got ${JSON.stringify(runtime.promptSuggestions)}`);
}

store.syncCommittedMessages("s3", [
  {
    role: "user",
    content: "older persisted question",
    timestamp: "2026-06-01T00:00:00.000Z",
  },
]);
store.applyRuntimeBatch({
  sessionId: "s3",
  batchSeq: 1,
  events: [
    {
      id: "s3-user",
      type: "user.committed",
      sessionId: "s3",
      turnId: "t3",
      seq: 1,
      ts: 3000,
      source: "test",
      payload: { text: "local question while task is starting" },
    },
    {
      id: "s3-start",
      type: "turn.started",
      sessionId: "s3",
      turnId: "t3",
      seq: 2,
      ts: 3001,
      source: "test",
      payload: {},
    },
  ],
});
store.syncCommittedMessages("s3", [
  {
    role: "user",
    content: "older persisted question",
    timestamp: "2026-06-01T00:00:00.000Z",
  },
]);
runtime = store.getRuntimeSession("s3");
if (!runtime.committedMessages.some((message) => message.content === "local question while task is starting")) {
  throw new Error("running session history sync must preserve not-yet-persisted local messages");
}

store.applyRuntimeBatch({
  sessionId: "s3b",
  batchSeq: 1,
  events: [
    {
      id: "s3b-current-user",
      type: "user.committed",
      sessionId: "s3b",
      turnId: "current-turn",
      seq: 1,
      ts: 3100,
      source: "test",
      payload: { text: "current running question" },
    },
    {
      id: "s3b-start",
      type: "turn.started",
      sessionId: "s3b",
      turnId: "current-turn",
      seq: 2,
      ts: 3101,
      source: "test",
      payload: {},
    },
  ],
});
runtime = store.getRuntimeSession("s3b");
runtime.committedMessages.push({
  role: "user",
  turnId: "queued-or-stale-turn",
  content: "queued question must not render as current history",
  timestamp: "2026-06-01T00:00:03.000Z",
});
store.syncCommittedMessages("s3b", [
  {
    id: "persisted-current-user",
    role: "user",
    turnId: "current-turn",
    content: "current running question",
    timestamp: "2026-06-01T00:00:02.000Z",
  },
]);
runtime = store.getRuntimeSession("s3b");
if (runtime.committedMessages.some((message) => message.content === "queued question must not render as current history")) {
  throw new Error("busy session history sync must not preserve local messages from a different turn");
}

store.applyRuntimeBatch({
  sessionId: "s4",
  batchSeq: 1,
  events: [
    {
      id: "s4-user",
      type: "user.committed",
      sessionId: "s4",
      turnId: "t4",
      seq: 1,
      ts: 4000,
      source: "test",
      payload: { text: "question committed before session switch" },
    },
    {
      id: "s4-start",
      type: "turn.started",
      sessionId: "s4",
      turnId: "t4",
      seq: 2,
      ts: 4001,
      source: "test",
      payload: {},
    },
  ],
});
store.syncCommittedMessages("s4", [
  {
    id: "persisted-user-id",
    role: "user",
    turnId: "t4",
    content: "question committed before session switch",
    timestamp: "2026-06-01T00:00:02.000Z",
  },
]);
runtime = store.getRuntimeSession("s4");
const s4UserMessages = runtime.committedMessages.filter((message) => message.role === "user" && message.turnId === "t4");
if (s4UserMessages.length !== 1) {
  throw new Error(`running history sync must dedupe persisted/live user by turnId, got ${s4UserMessages.length}`);
}

store.applyRuntimeEvent({
  id: "s3-done",
  type: "turn.completed",
  sessionId: "s3",
  turnId: "t3",
  seq: 3,
  ts: 3002,
  source: "test",
  payload: { assistant: "done" },
});
store.syncCommittedMessages("s3", [
  {
    role: "user",
    content: "canonical persisted question",
    timestamp: "2026-06-01T00:00:01.000Z",
  },
]);
runtime = store.getRuntimeSession("s3");
if (runtime.committedMessages.some((message) => message.content === "local question while task is starting")) {
  throw new Error("idle session history sync should let persisted history become canonical");
}
if (runtime.committedMessages.length !== 1 || runtime.committedMessages[0].content !== "canonical persisted question") {
  throw new Error(`idle session history sync should replace committed messages: ${JSON.stringify(runtime.committedMessages)}`);
}

console.log("session-runtime-store: ok");
