#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const {
  createCollaborationMessageCrypto,
  redactMessageCryptoForLog,
} = await import("../server/src/services/collaboration/message-crypto.js");

const kekV1 = Buffer.alloc(32, 1);
const kekV2 = Buffer.alloc(32, 2);
const context = { messageId: "message-1", conversationId: "conversation-1", revision: 1 };

{
  const crypto = createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: new Map([[1, kekV1]]) });
  const encrypted = crypto.encrypt({ plaintext: Buffer.from("never store this plaintext"), ...context });
  assert.equal(encrypted.keyVersion, 1);
  assert.ok(Buffer.isBuffer(encrypted.ciphertext));
  assert.equal(encrypted.ciphertext.includes(Buffer.from("never store this plaintext")), false, "the database payload is an authenticated encrypted envelope");
  assert.deepEqual(crypto.decrypt({ ...encrypted, ...context }), Buffer.from("never store this plaintext"));
  assert.throws(
    () => crypto.decrypt({ ...encrypted, ...context, revision: 2 }),
    (error) => error?.code === "COLLAB_MESSAGE_CIPHERTEXT_INVALID",
    "AAD binds ciphertext to its message revision",
  );
  assert.throws(
    () => crypto.decrypt({ ...encrypted, ...context, conversationId: "other-conversation" }),
    (error) => error?.code === "COLLAB_MESSAGE_CIPHERTEXT_INVALID",
    "AAD binds ciphertext to its conversation",
  );
}

{
  const oldCrypto = createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: kekV1 } });
  const oldEnvelope = oldCrypto.encrypt({ plaintext: Buffer.from("old"), ...context });
  const rotated = createCollaborationMessageCrypto({ currentKekVersion: 2, kekByVersion: { 1: kekV1, 2: kekV2 } });
  const newEnvelope = rotated.encrypt({ plaintext: Buffer.from("new"), ...context });
  assert.equal(newEnvelope.keyVersion, 2, "new writes use only the current independently configured message KEK");
  assert.deepEqual(rotated.decrypt({ ...oldEnvelope, ...context }), Buffer.from("old"), "key rotation keeps readable old envelopes while their KEK exists");
  assert.throws(
    () => createCollaborationMessageCrypto({ currentKekVersion: 2, kekByVersion: { 2: kekV2 } }).decrypt({ ...oldEnvelope, ...context }),
    (error) => error?.code === "COLLAB_MESSAGE_KEK_VERSION_UNKNOWN",
  );
}

{
  const crypto = createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: kekV1 }, randomBytes });
  const encrypted = crypto.encrypt({ plaintext: Buffer.from("integrity"), ...context });
  const tampered = Buffer.from(encrypted.ciphertext);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(
    () => crypto.decrypt({ ciphertext: tampered, keyVersion: encrypted.keyVersion, ...context }),
    (error) => error?.code === "COLLAB_MESSAGE_CIPHERTEXT_INVALID",
    "GCM authentication failures never return partial plaintext",
  );
  const redacted = redactMessageCryptoForLog({
    plaintext: "integrity", ciphertext: encrypted.ciphertext, wrappedDek: "secret", kek: kekV1, keyVersion: encrypted.keyVersion,
  });
  assert.deepEqual(redacted, { keyVersion: 1, ciphertextBytes: encrypted.ciphertext.length }, "logs retain only safe crypto metadata");
  assert.equal(JSON.stringify(redacted).includes("secret"), false);
}

console.log("collaboration message crypto: ok");
