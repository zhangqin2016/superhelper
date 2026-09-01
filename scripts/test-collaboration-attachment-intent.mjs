import assert from "node:assert/strict";
import { createHmacMessageBodyIntentSigner, signedBodyIntent, resolveStableBodyIntent } from "../server/src/services/collaboration/message-input.js";

const signer = createHmacMessageBodyIntentSigner({ key: Buffer.alloc(32, 1) });
const input = { bodyText: "caption", conversationId: "c", actorUserId: "a", commandType: "message.create", attachmentIds: ["one"], attachmentPurpose: "attachment", replyToMessageId: "reply", mentionUserIds: ["b"] };
for (const change of [{ attachmentIds: ["two"] }, { attachmentPurpose: "workspace" }, { replyToMessageId: "other" }, { mentionUserIds: ["c"] }]) {
  assert.notEqual(signer.sign(input), signer.sign({ ...input, ...change }), "HMAC must cover attachment/message intent, not only its caption");
}
const attachmentOnly = { ...input, bodyText: null };
assert.ok(signedBodyIntent(signer, attachmentOnly)?.value, "attachment-only commands have signed intent");
const old = signedBodyIntent(signer, attachmentOnly);
const rotated = createHmacMessageBodyIntentSigner({ currentKeyVersion: 2, keysByVersion: { 1: Buffer.alloc(32, 1), 2: Buffer.alloc(32, 2) } });
const originalInput = { ...attachmentOnly, bodyIntent: signedBodyIntent(rotated, attachmentOnly).value, bodyIntentKeyVersion: 2 };
const resolved = resolveStableBodyIntent({ bodyIntentSigner: rotated, originalInput, ...attachmentOnly })({ receipt: { responsePayload: { bodyIntentKeyVersion: 1 } } });
assert.equal(resolved.bodyIntent, old.value, "retained key and complete attachment intent survive lost ACK plus key rotation");
console.log("collaboration attachment intent: attachment-only, metadata binding and rotation passed");
