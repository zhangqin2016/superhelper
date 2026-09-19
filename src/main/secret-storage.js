"use strict";

/**
 * How a secret is kept on disk — the ONE answer for the whole app.
 *
 * The OS secure storage (Electron safeStorage: Keychain, DPAPI, libsecret) is
 * the only real protection. Base64 is an encoding, not encryption, and is
 * written ONLY under an explicit operator opt-in (LILY_ALLOW_PLAINTEXT_SECRETS=1,
 * e.g. a headless Linux box without a keyring). Without the opt-in a NEW secret
 * is refused with a named error; records written plainly in the past still
 * read back.
 *
 * Why one module: that rule was first fixed for model API keys and mail
 * passwords, while six more copies of the same fifteen lines — the device
 * signing key, the account refresh token, the remote-config cache, the license,
 * web credentials — kept the silent Base64 fallback. A rule that lives in eight
 * files is not a rule. The only other module allowed to touch safeStorage is
 * collaboration/local-keyring.js, which wraps its own AES-GCM key with it and
 * already refuses without a keyring.
 */

const SECRET_STORAGE_UNAVAILABLE = "SECRET_STORAGE_UNAVAILABLE";

function getSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}

function plaintextAllowed() {
  return process.env.LILY_ALLOW_PLAINTEXT_SECRETS === "1";
}

function secretStorageAvailable() {
  if (plaintextAllowed()) return true;
  return Boolean(getSafeStorage()?.isEncryptionAvailable?.());
}

function refusal() {
  return Object.assign(new Error("Secure secret storage is unavailable"), { code: SECRET_STORAGE_UNAVAILABLE });
}

/** Is this error the storage refusing a new secret (as opposed to anything else)? */
function isSecretStorageRefusal(error) {
  return error?.code === SECRET_STORAGE_UNAVAILABLE;
}

/**
 * Protect a secret for disk. Returns null for an empty value, a record
 * `{ encrypted, data }` otherwise; throws SECRET_STORAGE_UNAVAILABLE when the
 * OS storage is missing and plaintext was not opted into.
 */
function protectSecret(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const safeStorage = getSafeStorage();
  if (safeStorage?.isEncryptionAvailable?.()) {
    return { encrypted: true, data: safeStorage.encryptString(text).toString("base64") };
  }
  if (plaintextAllowed()) {
    return { encrypted: false, data: Buffer.from(text, "utf8").toString("base64") };
  }
  throw refusal();
}

/** Read a protected record back; "" when absent, unreadable, or the keyring is gone. */
function unprotectSecret(record) {
  if (!record?.data) return "";
  const buf = Buffer.from(String(record.data), "base64");
  if (!record.encrypted) return buf.toString("utf8");
  const safeStorage = getSafeStorage();
  if (!safeStorage?.isEncryptionAvailable?.()) return "";
  try {
    return safeStorage.decryptString(buf);
  } catch {
    return "";
  }
}

/** A plain value wins over its protected record — used where both may be present. */
function hydrateSecret(value, protectedRecord) {
  const plain = String(value || "").trim();
  if (plain) return plain;
  return unprotectSecret(protectedRecord);
}

function protectJson(value) {
  return protectSecret(JSON.stringify(value || {}));
}

function unprotectJson(record) {
  const text = unprotectSecret(record);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  SECRET_STORAGE_UNAVAILABLE,
  getSafeStorage,
  hydrateSecret,
  isSecretStorageRefusal,
  protectJson,
  protectSecret,
  secretStorageAvailable,
  unprotectJson,
  unprotectSecret,
};
