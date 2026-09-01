#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCollaborationOutboxTransport } = require("../src/main/collaboration/message-outbox-transport.js");

const calls = [];
const transport = createCollaborationOutboxTransport({ deviceId: "device-a", client: {
  async submitMessage(command) {
    calls.push(command);
    return { ok: true, result: { eventId: "event-2", message: { id: "message-1", conversationId: "conversation-1", seq: "2", revision: "2" } } };
  },
  async lookupCommandReceipt(command) { return command; },
} });

assert.equal(await transport.submit({ commandType: "message.edit", conversationId: "conversation-1", clientCommandId: "edit-1", messageId: "message-1", expectedRevision: 1, bodyText: "changed", internalOnly: "never forwarded" }), null, "numeric strings in an HTTP mutation response are not strict commit proof");
assert.deepEqual(calls[0], { action: "edit", deviceId: "device-a", conversationId: "conversation-1", clientCommandId: "edit-1", messageId: "message-1", expectedRevision: 1, bodyText: "changed" }, "the production transport uses a closed action whitelist rather than spreading internal outbox fields");
transport.client = undefined;

const strict = createCollaborationOutboxTransport({ deviceId: "device-a", client: {
  async submitMessage() { return { ok: true, result: { eventId: "event-3", message: { id: "message-1", conversationId: "conversation-1", seq: 3, revision: 2 } } }; },
  async lookupCommandReceipt(command) { return command; },
} });
assert.deepEqual(await strict.submit({ commandType: "message.edit", conversationId: "conversation-1", clientCommandId: "edit-1", messageId: "message-1", expectedRevision: 1, bodyText: "changed" }),
  { committed: true, state: "completed", commandType: "message.edit", eventId: "event-3", eventSequence: 3, sequence: 3, conversationId: "conversation-1", messageId: "message-1", revision: 2 }, "a strict typed edit response becomes receipt-equivalent evidence");
await assert.rejects(() => strict.submit({ commandType: "relationship.change", conversationId: "conversation-1", clientCommandId: "bad" }), (error) => error?.code === "COLLAB_OUTBOX_COMMAND_UNSUPPORTED");
console.log("collaboration mutation transport: ok");
