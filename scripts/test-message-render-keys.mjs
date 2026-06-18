#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  collectUnrenderedCommittedMessages,
  messageKey,
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

console.log("message-render-keys: ok");
