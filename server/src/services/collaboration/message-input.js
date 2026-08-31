import { createHmac, timingSafeEqual } from "node:crypto";

import { CollaborationCommandError } from "./idempotency.js";

export const MAX_MESSAGE_BODY_BYTES = 64 * 1024;

export function commandError(code, message, details = {}) {
  const error = new CollaborationCommandError(code, message, { retryable: false });
  Object.assign(error, details);
  return error;
}

export function requiredId(value, label) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${label} is required.`);
  return id;
}

export function requiredPositiveInteger(value, label) {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer) || integer < 1) throw new TypeError(`${label} must be a positive integer.`);
  return integer;
}

export function normalizeIdList(values, label) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array.`);
  const normalized = values.map((value) => requiredId(value, label));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates.`);
  return normalized;
}

export function normalizedBodyText(value, { required = true } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== "string") throw new TypeError("Message body text must be a string.");
  if (value.length === 0 && required) throw commandError("COLLAB_MESSAGE_BODY_REQUIRED", "A text message requires body content.");
  if (Buffer.byteLength(value, "utf8") > MAX_MESSAGE_BODY_BYTES) {
    throw commandError("COLLAB_MESSAGE_BODY_TOO_LARGE", "The message body exceeds the maximum size.");
  }
  return value;
}

/** Build a server-only HMAC signer for opaque body intent fingerprints. */
export function createHmacMessageBodyIntentSigner({ key, version = 1, currentKeyVersion = version, keysByVersion } = {}) {
  const configuredKeys = keysByVersion instanceof Map ? [...keysByVersion.entries()] : Object.entries(keysByVersion || {});
  if (configuredKeys.length === 0 && key != null) configuredKeys.push([version, key]);
  const keys = new Map(configuredKeys.map(([rawVersion, rawKey]) => {
    const keyVersion = requiredPositiveInteger(rawVersion, "Message body intent signer key version");
    if (!Buffer.isBuffer(rawKey) && !(rawKey instanceof Uint8Array)) throw new TypeError("Message body intent signer key must be bytes.");
    const signingKey = Buffer.from(rawKey);
    if (signingKey.length < 32) throw new TypeError("Message body intent signer key must be at least 32 bytes.");
    return [keyVersion, signingKey];
  }));
  const activeKeyVersion = requiredPositiveInteger(currentKeyVersion, "Active message body intent signer key version");
  if (!keys.has(activeKeyVersion)) throw new TypeError("The active message body intent signer key is unavailable.");

  const normalizeIntent = ({ bodyText, conversationId, actorUserId, commandType, expectedRevision = null }, keyVersion) => JSON.stringify({
    version: keyVersion,
    bodyText: normalizedBodyText(bodyText),
    conversationId: requiredId(conversationId, "Conversation id"),
    actorUserId: requiredId(actorUserId, "Account user id"),
    commandType: requiredId(commandType, "Message command type"),
    expectedRevision: expectedRevision == null ? null : requiredPositiveInteger(expectedRevision, "Expected message revision"),
  });
  const signForVersion = (values, keyVersion) => {
    const signingKey = keys.get(keyVersion);
    if (!signingKey) throw commandError("COLLAB_BODY_INTENT_KEY_VERSION_UNKNOWN", "The requested body intent signing key version is unavailable.");
    return `hmac-v${keyVersion}:${createHmac("sha256", signingKey).update(normalizeIntent(values, keyVersion), "utf8").digest("hex")}`;
  };
  return Object.freeze({
    sign(values) {
      const keyVersion = values?.keyVersion == null
        ? activeKeyVersion
        : requiredPositiveInteger(values.keyVersion, "Message body intent signer key version");
      return signForVersion(values, keyVersion);
    },
    verify({ bodyIntent, ...values }) {
      const match = /^hmac-v(\d+):([0-9a-f]{64})$/.exec(String(bodyIntent || ""));
      if (!match) return false;
      const keyVersion = Number(match[1]);
      if (!keys.has(keyVersion)) return false;
      const expected = Buffer.from(signForVersion(values, keyVersion), "utf8");
      const actual = Buffer.from(bodyIntent, "utf8");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  });
}

export function signedBodyIntent(bodyIntentSigner, values) {
  if (values.bodyText == null) return null;
  const intent = bodyIntentSigner.sign(values);
  const match = /^hmac-v(\d+):[0-9a-f]{64}$/.exec(String(intent || ""));
  if (!match) {
    throw new Error("Message body intent signer must return an opaque signature.");
  }
  return { value: intent, keyVersion: Number(match[1]) };
}

function receiptBodyIntentKeyVersion(receipt) {
  let payload = receipt?.responsePayload ?? receipt?.response_payload ?? receipt?.response ?? null;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  const keyVersion = Number(payload?.bodyIntentKeyVersion ?? payload?.body_intent_key_version);
  return Number.isSafeInteger(keyVersion) && keyVersion >= 1 ? keyVersion : null;
}

export function resolveStableBodyIntent({ bodyIntentSigner, originalInput, bodyText, conversationId, actorUserId, commandType, expectedRevision }) {
  if (bodyText == null) return undefined;
  return ({ receipt }) => {
    const retainedKeyVersion = receiptBodyIntentKeyVersion(receipt);
    const signed = signedBodyIntent(bodyIntentSigner, {
      bodyText, conversationId, actorUserId, commandType, expectedRevision,
      keyVersion: retainedKeyVersion ?? originalInput.bodyIntentKeyVersion,
    });
    return {
      ...originalInput,
      bodyIntent: signed.value,
      bodyIntentKeyVersion: signed.keyVersion,
    };
  };
}
