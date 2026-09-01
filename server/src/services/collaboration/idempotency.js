import { createHash } from "node:crypto";

const SENSITIVE_RECEIPT_KEY = /(?:^|_)(?:access_token|refresh_token|bearer_token|token|data_dek|dek|wrapped_dek|signature|local_path|path|secret|authorization|cookie|api_key|private_key|encryption_key|password)(?:_|$)/;
const SENSITIVE_RECEIPT_URL_KEY = /(?:^|_)(?:pre_)?signed(?:_[a-z0-9]+)*_url$|(?:^|_)(?:download|upload)(?:_[a-z0-9]+)*_url$/;

function normalizePayloadKey(key) {
  return String(key || "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** One denylist for every collaboration durable payload surface. */
export function isSensitiveCollaborationPayloadKey(key) {
  const text = normalizePayloadKey(key);
  return SENSITIVE_RECEIPT_KEY.test(text) || SENSITIVE_RECEIPT_URL_KEY.test(text);
}

export class CollaborationCommandError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message || code);
    this.name = "CollaborationCommandError";
    this.code = code;
    this.retryable = retryable;
  }
}

function canonicalValue(value, ancestors = new Set()) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("A collaboration command cannot contain a non-finite number.");
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value !== "object") throw new TypeError("A collaboration command contains an unsupported request value.");
  if (ancestors.has(value)) throw new TypeError("A collaboration command cannot contain a circular request value.");

  ancestors.add(value);
  let normalized;
  if (Array.isArray(value)) {
    // Arrays carry user intent (notably attachment order), so never sort them.
    normalized = value.map((entry) => canonicalValue(entry, ancestors));
  } else {
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = canonicalValue(value[key], ancestors);
    }
  }
  ancestors.delete(value);
  return normalized;
}

/** Return the stable JSON representation used as a command request hash input. */
export function canonicalRequestJson(input) {
  return JSON.stringify(canonicalValue(input));
}

/** SHA-256 fingerprint of the entire canonical command request. */
export function collaborationRequestFingerprint(input) {
  return createHash("sha256").update(canonicalRequestJson(input), "utf8").digest("hex");
}

/** Reject reuse of an idempotency key for a semantically different command. */
export function assertReusableCommandReceipt(receipt, requestFingerprint) {
  const stored = receipt?.requestFingerprint ?? receipt?.request_fingerprint;
  if (!stored || stored !== requestFingerprint) {
    throw new CollaborationCommandError(
      "IDEMPOTENCY_KEY_REUSED",
      "This client command id was already used with different request data.",
    );
  }
}

function receiptSafe(value) {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(receiptSafe);
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveCollaborationPayloadKey(key)) continue;
    output[key] = receiptSafe(nested);
  }
  return output;
}

/**
 * Receipts are replayed long after an HTTP response is gone. Keep only
 * durable, authorization-neutral response data in them; credentials and local
 * paths must be fetched again through their dedicated guarded endpoints.
 */
export function sanitizeCommandReceiptPayload(payload) {
  const sanitized = receiptSafe(payload);
  return sanitized && typeof sanitized === "object" ? sanitized : {};
}
