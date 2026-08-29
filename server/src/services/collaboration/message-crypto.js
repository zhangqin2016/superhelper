import { createCipheriv, createDecipheriv, randomBytes as systemRandomBytes } from "node:crypto";

import { CollaborationCommandError } from "./idempotency.js";

const ENVELOPE_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const DEK_BYTES = 32;

function cryptoError(code, message) {
  return new CollaborationCommandError(code, message, { retryable: false });
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function requiredRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("Message revision must be a positive integer.");
  return revision;
}

function aadFor(context, purpose) {
  return Buffer.from(JSON.stringify({
    version: ENVELOPE_VERSION,
    purpose,
    messageId: requiredText(context?.messageId, "Message id"),
    conversationId: requiredText(context?.conversationId, "Conversation id"),
    revision: requiredRevision(context?.revision),
  }), "utf8");
}

function asKey(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw cryptoError("COLLAB_MESSAGE_KEK_UNAVAILABLE", `${label} must be a 32-byte encryption key.`);
  }
  const key = Buffer.from(value);
  if (key.length !== DEK_BYTES) throw cryptoError("COLLAB_MESSAGE_KEK_UNAVAILABLE", `${label} must be a 32-byte encryption key.`);
  return key;
}

function normalizeKeyMap(kekByVersion) {
  const entries = kekByVersion instanceof Map
    ? [...kekByVersion.entries()]
    : Object.entries(kekByVersion || {});
  return new Map(entries.map(([version, key]) => {
    const normalizedVersion = Number(version);
    if (!Number.isSafeInteger(normalizedVersion) || normalizedVersion < 1) {
      throw cryptoError("COLLAB_MESSAGE_KEK_UNAVAILABLE", "Message KEK versions must be positive integers.");
    }
    return [normalizedVersion, asKey(key, `Message KEK version ${normalizedVersion}`)];
  }));
}

function encryptAesGcm({ key, plaintext, aad, randomBytes }) {
  const nonce = Buffer.from(randomBytes(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) throw new Error("Message crypto nonce source returned an invalid nonce.");
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  return {
    nonce,
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
    tag: cipher.getAuthTag(),
  };
}

function decryptAesGcm({ key, nonce, ciphertext, tag, aad }) {
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function base64(value) {
  return Buffer.from(value).toString("base64");
}

function fromBase64(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw cryptoError("COLLAB_MESSAGE_CIPHERTEXT_INVALID", `Message envelope ${label} is invalid.`);
  }
  return Buffer.from(value, "base64");
}

function parseEnvelope(ciphertext) {
  try {
    const parsed = JSON.parse(Buffer.from(ciphertext).toString("utf8"));
    if (!parsed || parsed.version !== ENVELOPE_VERSION || parsed.algorithm !== ALGORITHM || !Number.isSafeInteger(parsed.keyVersion)) {
      throw new Error("bad envelope metadata");
    }
    const body = parsed.body || {};
    const wrappedDek = parsed.wrappedDek || {};
    return {
      keyVersion: parsed.keyVersion,
      body: { nonce: fromBase64(body.nonce, "body nonce"), ciphertext: fromBase64(body.ciphertext, "body ciphertext"), tag: fromBase64(body.tag, "body tag") },
      wrappedDek: { nonce: fromBase64(wrappedDek.nonce, "wrapped DEK nonce"), ciphertext: fromBase64(wrappedDek.ciphertext, "wrapped DEK ciphertext"), tag: fromBase64(wrappedDek.tag, "wrapped DEK tag") },
    };
  } catch (error) {
    if (error?.code === "COLLAB_MESSAGE_CIPHERTEXT_INVALID") throw error;
    throw cryptoError("COLLAB_MESSAGE_CIPHERTEXT_INVALID", "Message ciphertext envelope is invalid.");
  }
}

function assertAesPart(part, label) {
  if (part.nonce.length !== NONCE_BYTES || part.tag.length !== 16 || part.ciphertext.length === 0) {
    throw cryptoError("COLLAB_MESSAGE_CIPHERTEXT_INVALID", `Message envelope ${label} is malformed.`);
  }
}

/**
 * Server-authorized envelope encryption for message bodies. A new random DEK
 * encrypts every message, then the independent versioned message KEK wraps
 * that DEK. Only the resulting binary envelope belongs in messages.body_ciphertext.
 */
export function createCollaborationMessageCrypto({ currentKekVersion, kekByVersion, randomBytes = systemRandomBytes } = {}) {
  if (typeof randomBytes !== "function") throw new TypeError("A message crypto random source is required.");
  const keys = normalizeKeyMap(kekByVersion);
  const version = Number(currentKekVersion);
  if (!Number.isSafeInteger(version) || version < 1 || !keys.has(version)) {
    throw cryptoError("COLLAB_MESSAGE_KEK_UNAVAILABLE", "The active message KEK is unavailable.");
  }

  function encrypt({ plaintext, messageId, conversationId, revision }) {
    if (!Buffer.isBuffer(plaintext) && !(plaintext instanceof Uint8Array)) {
      throw new TypeError("Message plaintext must be bytes.");
    }
    const context = { messageId, conversationId, revision };
    const dek = Buffer.from(randomBytes(DEK_BYTES));
    if (dek.length !== DEK_BYTES) throw new Error("Message crypto random source returned an invalid DEK.");
    const body = encryptAesGcm({ key: dek, plaintext: Buffer.from(plaintext), aad: aadFor(context, "message-body"), randomBytes });
    const wrappedDek = encryptAesGcm({ key: keys.get(version), plaintext: dek, aad: aadFor(context, `message-dek:${version}`), randomBytes });
    const ciphertext = Buffer.from(JSON.stringify({
      version: ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      keyVersion: version,
      body: { nonce: base64(body.nonce), ciphertext: base64(body.ciphertext), tag: base64(body.tag) },
      wrappedDek: { nonce: base64(wrappedDek.nonce), ciphertext: base64(wrappedDek.ciphertext), tag: base64(wrappedDek.tag) },
    }), "utf8");
    return { ciphertext, keyVersion: version };
  }

  function decrypt({ ciphertext, keyVersion, messageId, conversationId, revision }) {
    if (!Buffer.isBuffer(ciphertext) && !(ciphertext instanceof Uint8Array)) {
      throw cryptoError("COLLAB_MESSAGE_CIPHERTEXT_INVALID", "Message ciphertext must be bytes.");
    }
    const envelope = parseEnvelope(ciphertext);
    const requestedVersion = Number(keyVersion);
    if (!Number.isSafeInteger(requestedVersion) || requestedVersion !== envelope.keyVersion) {
      throw cryptoError("COLLAB_MESSAGE_CIPHERTEXT_INVALID", "Message key version does not match its ciphertext envelope.");
    }
    const kek = keys.get(envelope.keyVersion);
    if (!kek) throw cryptoError("COLLAB_MESSAGE_KEK_VERSION_UNKNOWN", "The KEK required for this message version is unavailable.");
    assertAesPart(envelope.body, "body");
    assertAesPart(envelope.wrappedDek, "wrapped DEK");
    const context = { messageId, conversationId, revision };
    try {
      const dek = decryptAesGcm({ key: kek, ...envelope.wrappedDek, aad: aadFor(context, `message-dek:${envelope.keyVersion}`) });
      if (dek.length !== DEK_BYTES) throw new Error("invalid DEK length");
      return decryptAesGcm({ key: dek, ...envelope.body, aad: aadFor(context, "message-body") });
    } catch {
      throw cryptoError("COLLAB_MESSAGE_CIPHERTEXT_INVALID", "Message ciphertext authentication failed.");
    }
  }

  return Object.freeze({ encrypt, decrypt });
}

/** Return only observability-safe envelope metadata; never return secret bytes. */
export function redactMessageCryptoForLog(value = {}) {
  const ciphertext = value?.ciphertext;
  const keyVersion = Number(value?.keyVersion);
  return {
    ...(Number.isSafeInteger(keyVersion) && keyVersion >= 1 ? { keyVersion } : {}),
    ...(Buffer.isBuffer(ciphertext) || ciphertext instanceof Uint8Array ? { ciphertextBytes: Buffer.byteLength(ciphertext) } : {}),
  };
}
