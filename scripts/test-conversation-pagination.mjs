#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  conversationMessageKey,
  mergeOlderConversationPage,
  shouldContinueLoadingOlder,
} from "../src/renderer/modules/conversation-pagination.js";

assert.equal(conversationMessageKey({ id: "m1", role: "user" }), "id:m1", "id is the stable primary key");
assert.equal(conversationMessageKey({ engineMessageId: "e1", role: "assistant" }), "id:e1", "engine message id is a stable key");
assert.equal(conversationMessageKey({ role: "assistant", turnId: "t1" }), "turn:assistant:t1", "turn id is fallback key");

{
  const older = [
    { id: "m1", role: "user", content: "old" },
    { id: "m2", role: "assistant", content: "old answer" },
  ];
  const current = [
    { id: "m2", role: "assistant", content: "newer hydrated answer" },
    { id: "m3", role: "user", content: "latest" },
  ];
  const merged = mergeOlderConversationPage(older, current);
  assert.deepEqual(
    merged.map((message) => `${message.id}:${message.content}`),
    ["m1:old", "m2:newer hydrated answer", "m3:latest"],
    "merge keeps chronological order and lets current hydrated rows win duplicates",
  );
}

assert.equal(shouldContinueLoadingOlder({ hasMore: true, pageSize: 10, previousCount: 20, mergedCount: 20 }), true, "continue when a page produced no new merged rows");
assert.equal(shouldContinueLoadingOlder({ hasMore: true, pageSize: 10, previousCount: 20, mergedCount: 21 }), false, "stop once visible rows grow");
assert.equal(shouldContinueLoadingOlder({ hasMore: false, pageSize: 10, previousCount: 20, mergedCount: 20 }), false, "stop at end");
assert.equal(shouldContinueLoadingOlder({ hasMore: true, pageSize: 0, previousCount: 20, mergedCount: 20 }), false, "stop on empty page");

{
  let merged = [{ id: "m2", role: "user", content: "current" }];
  const duplicateOnly = [{ id: "m2", role: "user", content: "current duplicate" }];
  const genuinelyOlder = [{ id: "m1", role: "user", content: "older" }];
  const previousCount = merged.length;
  merged = mergeOlderConversationPage(duplicateOnly, merged);
  assert.equal(shouldContinueLoadingOlder({ hasMore: true, pageSize: duplicateOnly.length, previousCount, mergedCount: merged.length }), true, "duplicate-only page asks for another page");
  const nextCount = merged.length;
  merged = mergeOlderConversationPage(genuinelyOlder, merged);
  assert.equal(shouldContinueLoadingOlder({ hasMore: true, pageSize: genuinelyOlder.length, previousCount: nextCount, mergedCount: merged.length }), false, "new older row stops the loop");
}

console.log("conversation-pagination: ok");
