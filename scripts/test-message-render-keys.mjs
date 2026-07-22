#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  collectEvictedMessageKeys,
  collectUnrenderedCommittedMessages,
  messageKey,
  removeCommittedArticlesByKeys,
} from "../src/renderer/modules/message-render-keys.js";

const messages = Array.from({ length: 8 }, (_, index) => ({
  id: `msg_${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `message ${index}`,
}));

const keys = new Set();
const firstPass = collectUnrenderedCommittedMessages(messages, keys);
assert.equal(firstPass.length, messages.length);
assert.equal(keys.size, messages.length);

// renderConversation() starts a chunked append when history is longer than the
// first paint chunk, then renderRuntimeSession() can run again in the same
// frame. Keys must be reserved when the first renderer claims the work, before
// any async chunk appends to the DOM, or later messages are rendered twice.
const secondPass = collectUnrenderedCommittedMessages(messages, keys);
assert.equal(secondPass.length, 0);

const fallback = { role: "assistant", timestamp: "2026-06-18T01:02:03.000Z", content: "same" };
assert.equal(messageKey(fallback, 3), "assistant:2026-06-18T01:02:03.000Z:3");

const sameTurnWithSteer = [
  { role: "user", turnId: "turn_live", content: "original prompt" },
  { role: "user", turnId: "turn_live", content: "follow-up prompt", meta: { steer: true, steerSeq: 1 } },
  { role: "assistant", turnId: "turn_live", content: "answer" },
];
const steerKeys = new Set();
const steerPass = collectUnrenderedCommittedMessages(sameTurnWithSteer, steerKeys);
assert.equal(steerPass.length, sameTurnWithSteer.length);
assert.equal(messageKey(sameTurnWithSteer[1], 1), "user:turn_live:steer:1");

// Window eviction: keys outside the current render window are collected and
// removed from the bookkeeping set; keys inside stay.
const windowKeys = new Set();
collectUnrenderedCommittedMessages(messages, windowKeys);
const evicted = collectEvictedMessageKeys(messages.slice(-3), windowKeys);
assert.deepEqual(evicted, messages.slice(0, 5).map((message, index) => messageKey(message, index)));
assert.equal(windowKeys.size, 3);
assert.deepEqual(collectEvictedMessageKeys(messages.slice(-3), windowKeys), [], "second pass evicts nothing");

// DOM eviction removes only the articles carrying an evicted data-message-key.
function fakeNode(key) {
  return {
    dataset: { messageKey: key },
    removed: false,
    remove() {
      this.removed = true;
    },
  };
}
const kept = fakeNode("msg_6");
const dropped = fakeNode("msg_1");
const liveArticle = { dataset: {}, removed: false, remove() { this.removed = true; } };
const listEl = { querySelectorAll: () => [kept, dropped, liveArticle] };
removeCommittedArticlesByKeys(listEl, ["msg_1"]);
assert.equal(dropped.removed, true);
assert.equal(kept.removed, false);
assert.equal(liveArticle.removed, false, "nodes without a message key are never touched");
removeCommittedArticlesByKeys(listEl, []);
removeCommittedArticlesByKeys(null, ["msg_1"]);

console.log("message-render-keys: ok");
