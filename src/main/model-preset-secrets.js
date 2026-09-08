"use strict";

/**
 * How a model API key is kept on disk. The OS secure storage (Electron
 * safeStorage) is the only real protection; Base64 is an encoding and is
 * written ONLY under an explicit operator opt-in. Extracted from
 * model-presets.js to keep that module inside its line ratchet.
 */
function getSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}

function secretStorageAvailable() {
  if (process.env.LILY_ALLOW_PLAINTEXT_SECRETS === "1") return true;
  return Boolean(getSafeStorage()?.isEncryptionAvailable?.());
}

function protectSecret(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const safeStorage = getSafeStorage();
  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      encrypted: true,
      data: safeStorage.encryptString(text).toString("base64"),
    };
  }
  // Base64 is an encoding, not encryption. Writing a key that way silently was
  // the bug; it is now an explicit operator choice (LILY_ALLOW_PLAINTEXT_SECRETS=1,
  // e.g. a headless Linux box without a keyring). Records written that way in
  // the past still read back (see unprotectSecret).
  if (process.env.LILY_ALLOW_PLAINTEXT_SECRETS === "1") {
    return { encrypted: false, data: Buffer.from(text, "utf8").toString("base64") };
  }
  throw Object.assign(new Error("Secure secret storage is unavailable"), { code: "SECRET_STORAGE_UNAVAILABLE" });
}

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

function hydrateSecret(value, protectedRecord) {
  const plain = String(value || "").trim();
  if (plain) return plain;
  return unprotectSecret(protectedRecord);
}

module.exports = { getSafeStorage, secretStorageAvailable, protectSecret, unprotectSecret, hydrateSecret };
