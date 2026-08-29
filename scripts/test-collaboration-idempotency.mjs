#!/usr/bin/env node
// A client command id is safe to retry only when it names exactly the same
// canonical request. Array order is deliberately meaningful for attachment
// cards, while object key order and null/undefined representation are not.

import assert from "node:assert/strict";

const {
  canonicalRequestJson,
  collaborationRequestFingerprint,
  assertReusableCommandReceipt,
  sanitizeCommandReceiptPayload,
} = await import("../server/src/services/collaboration/idempotency.js");
const { writeCollaborationEvent } = await import("../server/src/services/collaboration/event-writer.js");

const first = {
  conversationId: "conv-1",
  content: { z: null, a: undefined, nested: { beta: 2, alpha: 1 } },
  attachmentIds: ["object-b", "object-a"],
};
const reorderedKeys = {
  attachmentIds: ["object-b", "object-a"],
  content: { nested: { alpha: 1, beta: 2 }, a: null, z: null },
  conversationId: "conv-1",
};

assert.equal(
  canonicalRequestJson(first),
  canonicalRequestJson(reorderedKeys),
  "object key order and undefined/null use one canonical representation",
);
assert.equal(
  collaborationRequestFingerprint(first),
  collaborationRequestFingerprint(reorderedKeys),
  "equivalent canonical requests receive one SHA-256 fingerprint",
);
assert.notEqual(
  collaborationRequestFingerprint(first),
  collaborationRequestFingerprint({ ...reorderedKeys, attachmentIds: ["object-a", "object-b"] }),
  "attachment order remains part of the user command",
);

assert.doesNotThrow(() => assertReusableCommandReceipt(
  { requestFingerprint: collaborationRequestFingerprint(first) },
  collaborationRequestFingerprint(reorderedKeys),
));
assert.throws(
  () => assertReusableCommandReceipt(
    { requestFingerprint: collaborationRequestFingerprint(first) },
    collaborationRequestFingerprint({ ...first, body: "different ciphertext" }),
  ),
  (error) => error?.code === "IDEMPOTENCY_KEY_REUSED",
  "one idempotency key must never replay a result for a changed body",
);

assert.deepEqual(
  sanitizeCommandReceiptPayload({
    eventId: "evt-1",
    token: "must-not-persist",
    authorization: "Bearer must-not-persist",
    clientSecret: "must-not-persist",
    APIKey: "must-not-persist",
    wrappedDek: "must-not-persist",
    downloadUrl: "https://signed.example/object",
    preSignedUrl: "https://must-not-persist.example/object",
    localPath: "/Users/alice/secret.txt",
    nested: { messageId: "msg-1", accessToken: "nope", apiKey: "nope", encryptionKey: "nope", authorizationHeader: "nope", privateKeyPem: "nope", dbPassword: "nope", JWTToken: "nope", XApiKey: "nope", SSOToken: "nope" },
  }),
  { eventId: "evt-1", nested: { messageId: "msg-1" } },
  "receipts retain durable identifiers only, never credentials or local paths",
);

await assert.rejects(
  writeCollaborationEvent({
    insertInto() { return { values() { return { executeTakeFirst: async () => undefined }; } }; },
  }, {
    id: "evt-1", conversationId: "conv-1", seq: 1, type: "message.created",
    actorUserId: "user-1", actorDeviceId: "device-1", clientCommandId: "command-1",
    payload: { JWTToken: "must-not-enter-event", nested: { sessionCookie: "must-not-enter-event" } },
  }),
  /JWTToken/,
  "events must reject authorization/key material rather than persist it",
);

console.log("collaboration idempotency: ok");
