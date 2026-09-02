/**
 * The history message projection, and the descriptive attachment metadata that
 * is the reason it moved out of messages.js.
 *
 * This is presentation data — a name, a type, a size — so a recipient can see
 * "design-review.png · 1.2 MB" and a thumbnail instead of N identical Download
 * buttons. It is deliberately SEPARATE from `attachmentIds`:
 *
 *   - `attachmentIds` addresses and authorizes a download. It must never be
 *     derived from, filtered by, or shortened because of metadata.
 *   - `attachments` is additive. A missing or malformed entry costs a filename,
 *     never access to the object, so every path here degrades to "no metadata".
 *
 * A revoked message projects NOTHING: its body is already blanked, and a
 * filename is content too.
 */

import { requiredId, normalizeIdList } from "./message-input.js";

const MAX_ATTACHMENTS = 20;
const MAX_NAME_BYTES = 255;
const MAX_MIME_LENGTH = 100;

const mimeShape = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

/** A name is shown to a person and used as a download default: no path parts. */
function safeName(value) {
  if (typeof value !== "string" || !value) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_NAME_BYTES) return null;
  if (/[\\/\x00-\x1f\x7f]/.test(value) || value === "." || value === "..") return null;
  return value;
}

function safeMime(value) {
  if (typeof value !== "string" || value.length > MAX_MIME_LENGTH || !mimeShape.test(value)) return null;
  return value.toLowerCase();
}

function safeSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/**
 * @param message the repository row, carrying `attachments` from the left join
 * @param attachmentIds the AUTHORITATIVE id list already projected
 * @param revoked whether the message is revoked
 */
function attachmentMetadataView(message, attachmentIds, revoked) {
  if (revoked || !Array.isArray(attachmentIds) || attachmentIds.length === 0) return [];
  const rows = Array.isArray(message?.attachments) ? message.attachments : [];
  if (rows.length === 0) return [];
  // Only ids that survived the authoritative projection may carry metadata, so
  // a stray join row can never introduce an attachment the id list omits.
  const allowed = new Set(attachmentIds);
  const seen = new Set();
  const view = [];
  for (const row of rows) {
    const objectId = typeof row?.objectId === "string" ? row.objectId : "";
    if (!allowed.has(objectId) || seen.has(objectId)) continue;
    const originalName = safeName(row?.originalName);
    const mimeType = safeMime(row?.mimeType);
    const sizeBytes = safeSize(row?.sizeBytes);
    if (originalName == null && mimeType == null && sizeBytes == null) continue;
    seen.add(objectId);
    view.push({
      objectId,
      ...(originalName == null ? {} : { originalName }),
      ...(mimeType == null ? {} : { mimeType }),
      ...(sizeBytes == null ? {} : { sizeBytes }),
    });
    if (view.length >= MAX_ATTACHMENTS) break;
  }
  return view;
}

function historyMessageView(message, messageCrypto, actorUserId) {
  const id = String(message?.id || "");
  const conversationId = String(message?.conversationId ?? message?.conversation_id ?? "");
  const revision = Number(message?.revision || 1);
  const ciphertext = message?.bodyCiphertext ?? message?.body_ciphertext ?? null;
  const keyVersion = message?.bodyKeyVersion ?? message?.body_key_version ?? null;
  const bodyText = ciphertext == null ? null : messageCrypto.decrypt({
    ciphertext, keyVersion, messageId: id, conversationId, revision,
  }).toString("utf8");
  const senderUserId = String(message?.senderUserId ?? message?.sender_user_id ?? "");
  const ownClientCommandId = senderUserId === actorUserId && message?.clientCommandId != null
    ? requiredId(message.clientCommandId, "History client command id") : "";
  const attachmentIds = Array.isArray(message?.attachmentIds) ? [...message.attachmentIds] : [];
  return {
    id,
    conversationId,
    createSeq: Number(message?.createSeq ?? message?.create_seq),
    senderUserId,
    ...(ownClientCommandId ? { clientCommandId: ownClientCommandId } : {}),
    kind: String(message?.kind || "text"),
    bodyText,
    revision,
    replyToMessageId: message?.replyToMessageId ?? message?.reply_to_message_id ?? null,
    mentionUserIds: normalizeIdList(message?.mentionUserIds, "History mention user ids"),
    editedAt: message?.editedAt ?? message?.edited_at ?? null,
    revokedAt: message?.revokedAt ?? message?.revoked_at ?? null,
    createdAt: message?.createdAt ?? message?.created_at ?? null,
    attachmentIds,
    // Additive descriptive metadata. Never an input to addressing or access.
    attachments: attachmentMetadataView(message, attachmentIds, Boolean(message?.revokedAt ?? message?.revoked_at)),
  };
}

export { historyMessageView, attachmentMetadataView, MAX_ATTACHMENTS, MAX_NAME_BYTES, MAX_MIME_LENGTH };

