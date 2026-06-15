import crypto from "node:crypto";
import { publicId } from "./ids.js";
import { getQiniuConfig } from "./app-settings.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sanitizeFileName(value) {
  const name = String(value || "feedback-image").trim();
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80) || "feedback-image";
}

function publicUrlForKey(config, key) {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
}

function normalizeMimeType(value) {
  return String(value || "").trim().toLowerCase();
}

function ensureQiniuConfigured(config) {
  if (!config.accessKey || !config.secretKey || !config.bucket) {
    const error = new Error("QINIU_UPLOAD_NOT_CONFIGURED");
    error.code = "QINIU_UPLOAD_NOT_CONFIGURED";
    throw error;
  }
}

export function normalizeFeedbackAttachmentInput(input) {
  const mimeType = normalizeMimeType(input?.mimeType || input?.mime_type);
  const sizeBytes = Number(input?.sizeBytes || input?.size_bytes || 0);
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    return { ok: false, code: "UNSUPPORTED_ATTACHMENT_TYPE" };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_IMAGE_BYTES) {
    return { ok: false, code: "ATTACHMENT_TOO_LARGE" };
  }
  return {
    ok: true,
    fileName: sanitizeFileName(input?.fileName || input?.originalName || input?.name),
    mimeType,
    sizeBytes,
  };
}

async function resolveQiniuConfig(override) {
  return override || await getQiniuConfig();
}

export async function createFeedbackUploadToken({ deviceId, draftId, fileName, mimeType, sizeBytes, qiniuConfig }) {
  const config = await resolveQiniuConfig(qiniuConfig);
  ensureQiniuConfigured(config);
  const normalized = normalizeFeedbackAttachmentInput({ fileName, mimeType, sizeBytes });
  if (!normalized.ok) {
    const error = new Error(normalized.code);
    error.code = normalized.code;
    throw error;
  }

  const uploadId = publicId("feedback_img");
  const safeDeviceId = String(deviceId || "anonymous").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
  const safeDraftId = String(draftId || publicId("draft")).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
  const key = `feedback/${safeDeviceId}/${safeDraftId}/${uploadId}-${normalized.fileName}`;
  const deadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const policy = {
    scope: `${config.bucket}:${key}`,
    deadline,
    fsizeLimit: MAX_IMAGE_BYTES,
    mimeLimit: Array.from(ALLOWED_IMAGE_MIME_TYPES).join(";"),
  };
  const encodedPolicy = base64Url(JSON.stringify(policy));
  const sign = crypto.createHmac("sha1", config.secretKey).update(encodedPolicy).digest();
  const encodedSign = base64Url(sign);
  const publicUrl = publicUrlForKey(config, key);
  return {
    uploadId,
    key,
    token: `${config.accessKey}:${encodedSign}:${encodedPolicy}`,
    uploadUrl: config.uploadUrl,
    publicUrl,
    expiresAt: new Date(deadline * 1000).toISOString(),
    maxBytes: MAX_IMAGE_BYTES,
  };
}

export async function normalizeSubmittedAttachment(input, qiniuConfig = null) {
  const qiniu = await resolveQiniuConfig(qiniuConfig);
  const objectKey = String(input?.key || input?.objectKey || "").trim();
  const mimeType = normalizeMimeType(input?.mimeType || input?.mime_type);
  const sizeBytes = Number(input?.sizeBytes || input?.size_bytes || 0);
  if (!objectKey.startsWith("feedback/")) return null;
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) return null;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_IMAGE_BYTES) return null;
  const width = Number(input?.width || 0);
  const height = Number(input?.height || 0);
  return {
    id: publicId("attach"),
    type: "image",
    storage_provider: "qiniu",
    object_key: objectKey,
    public_url: publicUrlForKey(qiniu, objectKey),
    mime_type: mimeType,
    size_bytes: Math.round(sizeBytes),
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    sha256: input?.sha256 ? String(input.sha256).trim().slice(0, 128) : null,
    original_name: input?.name ? String(input.name).trim().slice(0, 160) : null,
  };
}

export async function qiniuUploadTokenForKey({ key, sizeBytes, mimeType, qiniuConfig }) {
  const config = await resolveQiniuConfig(qiniuConfig);
  ensureQiniuConfigured(config);
  const objectKey = String(key || "").trim().replace(/^\/+/, "");
  if (!objectKey || objectKey.includes("..")) {
    const error = new Error("INVALID_QINIU_OBJECT_KEY");
    error.code = "INVALID_QINIU_OBJECT_KEY";
    throw error;
  }
  const deadline = Math.floor(Date.now() / 1000) + 10 * 60;
  const policy = {
    scope: `${config.bucket}:${objectKey}`,
    deadline,
  };
  if (Number.isFinite(sizeBytes) && sizeBytes > 0) policy.fsizeLimit = Math.round(sizeBytes);
  if (mimeType) policy.mimeLimit = String(mimeType);
  const encodedPolicy = base64Url(JSON.stringify(policy));
  const sign = crypto.createHmac("sha1", config.secretKey).update(encodedPolicy).digest();
  const encodedSign = base64Url(sign);
  return {
    key: objectKey,
    token: `${config.accessKey}:${encodedSign}:${encodedPolicy}`,
    uploadUrl: config.uploadUrl,
    publicUrl: publicUrlForKey(config, objectKey),
    expiresAt: new Date(deadline * 1000).toISOString(),
  };
}

export async function uploadBufferToQiniu({
  key,
  buffer,
  fileName,
  mimeType = "application/octet-stream",
  fetchImpl = fetch,
  qiniuConfig = null,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    const error = new Error("EMPTY_UPLOAD");
    error.code = "EMPTY_UPLOAD";
    throw error;
  }
  const token = await qiniuUploadTokenForKey({ key, sizeBytes: buffer.length, mimeType, qiniuConfig });
  const form = new FormData();
  form.append("token", token.token);
  form.append("key", token.key);
  form.append("file", new Blob([buffer], { type: mimeType }), sanitizeFileName(fileName || "artifact.bin"));
  const response = await fetchImpl(token.uploadUrl, {
    method: "POST",
    body: form,
  });
  if (!response?.ok) {
    const detail = response ? `HTTP ${response.status}` : "NO_RESPONSE";
    const error = new Error("QINIU_UPLOAD_FAILED");
    error.code = "QINIU_UPLOAD_FAILED";
    error.detail = detail;
    throw error;
  }
  return {
    key: token.key,
    publicUrl: token.publicUrl,
    sizeBytes: buffer.length,
  };
}
