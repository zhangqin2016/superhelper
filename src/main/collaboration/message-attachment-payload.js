"use strict";

const attachmentId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const originDeviceId = (value) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512;

// This is intentionally a local encrypted-payload contract, not a renderer or
// server object contract. Keeping it here lets the SQLite transaction and the
// bootstrap optimistic-bubble rebuild use identical attachment semantics.
function validateAttachmentPayload({ attachmentIds = [], attachmentPurpose = null, originDeviceId: origin = null } = {}) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 20 || new Set(attachmentIds).size !== attachmentIds.length
    || attachmentIds.some((value) => !attachmentId(value)) || (attachmentIds.length && !["attachment", "workspace"].includes(attachmentPurpose))
    || (origin != null && !originDeviceId(origin))) throw new Error("collaboration attachment intent is invalid");
  if (!attachmentIds.length) return origin == null ? null : { originDeviceId: origin };
  return {
    attachmentIds: [...attachmentIds], attachmentPurpose,
    kind: attachmentPurpose === "workspace" ? "workspace_share" : "attachment",
    ...(origin == null ? {} : { originDeviceId: origin }),
  };
}

function optimisticAttachmentProjection(payload) {
  return payload?.attachmentIds ? { kind: payload.kind, attachmentIds: [...payload.attachmentIds] } : {};
}

function attachmentProjectionFromOutboxIntent(intent = {}) {
  try {
    return optimisticAttachmentProjection(validateAttachmentPayload({ attachmentIds: intent.attachmentIds || [], attachmentPurpose: intent.attachmentPurpose }));
  } catch {
    // A malformed legacy/local payload cannot fabricate an attachment view
    // during bootstrap. The durable outbox remains for explicit recovery.
    return {};
  }
}

module.exports = { validateAttachmentPayload, optimisticAttachmentProjection, attachmentProjectionFromOutboxIntent };
