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
  const merged = mergeOlderConversationPage(
    [{ id: "old", role: "user", content: "old" }],
    [{ id: "new", role: "user", content: "new" }],
  );
  assert.deepEqual(merged.map((message) => message.id), ["old", "new"]);
}

console.log("conversation pagination tests passed");
