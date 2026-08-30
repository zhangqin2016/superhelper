"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("../config");

const KEY_BYTES = 32;
const AAD_PREFIX = "lily-collaboration-local/v1";

function collaborationKeyringError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stableId(value, label) {
  const text = String(value || "").trim();
  if (!text || text.length > 512) throw collaborationKeyringError("COLLAB_LOCAL_KEY_INVALID", `${label} is invalid.`);
  return text;
}

function hashId(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}

function aad(...parts) {
  return Buffer.from([AAD_PREFIX, ...parts].join("\0"), "utf8");
}

function encryptAesGcm({ key, plaintext, associatedData }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

function decryptAesGcm({ key, envelope, associatedData }) {
  if (!envelope || envelope.v !== 1 || !envelope.iv || !envelope.ciphertext || !envelope.tag) {
    throw collaborationKeyringError("COLLAB_LOCAL_CIPHERTEXT_INVALID", "The local encrypted payload is malformed.");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(associatedData);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
  } catch {
    throw collaborationKeyringError("COLLAB_LOCAL_CIPHERTEXT_INVALID", "The local encrypted payload cannot be authenticated.");
  }
}

function defaultKeyringPath() {
  return userDataPath("collaboration-keyring.json");
}

class LocalCollaborationKeyring {
  constructor({ filePath = defaultKeyringPath(), safeStorage = getSafeStorage() } = {}) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
  }

  _assertAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) {
      throw collaborationKeyringError("COLLAB_LOCAL_KEYRING_UNAVAILABLE", "The operating-system keyring is unavailable.");
    }
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return parsed && parsed.version === 1 && parsed.accounts && typeof parsed.accounts === "object"
        ? parsed
        : { version: 1, accounts: {} };
    } catch {
      return { version: 1, accounts: {} };
    }
  }

  _write(value) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, this.filePath);
      try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows */ }
    } finally {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* harmless */ }
    }
  }

  _protectKey(key) {
    this._assertAvailable();
    return this.safeStorage.encryptString(key.toString("base64")).toString("base64");
  }

  _unprotectKey(protectedKey) {
    this._assertAvailable();
    try {
      const key = Buffer.from(this.safeStorage.decryptString(Buffer.from(protectedKey, "base64")), "base64");
      if (key.length !== KEY_BYTES) throw new Error("bad key length");
      return key;
    } catch {
      throw collaborationKeyringError("COLLAB_LOCAL_KEY_UNAVAILABLE", "The local account key cannot be recovered.");
    }
  }

  _account(data, accountId, { create = false } = {}) {
    const accountKey = hashId(stableId(accountId, "account id"));
    let account = data.accounts[accountKey];
    if (!account && create) {
      account = { masterProtected: this._protectKey(crypto.randomBytes(KEY_BYTES)), scopes: {} };
      data.accounts[accountKey] = account;
    }
    return { accountKey, account };
  }

  _scope(masterKey, accountId, scopeId, account, { create = false } = {}) {
    const scopeKey = hashId(stableId(scopeId, "scope id"));
    let wrapped = account.scopes?.[scopeKey];
    if (!wrapped && create) {
      const scopeSecret = crypto.randomBytes(KEY_BYTES);
      wrapped = encryptAesGcm({ key: masterKey, plaintext: scopeSecret, associatedData: aad("scope", accountId, scopeId) });
      account.scopes[scopeKey] = wrapped;
    }
    if (!wrapped) throw collaborationKeyringError("COLLAB_LOCAL_KEY_UNAVAILABLE", "The local scope key is unavailable.");
    return decryptAesGcm({ key: masterKey, envelope: wrapped, associatedData: aad("scope", accountId, scopeId) });
  }

  _keyFor({ accountId, scopeId, create }) {
    this._assertAvailable();
    const normalizedAccount = stableId(accountId, "account id");
    const normalizedScope = stableId(scopeId, "scope id");
    const data = this._read();
    const { account } = this._account(data, normalizedAccount, { create });
    if (!account) throw collaborationKeyringError("COLLAB_LOCAL_KEY_UNAVAILABLE", "The local account key is unavailable.");
    const masterKey = this._unprotectKey(account.masterProtected);
    const key = this._scope(masterKey, normalizedAccount, normalizedScope, account, { create });
    if (create) this._write(data);
    return { key, accountId: normalizedAccount, scopeId: normalizedScope };
  }

  encrypt({ accountId, scopeId, recordId, plaintext }) {
    const record = stableId(recordId, "record id");
    const material = this._keyFor({ accountId, scopeId, create: true });
    return encryptAesGcm({ key: material.key, plaintext: Buffer.from(String(plaintext), "utf8"), associatedData: aad("record", material.accountId, material.scopeId, record) });
  }

  decrypt({ accountId, scopeId, recordId, envelope }) {
    const record = stableId(recordId, "record id");
    const material = this._keyFor({ accountId, scopeId, create: false });
    return decryptAesGcm({ key: material.key, envelope, associatedData: aad("record", material.accountId, material.scopeId, record) }).toString("utf8");
  }

  destroyScopeKey({ accountId, scopeId }) {
    this._assertAvailable();
    const data = this._read();
    const { account } = this._account(data, accountId);
    if (!account) return false;
    const removed = delete account.scopes[hashId(stableId(scopeId, "scope id"))];
    if (removed) this._write(data);
    return removed;
  }
}

module.exports = {
  LocalCollaborationKeyring,
  collaborationKeyringError,
  defaultKeyringPath,
};
