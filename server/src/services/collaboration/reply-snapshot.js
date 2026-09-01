import { commandError, requiredId, requiredPositiveInteger } from "./message-input.js";

const field = (row, camel, snake) => row?.[camel] ?? row?.[snake] ?? null;
const replyId = (row) => field(row, "replyToMessageId", "reply_to_message_id");
const revoked = (row) => field(row, "revokedAt", "revoked_at");
const conversation = (row) => field(row, "conversationId", "conversation_id");
const createSeq = (row) => Number(field(row, "createSeq", "create_seq"));
const sender = (row) => field(row, "senderUserId", "sender_user_id");
const snapshotCipher = (row) => field(row, "replySnapshotCiphertext", "reply_snapshot_ciphertext");
const snapshotKey = (row) => field(row, "replySnapshotKeyVersion", "reply_snapshot_key_version");

function boundedText(text) {
  let bodyText = "", points = 0, bytes = 0;
  for (const point of text || "") {
    const size = Buffer.byteLength(point, "utf8");
    if (points === 512 || bytes + size > 2048) return { bodyText, truncated: true };
    bodyText += point; points++; bytes += size;
  }
  return { bodyText, truncated: false };
}

/** Caller holds the command's Device -> Team -> Conversation authorization locks. */
export async function createEncryptedReplySnapshot({ repository, trx, messageCrypto, conversationId, messageId, replyToMessageId, visibleAfterSeq }) {
  if (!replyToMessageId) return { ciphertext: null, keyVersion: null };
  const source = await repository.findReplyTarget(trx, { conversationId, replyToMessageId, visibleAfterSeq });
  if (!source || source.id !== replyToMessageId || conversation(source) !== conversationId || revoked(source) || !(createSeq(source) > visibleAfterSeq)) {
    throw commandError("COLLAB_REPLY_TARGET_INVALID", "The replied-to message is not available in this conversation.");
  }
  const ciphertext = field(source, "bodyCiphertext", "body_ciphertext");
  const bodyText = ciphertext == null ? "" : messageCrypto.decrypt({
    ciphertext, keyVersion: field(source, "bodyKeyVersion", "body_key_version"),
    messageId: source.id, conversationId, revision: source.revision,
  }).toString("utf8");
  // Only real body text and immutable identity are copied, never attachment
  // metadata, credentials, paths, or an existing nested reply snapshot.
  const snapshot = {
    version: 1, messageId: requiredId(source.id, "Reply source id"),
    revision: requiredPositiveInteger(source.revision, "Reply source revision"),
    senderUserId: requiredId(sender(source), "Reply source sender"),
    createSeq: requiredPositiveInteger(createSeq(source), "Reply source sequence"),
    kind: String(source.kind || "text"), ...boundedText(bodyText),
  };
  const encrypted = messageCrypto.encryptReplySnapshot({ plaintext: Buffer.from(JSON.stringify(snapshot), "utf8"), messageId, conversationId });
  if (!Buffer.isBuffer(encrypted?.ciphertext) && !(encrypted?.ciphertext instanceof Uint8Array)) throw new Error("Reply snapshot crypto did not return ciphertext bytes.");
  return { ciphertext: Buffer.from(encrypted.ciphertext), keyVersion: requiredPositiveInteger(encrypted.keyVersion, "Reply snapshot key version") };
}

/** One bounded, metadata-only query under the existing read authorization lock. */
export async function historyReplySnapshots({ repository, trx, rows, messageCrypto, conversationId, visibleAfterSeq }) {
  const sourceIds = [...new Set(rows.filter((row) => replyId(row) && !revoked(row) && snapshotCipher(row) != null).map(replyId))];
  const sources = sourceIds.length ? await repository.findReplySources(trx, { conversationId, messageIds: sourceIds }) : [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  return new Map(rows.map((row) => {
    // The original FK uses ON DELETE SET NULL: an orphaned envelope is still
    // an unavailable quote, but must never be decrypted to recover its source.
    let view = snapshotCipher(row) != null ? { status: "unavailable" } : null;
    if (replyId(row)) {
      const source = byId.get(replyId(row));
      if (revoked(row)) view = { status: "unavailable" };
      else if (snapshotCipher(row) == null) view = { status: "unavailable", reason: "legacy" };
      else if (!source || conversation(source) !== conversationId || !(createSeq(source) > visibleAfterSeq)) view = { status: "unavailable" };
      else if (revoked(source)) view = { status: "revoked" };
      else {
        const snapshot = JSON.parse(messageCrypto.decryptReplySnapshot({
          ciphertext: snapshotCipher(row), keyVersion: snapshotKey(row), messageId: row.id, conversationId,
        }).toString("utf8"));
        if (snapshot.version !== 1 || snapshot.messageId !== source.id || snapshot.createSeq !== createSeq(source)
            || snapshot.senderUserId !== sender(source) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
            || typeof snapshot.kind !== "string" || typeof snapshot.bodyText !== "string" || typeof snapshot.truncated !== "boolean"
            || boundedText(snapshot.bodyText).truncated) throw commandError("COLLAB_MESSAGE_CIPHERTEXT_INVALID", "Reply snapshot metadata is invalid.");
        view = { status: "available", messageId: snapshot.messageId, revision: snapshot.revision, senderUserId: snapshot.senderUserId,
          createSeq: snapshot.createSeq, kind: snapshot.kind, bodyText: snapshot.bodyText, truncated: snapshot.truncated };
      }
    }
    return [row.id, view];
  }));
}
