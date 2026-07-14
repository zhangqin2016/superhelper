import assert from "node:assert/strict";
import {
  mergeLatestConversationPage,
  mergeOlderConversationPage,
} from "../src/renderer/modules/conversation-pagination.js";

{
  const local = [
    {
      id: "local-user-latest",
      role: "user",
      content: "today's question",
      timestamp: "2026-07-06T09:00:00.000Z",
      turnId: "turn-latest",
    },
  ];
  const official = [
    {
      id: "official-assistant-old",
      role: "assistant",
      content: "older answer",
      timestamp: "2026-07-05T23:00:00.000Z",
      turnId: "turn-old",
    },
  ];
  const merged = mergeLatestConversationPage(local, official);
  assert.equal(
    merged.some((message) => message.content === "today's question"),
    true,
    "official refresh must not drop locally visible latest messages",
  );
  assert.equal(merged.map((message) => message.content).join("|"), "older answer|today's question");
}

{
  const local = [{
    id: "local-user",
    role: "user",
    content: "same question",
    timestamp: "2026-07-06T09:00:00.000Z",
    turnId: "turn-1",
  }];
  const official = [{
    id: "official-user",
    role: "user",
    content: "same question",
    timestamp: "2026-07-06T09:00:10.000Z",
    meta: { source: "opencode" },
  }];
  const merged = mergeLatestConversationPage(local, official);
  assert.equal(merged.length, 1, "equivalent official messages should enrich, not duplicate");
  assert.equal(merged[0].turnId, "turn-1", "local turn metadata should survive official refresh");
  assert.equal(merged[0].meta.source, "opencode");
}

{
  const local = [{
    id: "local-assistant",
    role: "assistant",
    content: "answer",
    timestamp: "2026-07-06T09:01:00.000Z",
    turnId: "turn-rich",
    record: {
      turnId: "turn-rich",
      assistantText: "answer",
      artifacts: [{ path: "/tmp/report.md", relativePath: "output/report.md" }],
      resultBlocks: [{ type: "artifact", artifactType: "markdown", path: "/tmp/report.md" }],
      timeline: [{ kind: "tool", title: "write" }],
    },
  }];
  const official = [{
    id: "official-assistant",
    role: "assistant",
    content: "answer",
    timestamp: "2026-07-06T09:01:05.000Z",
    turnId: "turn-rich",
    record: {
      turnId: "turn-rich",
      assistantText: "answer",
      artifacts: [],
      resultBlocks: [],
      timeline: [],
      persistenceCompact: true,
    },
    meta: { source: "projection" },
  }];
  const merged = mergeLatestConversationPage(local, official);
  assert.equal(merged.length, 1, "equivalent assistant messages should merge");
  assert.equal(merged[0].record.resultBlocks.length, 1, "compact official refresh must not replace a richer local record");
  assert.equal(merged[0].record.artifacts.length, 1, "local artifact metadata must survive official refresh");
  assert.equal(merged[0].meta.source, "projection", "official metadata should still enrich the merged message");
}

{
  const local = [{
    id: "local-final",
    role: "assistant",
    content: "最终答案。\n\n证据门槛：上面的结论缺少可核验证据支撑。",
    timestamp: "2026-07-06T09:01:00.000Z",
    turnId: "turn-delayed-refresh",
    record: {
      turnId: "turn-delayed-refresh",
      assistantText: "先看下文件。最终答案。\n\n证据门槛：上面的结论缺少可核验证据支撑。",
      timeline: [
        { kind: "text", text: "先看下文件。" },
        { kind: "text", text: "最终答案。" },
      ],
      resultBlocks: [{ type: "artifact", path: "/tmp/report.md" }],
    },
  }];
  const official = [{
    id: "official-final-different-id",
    role: "assistant",
    content: "先看下文件。最终答案。\n\n证据门槛：上面的结论缺少可核验证据支撑。",
    timestamp: "2026-07-06T09:01:05.000Z",
    record: {
      assistantText: "先看下文件。最终答案。\n\n证据门槛：上面的结论缺少可核验证据支撑。",
      timeline: [],
      resultBlocks: [],
    },
  }];
  const merged = mergeLatestConversationPage(local, official);
  assert.equal(merged.length, 1, "delayed official refresh must merge overlapping assistant text instead of appending a duplicate");
  assert.equal(merged[0].turnId, "turn-delayed-refresh", "local turn identity must survive delayed official refresh");
  assert.equal(merged[0].record.resultBlocks.length, 1, "local render record must survive delayed official refresh");
}

{
  // Regression: reopening a FINISHED conversation must not append a duplicate of
  // the last turn. A rich local turn keeps its answer in `record.assistantText`
  // with an EMPTY top-level `content`; the background official OpenCode refresh
  // returns the same turn as plain text under a DIFFERENT key (it never inherited
  // the Lily turnId). They must collapse into ONE assistant bubble, not two.
  const local = [
    { id: "u1", role: "user", turnId: "T1", content: "127.0.0.1:3002 在哪个库", timestamp: "2026-07-14T10:00:00.000Z" },
    {
      role: "assistant",
      turnId: "T1",
      engineMessageId: "E1",
      content: "",
      timestamp: "2026-07-14T10:00:06.000Z",
      record: { resultBlocks: [{ title: "Relevant Files" }], assistantText: "任务已经完成了——定位了数据库。" },
    },
  ];
  const official = [
    { id: "ou1", role: "user", content: "127.0.0.1:3002 在哪个库", timestamp: "2026-07-14T10:00:00.000Z" },
    { id: "oe1", role: "assistant", content: "任务已经完成了——定位了数据库。", timestamp: "2026-07-14T10:00:06.000Z" },
  ];
  const merged = mergeLatestConversationPage(local, official);
  assert.equal(merged.filter((m) => m.role === "assistant").length, 1, "official refresh must not duplicate a rich local assistant turn (empty content, answer in record) on reopen");
  assert.equal(merged.length, 2, "reopened finished conversation keeps exactly its user+assistant turn");
  assert.equal(merged.find((m) => m.role === "assistant").record?.resultBlocks?.length, 1, "merge preserves the local render record (Relevant Files)");
}

{
  const merged = mergeOlderConversationPage(
    [{ id: "old", role: "user", content: "old" }],
    [{ id: "new", role: "user", content: "new" }],
  );
  assert.deepEqual(merged.map((message) => message.id), ["old", "new"]);
}

console.log("conversation pagination tests passed");
