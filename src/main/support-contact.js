"use strict";

const crypto = require("node:crypto");
const { appVersion } = require("./config");
const {
  submitContactRequest,
  requestFeedbackAttachmentUpload,
  uploadFeedbackAttachment,
} = require("./service-client");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function normalizeContactPayload(input) {
  return {
    name: String(input?.name || "").trim().slice(0, 120),
    email: String(input?.email || "").trim().slice(0, 160),
    company: input?.company ? String(input.company).trim().slice(0, 160) : null,
    phone: input?.phone ? String(input.phone).trim().slice(0, 80) : null,
    subject: input?.subject ? String(input.subject).trim().slice(0, 160) : null,
    message: String(input?.message || "").trim().slice(0, 4000),
    source: String(input?.source || "desktop").trim().slice(0, 80) || "desktop",
  };
}

function validateContactPayload(payload) {
  if (!payload.name || !EMAIL_RE.test(payload.email) || payload.message.length < 8) {
    return { ok: false, error: "VALIDATION_ERROR" };
  }
  return { ok: true };
}

function normalizeAttachmentInput(input) {
  const mimeType = String(input?.mimeType || input?.type || "").trim().toLowerCase();
  const sizeBytes = Number(input?.sizeBytes || input?.size || 0);
  const name = String(input?.name || input?.fileName || "feedback-image").trim().slice(0, 160);
  const data = input?.data;
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    return { ok: false, error: "UNSUPPORTED_ATTACHMENT_TYPE" };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: "ATTACHMENT_TOO_LARGE" };
  }
  if (!data || typeof data.byteLength !== "number") {
    return { ok: false, error: "ATTACHMENT_DATA_MISSING" };
  }
  return {
    ok: true,
    attachment: {
      name,
      mimeType,
      sizeBytes,
      width: Number(input?.width || 0) || null,
      height: Number(input?.height || 0) || null,
      data,
      sha256: crypto.createHash("sha256").update(Buffer.from(data)).digest("hex"),
    },
  };
}

async function uploadAttachments(inputs = []) {
  const normalized = [];
  for (const input of inputs.slice(0, MAX_ATTACHMENTS)) {
    const result = normalizeAttachmentInput(input);
    if (!result.ok) return result;
    normalized.push(result.attachment);
  }
  if (!normalized.length) return { ok: true, attachments: [] };

  const uploaded = [];
  const draftId = crypto.randomUUID();
  for (const attachment of normalized) {
    const tokenResult = await requestFeedbackAttachmentUpload({
      draftId,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
    if (!tokenResult.ok) {
      return { ok: false, error: tokenResult.error || "ATTACHMENT_UPLOAD_TOKEN_FAILED" };
    }
    const uploadResult = await uploadFeedbackAttachment(tokenResult.json, attachment);
    if (!uploadResult.ok) {
      return { ok: false, error: uploadResult.error || "ATTACHMENT_UPLOAD_FAILED" };
    }
    uploaded.push(uploadResult.attachment);
  }
  return { ok: true, attachments: uploaded };
}

function appendFeedbackContext(message, meta) {
  const lines = [
    message.trim(),
    "",
    "---",
    `App: ${meta.appVersion || "unknown"}`,
    `Device: ${meta.deviceId || "unknown"}`,
    `Platform: ${meta.platform || "unknown"}/${meta.arch || "unknown"}`,
  ];
  if (meta.category) lines.push(`Category: ${meta.category}`);
  return lines.join("\n").slice(0, 4000);
}

async function submitContactRequestPublic(input) {
  const payload = normalizeContactPayload(input);
  if (input?.appendContext) {
    payload.message = appendFeedbackContext(payload.message, input.appendContext);
  }
  const validated = validateContactPayload(payload);
  if (!validated.ok) return validated;

  const attachmentResult = await uploadAttachments(input?.attachments || []);
  if (!attachmentResult.ok) {
    return attachmentResult;
  }
  if (attachmentResult.attachments.length) {
    payload.attachments = attachmentResult.attachments;
  }

  const result = await submitContactRequest(payload);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error || "SERVICE_REQUEST_FAILED",
      detail: result.detail || null,
    };
  }
  return { ok: true, id: result.json?.id || null };
}

function getFeedbackContext(category) {
  const { getDeviceId, devicePayload } = require("./service-client");
  const device = devicePayload();
  return {
    appVersion: appVersion(),
    deviceId: getDeviceId(),
    platform: device.platform,
    arch: device.arch,
    category: category || null,
  };
}

module.exports = {
  submitContactRequestPublic,
  getFeedbackContext,
};
