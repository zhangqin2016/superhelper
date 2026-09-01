"use strict";

const MAX_CREATE_BYTES = 32 * 1024;
const messageIdentifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
function invalidIntent() { return Object.assign(new Error("Invalid collaboration message intent"), { code: "COLLABORATION_INVALID_INPUT" }); }
function messageMetadata({ replyToMessageId = null, mentionUserIds = [] } = {}) {
  if (replyToMessageId !== null && !messageIdentifier(replyToMessageId) || !Array.isArray(mentionUserIds)
    || mentionUserIds.length > 1000 || mentionUserIds.some((id) => !messageIdentifier(id)) || new Set(mentionUserIds).size !== mentionUserIds.length) throw invalidIntent();
  return { replyToMessageId, mentionUserIds: [...mentionUserIds].sort() };
}
function validateCreateBody(bodyText) {
  if (typeof bodyText !== "string" || Buffer.byteLength(bodyText, "utf8") > MAX_CREATE_BYTES) throw invalidIntent();
  return bodyText;
}
function sameCreateIntent(left, right) {
  return (left.commandType || "message.create") === "message.create" && left.conversationId === right.conversationId
    && left.bodyText === right.bodyText && JSON.stringify(messageMetadata(left)) === JSON.stringify(messageMetadata(right))
    && JSON.stringify(left.attachmentIds || []) === JSON.stringify(right.attachmentIds || [])
    && (left.attachmentPurpose || null) === (right.attachmentPurpose || null);
}
function retainedComposerDraft(current, { bodyText, draftText, preserveDraft, ...metadata }) {
  const submitted = messageMetadata(metadata);
  if (current && (preserveDraft || current.text !== bodyText || JSON.stringify(messageMetadata(current)) !== JSON.stringify(submitted))) {
    return { text: current.text, ...messageMetadata(current) };
  }
  return { text: String(draftText || ""), ...messageMetadata() };
}
module.exports = { MAX_CREATE_BYTES, messageIdentifier, messageMetadata, validateCreateBody, sameCreateIntent, retainedComposerDraft };
