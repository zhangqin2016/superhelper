"use strict";

const { app } = require("electron");
const { submitContactRequest } = require("./service-client");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    appVersion: app.getVersion(),
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
