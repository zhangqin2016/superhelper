import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { createCollaborationMessageCrypto } from "../server/src/services/collaboration/message-crypto.js";
import { createCollaborationMessageService, createHmacMessageBodyIntentSigner } from "../server/src/services/collaboration/messages.js";

const crypto = createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: Buffer.alloc(32, 7) } });
assert.equal(typeof crypto.encryptReplySnapshot, "function", "snapshot encryption has a closed independent purpose");
const context = { messageId: "reply", conversationId: "conversation", revision: 1 };
const encrypted = crypto.encryptReplySnapshot({ ...context, plaintext: Buffer.from("snapshot") });
assert.equal(crypto.decryptReplySnapshot({ ...context, ...encrypted, revision: 9 }).toString(), "snapshot", "snapshot revision stays one across reply body edits");
for (const changed of [{ messageId: "other" }, { conversationId: "other" }, { keyVersion: 2 }]) {
  assert.throws(() => crypto.decryptReplySnapshot({ ...context, ...encrypted, ...changed }), { code: "COLLAB_MESSAGE_CIPHERTEXT_INVALID" });
}
assert.throws(() => crypto.decrypt({ ...context, ...encrypted }), { code: "COLLAB_MESSAGE_CIPHERTEXT_INVALID" });
assert.throws(() => crypto.decryptReplySnapshot({ ...context, ...crypto.encrypt({ ...context, plaintext: Buffer.from("body") }) }), { code: "COLLAB_MESSAGE_CIPHERTEXT_INVALID" });
const wrongKey = createCollaborationMessageCrypto({ currentKekVersion: 1, kekByVersion: { 1: Buffer.alloc(32, 8) } });
assert.throws(() => wrongKey.decryptReplySnapshot({ ...context, ...encrypted }), { code: "COLLAB_MESSAGE_CIPHERTEXT_INVALID" });
assert.notDeepEqual(crypto.encryptReplySnapshot({ ...context, plaintext: Buffer.from("snapshot") }).ciphertext, encrypted.ciphertext);
// Independent decoding pins the pre-existing body/dek AAD bytes. A coordinated
// change to both public encrypt/decrypt cannot silently rewrite the old format.
const bodyEnvelope = JSON.parse(crypto.encrypt({ ...context, plaintext: Buffer.from("legacy body") }).ciphertext);
function decodePart(part, key, purpose) {
  const decoder = createDecipheriv("aes-256-gcm", key, Buffer.from(part.nonce, "base64"));
  decoder.setAAD(Buffer.from(JSON.stringify({ version: 1, purpose, ...context })));
  decoder.setAuthTag(Buffer.from(part.tag, "base64"));
  return Buffer.concat([decoder.update(Buffer.from(part.ciphertext, "base64")), decoder.final()]);
}
const dek = decodePart(bodyEnvelope.wrappedDek, Buffer.alloc(32, 7), "message-dek:1");
assert.equal(decodePart(bodyEnvelope.body, dek, "message-body").toString(), "legacy body");
assert.notDeepEqual(decodePart(JSON.parse(encrypted.ciphertext).wrappedDek, Buffer.alloc(32, 7), "reply-snapshot-dek:1"), dek, "quote uses its own random DEK");

const messages = new Map(), receipts = new Map(), events = [];
let nextId = 0, nextSeq = 1, sourceReads = 0, batchReads = 0, quoteDecrypts = 0;
const repository = {
  async activeConversationMemberIds() { return ["alice", "bob"]; },
  async findReplyTarget(_trx, { replyToMessageId }) { sourceReads++; return messages.get(replyToMessageId); },
  async findReplySources(_trx, { messageIds }) { batchReads++; return messageIds.map((id) => messages.get(id)).filter(Boolean); },
  async insertMessage(_trx, message) { messages.set(message.id, message); },
  async findMessageForUpdate(_trx, { messageId }) { return messages.get(messageId); },
  async compareAndSwapMessage(_trx, { messageId, expectedRevision, patch }) {
    const current = messages.get(messageId);
    if (current.revision !== expectedRevision) return null;
    const updated = { ...current, ...patch, revision: current.revision + 1 };
    messages.set(messageId, updated); return updated;
  },
  async insertMessageRevision() {},
  async listHistory(_trx, { conversationId, messageIds }) { return [...messages.values()].filter((message) => message.conversationId === conversationId && (!messageIds || messageIds.includes(message.id))); },
};
// Narrow repository/transaction doubles exercise actual domain and crypto, not SQL locking.
// Signed HTTP + real PostgreSQL rollback/lock coverage is a separate integration test.
const service = createCollaborationMessageService({ repository, bodyIntentSigner: createHmacMessageBodyIntentSigner({ key: Buffer.alloc(32, 3) }),
  messageCrypto: { ...crypto, decryptReplySnapshot(args) { quoteDecrypts++; return crypto.decryptReplySnapshot(args); } },
  createId: (prefix) => `${prefix}-${++nextId}`, now: () => new Date("2026-08-31T12:00:00Z"),
  async commandRunner(command) {
    const authorization = await command.authorize();
    if (receipts.has(command.clientCommandId)) return receipts.get(command.clientCommandId);
    const projected = await command.project({ trx: {}, account: command.account, authorization });
    const event = { ...projected.event, seq: nextSeq++ };
    await projected.project({ trx: {}, event });
    events.push(event); receipts.set(command.clientCommandId, projected.response); return projected.response;
  },
});
const base = { account: { userId: "alice", deviceId: "device" }, conversationId: "conversation", authorize: async () => ({ ok: true, visibleAfterSeq: 0 }) };
const send = (clientCommandId, bodyText, replyToMessageId) => service.sendMessage({ ...base, clientCommandId, bodyText, replyToMessageId });
const history = (messageId, visibleAfterSeq = 0) => service.listMessageHistory({ ...base, messageIds: [messageId], authorize: async () => ({ ok: true, visibleAfterSeq }) }).then((rows) => rows[0]);
const source = await send("source", "原始正文😀"), sourceId = source.message.id;
assert.equal((await history(sourceId)).replySnapshot, null);
const reply = await send("reply", "我的回复", sourceId), replyId = reply.message.id;
const stored = messages.get(replyId), originalCipher = Buffer.from(stored.replySnapshotCiphertext);
assert.ok(originalCipher.length); assert.equal(originalCipher.includes(Buffer.from("原始正文")), false);
const quote = { status: "available", messageId: sourceId, revision: 1, senderUserId: "alice", createSeq: 1, kind: "text", bodyText: "原始正文😀", truncated: false };
assert.deepEqual((await history(replyId)).replySnapshot, quote);
assert.equal(JSON.stringify(events).includes("原始正文"), false, "events contain no quote plaintext");
await service.editMessage({ ...base, clientCommandId: "edit-source", messageId: sourceId, expectedRevision: 1, bodyText: "编辑后" });
assert.deepEqual((await history(replyId)).replySnapshot, quote);
await service.editMessage({ ...base, clientCommandId: "edit-reply", messageId: replyId, expectedRevision: 1, bodyText: "回复改动" });
assert.deepEqual((await history(replyId)).replySnapshot, quote);
assert.deepEqual(messages.get(replyId).replySnapshotCiphertext, originalCipher);
const readsBeforeReplay = sourceReads;
assert.deepEqual(await send("reply", "我的回复", sourceId), reply);
assert.equal(sourceReads, readsBeforeReplay, "durable receipt replay never re-reads or re-captures source");
const decryptedBefore = quoteDecrypts;
assert.deepEqual((await history(replyId, 1)).replySnapshot, { status: "unavailable" });
const sourceRow = messages.get(sourceId); messages.delete(sourceId);
assert.deepEqual((await history(replyId)).replySnapshot, { status: "unavailable" });
messages.set(sourceId, { ...sourceRow, revokedAt: "2026-08-31T12:00:00Z" });
assert.deepEqual((await history(replyId)).replySnapshot, { status: "revoked" });
assert.deepEqual((await history(replyId, 1)).replySnapshot, { status: "unavailable" }, "recipient visibility precedes even source revocation metadata");
assert.equal(quoteDecrypts, decryptedBefore, "missing/revoked/pre-join sources are masked before quote decryption");
messages.set(sourceId, sourceRow);
messages.set("deleted-source-reply", { ...stored, id: "deleted-source-reply", replyToMessageId: null, bodyCiphertext: null });
assert.deepEqual((await history("deleted-source-reply")).replySnapshot, { status: "unavailable" }, "ON DELETE SET NULL retains an unavailable quote, never decrypts an orphaned snapshot");
messages.set("legacy", { ...stored, id: "legacy", replySnapshotCiphertext: null, replySnapshotKeyVersion: null, bodyCiphertext: null });
assert.deepEqual((await history("legacy")).replySnapshot, { status: "unavailable", reason: "legacy" });
await service.revokeMessage({ ...base, clientCommandId: "revoke-reply", messageId: replyId, expectedRevision: 2 });
assert.equal(messages.get(replyId).replySnapshotCiphertext, null);
assert.equal(messages.get(replyId).replySnapshotKeyVersion, null);
assert.deepEqual((await history(replyId)).replySnapshot, { status: "unavailable" });

for (const [index, text] of ["😀".repeat(513), "a".repeat(512), "a".repeat(513)].entries()) {
  const source = await send(`long-source-${index}`, text);
  const reply = await send(`long-reply-${index}`, "reply", source.message.id);
  const snapshot = (await history(reply.message.id)).replySnapshot;
  assert.equal([...snapshot.bodyText].length, 512);
  assert.ok(Buffer.byteLength(snapshot.bodyText) <= 2048);
  assert.equal(snapshot.truncated, [...text].length > 512);
}
const batchesBefore = batchReads;
await service.listMessageHistory({ ...base, limit: 200 });
assert.equal(batchReads, batchesBefore + 1, "one bounded metadata batch per history page, not per reply");

for (const kind of ["attachment", "workspace_share"]) {
  const source = await send(`${kind}-source`, "caption");
  messages.set(source.message.id, { ...messages.get(source.message.id), kind, attachmentIds: ["not-a-snapshot-field"],
    attachmentName: "private.xlsx", url: "https://secret.invalid/token", localPath: "/private/path", replySnapshot: { bodyText: "nested secret" } });
  await assert.rejects(service.sendMessage({ ...base, clientCommandId: `${kind}-forged-reply`, bodyText: "reply", replyToMessageId: source.message.id,
    replySnapshot: { bodyText: "FORGED" } }), { code: "COLLAB_REPLY_SNAPSHOT_INPUT_FORBIDDEN" });
  const reply = await service.sendMessage({ ...base, clientCommandId: `${kind}-reply`, bodyText: "reply", replyToMessageId: source.message.id });
  const snapshot = (await history(reply.message.id)).replySnapshot;
  assert.deepEqual(snapshot, { status: "available", messageId: source.message.id, revision: 1, senderUserId: "alice",
    createSeq: messages.get(source.message.id).createSeq, kind, bodyText: "caption", truncated: false }, "only authorized real body and fixed identity fields enter the quote");
}
for (const change of [{ conversationId: "foreign" }, { revokedAt: "2026-08-31T12:00:00Z" }, { createSeq: 0 }]) {
  messages.set(sourceId, { ...sourceRow, ...change });
  const count = { events: events.length, receipts: receipts.size, messages: messages.size, seq: nextSeq };
  await assert.rejects(send(`invalid-${nextId}`, "reply", sourceId), { code: "COLLAB_REPLY_TARGET_INVALID" });
  assert.deepEqual({ events: events.length, receipts: receipts.size, messages: messages.size, seq: nextSeq }, count);
}
messages.set(sourceId, { ...sourceRow, bodyCiphertext: Buffer.from("corrupt") });
await assert.rejects(send("corrupt-source", "reply", sourceId), { code: "COLLAB_MESSAGE_CIPHERTEXT_INVALID" });
const ordinary = await send("ordinary-after-quote-failure", "ordinary text");
assert.equal((await history(ordinary.message.id)).bodyText, "ordinary text", "failed quote does not affect unrelated ordinary text");
const baseline = createCollaborationMessageService({ repository, bodyIntentSigner: createHmacMessageBodyIntentSigner({ key: Buffer.alloc(32, 3) }),
  messageCrypto: { encrypt: crypto.encrypt, decrypt: crypto.decrypt },
  async commandRunner(command) { return command.project({ trx: {}, account: base.account, authorization: { ok: true, visibleAfterSeq: 0 } }); },
});
assert.ok((await baseline.sendMessage({ ...base, clientCommandId: "no-snapshot-crypto", bodyText: "ordinary" })).response.message.id, "optional snapshot support is not an initialization dependency of ordinary sends");
console.log("collaboration immutable reply snapshot: crypto isolation, send-time capture, replay, edits, masking and bounds passed");
