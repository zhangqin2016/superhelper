#!/usr/bin/env node

const store = await import("../src/renderer/modules/session-runtime-store.js");
const renderableTimeline = await import("../src/renderer/modules/turn-renderable-timeline.js");

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
{
  const thinkingBlocks = (runtime.liveTurn?.timeline || []).filter((entry) => entry.kind === "thinking");
  if (thinkingBlocks.length !== 1 || thinkingBlocks[0].text !== "I should inspect files.") {
    throw new Error(`process.event must not duplicate thinking deltas: ${JSON.stringify(runtime.liveTurn?.timeline)}`);
  }
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
    {
      id: "e-todo",
      type: "todo.updated",
      sessionId: "s1",
      turnId: "t1",
      seq: 7,
      ts: 1006,
      source: "test",
      payload: {
        id: "todo_s1",
        todos: [
          { content: "Inspect official reducer", status: "completed" },
          { content: "Map Lily event", status: "in_progress" },
        ],
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
  if (kinds !== "text,thinking,tool,tool") {
    throw new Error(`expected text + thinking + tool timeline, got ${kinds}`);
  }
  const todos = runtime.liveTurn.timeline.find((entry) => entry.name === "todowrite")?.input?.todos || [];
  if (todos.length !== 2 || todos[1].content !== "Map Lily event") {
    throw new Error(`todo.updated should update the live todo timeline: ${JSON.stringify(runtime.liveTurn.timeline)}`);
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
      seq: 8,
      ts: 1007,
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
      seq: 9,
      ts: 1008,
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
  sessionId: "s1",
  batchSeq: 5,
  events: [
    {
      id: "e-duplicate-terminal",
      type: "turn.failed",
      sessionId: "s1",
      turnId: "t1",
      seq: 10,
      ts: 1009,
      source: "test",
      payload: { assistant: "duplicate terminal" },
    },
    {
      id: "e-late-user",
      type: "user.committed",
      sessionId: "s1",
      turnId: "t1",
      seq: 11,
      ts: 1010,
      source: "test",
      payload: { text: "late user for completed turn" },
    },
  ],
});
runtime = store.getRuntimeSession("s1");
if (runtime.committedMessages.filter((m) => m.role === "assistant" && m.turnId === "t1").length !== 1) {
  throw new Error(`duplicate terminal must not append another assistant: ${JSON.stringify(runtime.committedMessages)}`);
}
if (runtime.committedMessages.some((m) => m.content === "late user for completed turn")) {
  throw new Error(`late user.committed for completed turn must be ignored: ${JSON.stringify(runtime.committedMessages)}`);
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

store.syncCommittedMessages("s5", [
  {
    id: "official-user-no-turn",
    role: "user",
    content: "please create a schedule every hour. say hello",
    timestamp: "2026-06-01T00:00:02.000Z",
  },
  {
    id: "projection-user-with-turn",
    role: "user",
    turnId: "scheduled-turn",
    content: "please create a schedule every hour. say hello",
    timestamp: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "schedule-draft-1",
    role: "assistant",
    timestamp: "2026-06-01T00:00:03.000Z",
    meta: {
      scheduledDraft: {
        originalText: "please create a schedule every hour. say hello",
        draft: {
          title: "Say hello",
          scheduleText: "Every hour on the hour",
          rrule: "FREQ=HOURLY;INTERVAL=1",
        },
      },
    },
  },
  {
    id: "schedule-draft-2",
    role: "assistant",
    turnId: "scheduled-turn",
    timestamp: "2026-06-01T00:00:04.000Z",
    meta: {
      scheduledDraft: {
        originalText: "please create a schedule every hour. say hello",
        draft: {
          title: "Say hello",
          scheduleText: "Every hour on the hour",
          rrule: "FREQ=HOURLY;INTERVAL=1",
        },
      },
    },
  },
]);
runtime = store.getRuntimeSession("s5");
if (runtime.committedMessages.filter((message) => message.role === "user").length !== 1) {
  throw new Error(`idle sync must dedupe equivalent user messages: ${JSON.stringify(runtime.committedMessages)}`);
}
if (runtime.committedMessages.filter((message) => message.meta?.scheduledDraft).length !== 1) {
  throw new Error(`idle sync must dedupe equivalent scheduled draft cards: ${JSON.stringify(runtime.committedMessages)}`);
}

store.syncCommittedMessages("s6", [
  {
    id: "real-repeat-1",
    role: "user",
    content: "继续",
    timestamp: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "real-repeat-2",
    role: "user",
    content: "继续",
    timestamp: "2026-06-01T00:00:10.000Z",
  },
]);
runtime = store.getRuntimeSession("s6");
if (runtime.committedMessages.length !== 2) {
  throw new Error(`real repeated user messages must not be deduped: ${JSON.stringify(runtime.committedMessages)}`);
}

store.syncCommittedMessages("s6-steer-repeat", [
  {
    id: "original-repeat",
    role: "user",
    content: "same text",
    turnId: "turn_repeat",
    timestamp: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "projection-repeat-steer",
    role: "user",
    content: "same text",
    turnId: "turn_repeat",
    timestamp: "2026-06-01T00:00:03.000Z",
    meta: { steer: true, steerSeq: 1, projected: true },
  },
]);
runtime = store.getRuntimeSession("s6-steer-repeat");
if (runtime.committedMessages.filter((message) => message.role === "user").length !== 2) {
  throw new Error(`steer with repeated text must not be projection-deduped: ${JSON.stringify(runtime.committedMessages)}`);
}

store.applyRuntimeBatch({
  sessionId: "steer-live",
  batchSeq: 1,
  events: [
    { id: "st1", type: "turn.started", sessionId: "steer-live", turnId: "turn_steer", seq: 1, ts: 6000, source: "test", payload: {} },
    { id: "st2", type: "user.committed", sessionId: "steer-live", turnId: "turn_steer", seq: 2, ts: 6001, source: "test", payload: { text: "original request" } },
    { id: "st3", type: "assistant.delta", sessionId: "steer-live", turnId: "turn_steer", seq: 3, ts: 6002, source: "test", payload: { text: "working" } },
    { id: "st4", type: "user.committed", sessionId: "steer-live", turnId: "turn_steer", seq: 4, ts: 6003, source: "test", payload: { text: "add this constraint", steer: true, steerSeq: 1 } },
    { id: "st5", type: "turn.steered", sessionId: "steer-live", turnId: "turn_steer", seq: 5, ts: 6004, source: "test", payload: { text: "add this constraint", steerSeq: 1 } },
  ],
});
runtime = store.getRuntimeSession("steer-live");
const steerUsers = runtime.committedMessages.filter((message) => message.role === "user" && message.turnId === "turn_steer");
if (steerUsers.length !== 2) {
  throw new Error(`steer must render as a second user message in the same turn: ${JSON.stringify(runtime.committedMessages)}`);
}
if (!steerUsers.some((message) => message.content === "add this constraint" && message.meta?.steer && message.meta?.steerSeq === 1)) {
  throw new Error(`steer user message must carry stable meta for render/reload: ${JSON.stringify(steerUsers)}`);
}
if (!runtime.liveTurn?.timeline?.some((entry) => entry.kind === "notice" && entry.code === "turnSteered")) {
  throw new Error(`turn.steered must be visible in the live timeline: ${JSON.stringify(runtime.liveTurn?.timeline)}`);
}
const steerTimelineEntry = runtime.liveTurn.timeline.find((entry) => entry.kind === "notice" && entry.code === "turnSteered");
if (!renderableTimeline.resolveNoticeDetail(steerTimelineEntry).includes("add this constraint")) {
  throw new Error(`turn.steered notice must render the steered text through the notice resolver: ${JSON.stringify(steerTimelineEntry)}`);
}
store.syncCommittedMessages("steer-live", [
  {
    id: "persisted-original",
    role: "user",
    content: "original request",
    turnId: "turn_steer",
    timestamp: "2026-06-01T00:00:06.001Z",
  },
]);
runtime = store.getRuntimeSession("steer-live");
if (!runtime.committedMessages.some((message) => message.content === "add this constraint" && message.meta?.steer)) {
  throw new Error(`busy history sync must preserve local live steer until persistence catches up: ${JSON.stringify(runtime.committedMessages)}`);
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

// --- session-list "needs attention" flag ---------------------------------
// A background turn that finishes (not the viewed session) flags the list.
store.applyRuntimeBatch({
  sessionId: "att1",
  batchSeq: 1,
  events: [
    { id: "a1", type: "turn.started", sessionId: "att1", turnId: "t1", seq: 1, ts: 4000, source: "test", payload: {} },
    { id: "a2", type: "turn.completed", sessionId: "att1", turnId: "t1", seq: 2, ts: 4001, source: "test", payload: { assistant: "ok" } },
  ],
});
if (store.getSessionAttention("att1") !== "done") {
  throw new Error(`background completion should flag "done", got ${store.getSessionAttention("att1")}`);
}
store.clearSessionAttention("att1");
if (store.getSessionAttention("att1") !== null) {
  throw new Error("viewing a session should clear its attention flag");
}

// Replayed (load-time) terminals must NOT flag — else every session would light
// up on startup.
store.applyRuntimeBatch({
  sessionId: "att2",
  batchSeq: 1,
  events: [
    { id: "b1", type: "turn.started", sessionId: "att2", turnId: "t1", seq: 1, ts: 5000, source: "test", payload: {} },
    { id: "b2", type: "turn.failed", sessionId: "att2", turnId: "t1", seq: 2, ts: 5001, source: "test", payload: {} },
  ],
}, { allowReplay: true });
if (store.getSessionAttention("att2") !== null) {
  throw new Error("replayed terminals must not raise the attention flag");
}

// A successful evidence retry supersedes its already-committed safe fallback.
// The event arrives after the old terminal, so it must bypass terminal-event
// suppression and remove only that assistant bubble, preserving the user turn.
store.applyRuntimeBatch({
  sessionId: "supersession",
  batchSeq: 1,
  events: [
    { id: "sup-1", type: "turn.started", sessionId: "supersession", turnId: "old", seq: 1, ts: 6000, source: "test", payload: {} },
    { id: "sup-2", type: "turn.completed", sessionId: "supersession", turnId: "old", seq: 2, ts: 6001, source: "test", payload: { assistant: "正在等待可靠证据。" } },
    { id: "sup-3", type: "assistant.supersedes", sessionId: "supersession", turnId: "old", seq: 3, ts: 6002, source: "test", payload: { supersedes: "old" } },
  ],
});
runtime = store.getRuntimeSession("supersession");
if (runtime.committedMessages.some((message) => message.role === "assistant" && message.turnId === "old")) {
  throw new Error("assistant.supersedes must remove the replaced fallback bubble");
}

// --- TaskRun observability -------------------------------------------------
store.applyRuntimeBatch({
  sessionId: "task-store",
  batchSeq: 1,
  events: [
    {
      id: "task-start",
      type: "turn.started",
      sessionId: "task-store",
      turnId: "task-turn",
      seq: 1,
      ts: 7000,
      source: "test",
      payload: {},
    },
    {
      id: "task-created",
      type: "task.created",
      sessionId: "task-store",
      turnId: "task-turn",
      seq: 2,
      ts: 7001,
      source: "test",
      payload: {
        taskRun: {
          id: "task_run_1",
          turnId: "task-turn",
          status: "running",
          phase: "starting",
          plan: [{ id: "execute", title: "Execute", status: "in_progress" }],
          evidence: [],
          risks: [],
        },
      },
    },
    {
      id: "task-live",
      type: "task.liveness.updated",
      sessionId: "task-store",
      turnId: "task-turn",
      seq: 3,
      ts: 7002,
      source: "test",
      payload: {
        taskRunId: "task_run_1",
        liveness: { status: "no_visible_progress", lastNoticeCode: "longWait", lastHeartbeatAt: 7002 },
      },
    },
    {
      id: "task-risk",
      type: "task.risk.detected",
      sessionId: "task-store",
      turnId: "task-turn",
      seq: 4,
      ts: 7003,
      source: "test",
      payload: {
        taskRunId: "task_run_1",
        risk: { code: "NO_VISIBLE_PROGRESS", level: "info", message: "still busy" },
      },
    },
    {
      id: "task-evidence",
      type: "task.evidence.added",
      sessionId: "task-store",
      turnId: "task-turn",
      seq: 5,
      ts: 7004,
      source: "test",
      payload: {
        taskRunId: "task_run_1",
        evidence: { kind: "tool_result", label: "Read done", status: "done" },
      },
    },
    {
      id: "task-terminal",
      type: "turn.completed",
      sessionId: "task-store",
      turnId: "task-turn",
      seq: 6,
      ts: 7005,
      source: "test",
      payload: {
        assistant: "done",
        record: {
          meta: {
            taskRun: {
              id: "task_run_1",
              turnId: "task-turn",
              status: "completed",
              completionStatus: "delivered_unverified",
              phase: "completed",
              liveness: { status: "completed" },
              evidence: [{ kind: "tool_result", label: "Read done", status: "done" }],
              risks: [{ code: "NO_VISIBLE_PROGRESS", level: "info" }],
            },
          },
        },
      },
    },
  ],
});
runtime = store.getRuntimeSession("task-store");
if (runtime.liveTurn?.taskRun?.status !== "completed") {
  throw new Error(`terminal record should preserve TaskRun status: ${JSON.stringify(runtime.liveTurn?.taskRun)}`);
}
if (runtime.liveTurn?.taskRun?.completionStatus !== "delivered_unverified") {
  throw new Error(`renderer state must preserve truthful completion status: ${JSON.stringify(runtime.liveTurn?.taskRun)}`);
}
if (runtime.liveTurn?.taskRun?.evidence?.[0]?.kind !== "tool_result") {
  throw new Error(`TaskRun evidence should be visible in renderer state: ${JSON.stringify(runtime.liveTurn?.taskRun)}`);
}
if (runtime.liveTurn?.taskRun?.risks?.[0]?.code !== "NO_VISIBLE_PROGRESS") {
  throw new Error(`TaskRun risks should be visible in renderer state: ${JSON.stringify(runtime.liveTurn?.taskRun)}`);
}

// A stale non-idle phase without a live turn can happen after interrupted
// renderer replay or failed startup hydration. It must not keep showing the
// "current answer is still running" send-choice dialog.
{
  const stale = store.getRuntimeSession("stale-busy");
  stale.phase = "streaming";
  stale.turnId = null;
  stale.liveTurn = null;
  if (!store.canSend("stale-busy")) {
    throw new Error("stale non-idle phase without a turn should not block sending");
  }
  if (store.getRuntimeSession("stale-busy").phase !== "idle") {
    throw new Error("canSend should normalize stale non-idle phase back to idle");
  }
}

// OpenCode Desktop keeps a bounded client-side session cache. Lily should do
// the same for runtime/timeline state: many idle sessions must not accumulate
// forever, but running sessions must survive eviction.
store.applyRuntimeBatch({
  sessionId: "cache-running",
  batchSeq: 1,
  events: [
    { id: "cache-running-start", type: "turn.started", sessionId: "cache-running", turnId: "tr", seq: 1, ts: 6000, source: "test", payload: {} },
  ],
});
for (let index = 0; index < store.SESSION_RUNTIME_CACHE_LIMIT + 12; index += 1) {
  store.getRuntimeSession(`cache-idle-${index}`);
}
const cachedIds = store.getCachedRuntimeSessionIds();
if (cachedIds.length > store.SESSION_RUNTIME_CACHE_LIMIT) {
  throw new Error(`runtime cache should be bounded at ${store.SESSION_RUNTIME_CACHE_LIMIT}, got ${cachedIds.length}`);
}
if (!cachedIds.includes("cache-running")) {
  throw new Error("runtime cache eviction must preserve running sessions");
}
if (cachedIds.includes("cache-idle-0")) {
  throw new Error("runtime cache eviction should drop the oldest idle session first");
}

// Read-only status probes used by navigation surfaces must not create runtime
// entries or perturb LRU order for sessions that have never been active.
{
  const beforePeekIds = store.getCachedRuntimeSessionIds();
  for (let index = 0; index < 45; index += 1) {
    const status = store.peekSessionRuntimeStatus(`peek-unknown-${index}`);
    if (status.running || status.attention !== null) {
      throw new Error(`unknown runtime status should be idle: ${JSON.stringify(status)}`);
    }
  }
  const afterPeekIds = store.getCachedRuntimeSessionIds();
  if (JSON.stringify(afterPeekIds) !== JSON.stringify(beforePeekIds)) {
    throw new Error(
      `read-only runtime status must not create or touch cache entries: ${JSON.stringify({
        beforePeekIds,
        afterPeekIds,
      })}`,
    );
  }
}

// Regression: on idle reopen the committed-message dedup must collapse a rich
// local assistant turn (answer in record.assistantText, empty content) and its
// official OpenCode refresh (plain text, different key) into ONE bubble — else
// the finished turn duplicates below itself every time the conversation opens.
store.syncCommittedMessages("dup-reopen", [
  { id: "u1", role: "user", turnId: "T1", content: "q", timestamp: "2026-07-14T10:00:00.000Z" },
  { role: "assistant", turnId: "T1", engineMessageId: "E1", content: "", timestamp: "2026-07-14T10:00:06.000Z", record: { resultBlocks: [{ title: "Relevant Files" }], assistantText: "完成了。" } },
  { id: "oe1", role: "assistant", content: "完成了。", timestamp: "2026-07-14T10:00:06.000Z" },
]);
const dupReopen = store.getRuntimeSession("dup-reopen").committedMessages.filter((m) => m.role === "assistant");
if (dupReopen.length !== 1) {
  throw new Error(`idle-reopen dedup must collapse the rich local turn and its official refresh into one assistant bubble, got ${dupReopen.length}`);
}
if (!dupReopen[0].record?.resultBlocks?.length) {
  throw new Error("idle-reopen dedup must keep the richer local render record");
}

// Regression: a later canonical sync may carry the same assistant turn with a
// stable id but a compact/poor record. The renderer must use that incoming
// message for canonical identity while keeping the richer local render record,
// otherwise artifact grids/process collapse disappear or re-expand after a
// delayed refresh.
store.syncCommittedMessages("rich-record-refresh", [
  {
    role: "assistant",
    turnId: "rich-turn",
    content: "done",
    timestamp: "2026-07-14T10:10:00.000Z",
    record: {
      turnId: "rich-turn",
      assistantText: "done",
      resultBlocks: [{ type: "artifact", path: "/tmp/report.md" }],
      artifacts: [{ path: "/tmp/report.md" }],
      timeline: [{ kind: "tool", id: "write_1", name: "Write", status: "done" }],
    },
  },
]);
store.syncCommittedMessages("rich-record-refresh", [
  {
    id: "official-rich-turn",
    role: "assistant",
    turnId: "rich-turn",
    content: "done",
    timestamp: "2026-07-14T10:10:01.000Z",
    record: {
      turnId: "rich-turn",
      assistantText: "done",
      resultBlocks: [],
      artifacts: [],
      timeline: [],
      persistenceCompact: true,
    },
  },
]);
const richRefresh = store.getRuntimeSession("rich-record-refresh").committedMessages.filter((m) => m.role === "assistant");
if (richRefresh.length !== 1) {
  throw new Error(`canonical refresh should still be one assistant turn, got ${richRefresh.length}`);
}
if (richRefresh[0].id !== "official-rich-turn") {
  throw new Error(`canonical incoming identity should survive, got ${richRefresh[0].id}`);
}
if (!richRefresh[0].record?.resultBlocks?.length || !richRefresh[0].record?.artifacts?.length) {
  throw new Error(`canonical refresh must keep richer existing render record: ${JSON.stringify(richRefresh[0].record)}`);
}

// Reopen-duplicate (the real 张钦 case) at the renderer store: reopen loads the
// RICH committed turn (local-first) and the official refresh copy of the SAME
// turn. The rich text is a SUPERSET of the official plain answer (✓ step summary
// + report sections), and the two have different keys (engine re-issued ids). The
// old exact-text dedup let both survive → the answer showed twice. Substantial
// overlap must now collapse them into ONE assistant that keeps the richer record.
// Note the internal SPACE in "金水。 调候" — the official engine copy keeps it, the
// Lily copy drops it, and lengths differ. Exact/plain-includes miss this; only
// whitespace-insensitive comparison catches the near-duplicate (the real bug).
const zqOfficialPlain =
  "壬水日主，偏印格，身弱，用神火，忌神金水。 调候申月壬水，专用戊土，次取丁火佐戊制庚。事业方面偏印格配华盖三重，适合技术研究与学术，当前壬辰大运三十四至四十三岁为事业上升积累期。财运偏财透干但身弱难担，四十四岁后木火大运渐入佳境，五十岁前后达到高峰。感情方面妻宫七杀坐戌，配偶能力强但需要磨合。";
const zqRichSuperset =
  "✓ 八字排盘 ✓ 紫微斗数 ✓ 六爻占卜\n\n" + zqOfficialPlain.replace("。 调候", "。调候") + "\n\n📦 交付物：报告.pdf、分析全图.svg。";
store.syncCommittedMessages("s_reopen_dup", [
  { id: "u_zq", role: "user", turnId: "turn_zq", content: "帮我分析张钦", timestamp: "2026-06-23T16:00:00.000Z" },
  {
    id: "local_rich_zq",
    role: "assistant",
    turnId: "turn_zq",
    content: zqRichSuperset,
    timestamp: "2026-06-23T16:00:10.000Z",
    record: {
      assistantText: zqRichSuperset,
      resultBlocks: [{ type: "artifact", artifactType: "svg", path: "/tmp/chart.svg" }],
      artifacts: [{ path: "/tmp/report.pdf" }],
    },
  },
  {
    id: "official_plain_zq_no_engine_match",
    role: "assistant",
    content: zqOfficialPlain,
    timestamp: "2026-06-23T16:00:11.000Z",
    record: { assistantText: zqOfficialPlain },
  },
]);
runtime = store.getRuntimeSession("s_reopen_dup");
const zqAssistants = runtime.committedMessages.filter((m) => m.role === "assistant");
if (zqAssistants.length !== 1) {
  throw new Error(`reopen must not duplicate a rich-superset turn: got ${zqAssistants.length} assistants`);
}
if (!zqAssistants[0].record?.resultBlocks?.length) {
  throw new Error("the surviving single assistant must keep the richer local record");
}

console.log("session-runtime-store: ok");
