"use strict";

// Website login credential vault for the web-system-learning skill (#1b). Lets the
// user store a site's username/password so the platform can auto-login during
// capture and auto re-login when a learned session expires with no refresh
// endpoint. Mirrors mail-accounts.js exactly (the existing credentialed-connector
// precedent): secrets are encrypted at rest via Electron safeStorage, stored as a
// `secretProtected` record (NEVER plaintext), and the plaintext is only ever
// produced by getCredentialWithSecret() in the MAIN process — never sent to the
// renderer, the executor, playbooks, or logs. See [[web-system-executor-reliability]].

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");

function getSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}

function defaultCredentialsPath() {
  return userDataPath("web-system-credentials.json");
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(filePath, 0o600); // best-effort: tighten perms like capture_session
  } catch {
    /* non-fatal (e.g. Windows) */
  }
}

// Same shape as mail-accounts.protectSecret: safeStorage when available, else a
// base64 fallback. Either way the on-disk value is NOT the plaintext.
function protectSecret(value) {
  const text = String(value || "");
  if (!text) return null;
  const safeStorage = getSafeStorage();
  if (safeStorage?.isEncryptionAvailable?.()) {
    return { encrypted: true, data: safeStorage.encryptString(text).toString("base64") };
  }
  return { encrypted: false, data: Buffer.from(text, "utf8").toString("base64") };
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

// Hostname only — credentials are bound to a domain so a re-login lookup can match
// a request URL to its stored credential.
function normalizeDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("domain is required");
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase().split("/")[0].split(":")[0];
  }
}

function publicView(cred) {
  return {
    id: cred.id,
    domain: cred.domain,
    loginUrl: cred.loginUrl || "",
    username: cred.username || "",
    secretSet: Boolean(cred.secretProtected),
    updatedAt: cred.updatedAt || "",
  };
}

class WebCredentialStore {
  constructor(opts = {}) {
    this.filePath = opts.filePath || defaultCredentialsPath();
    this.now = typeof opts.now === "function" ? opts.now : () => new Date().toISOString();
  }

  _read() {
    const data = readJson(this.filePath, { version: 1, credentials: [] });
    if (!Array.isArray(data.credentials)) data.credentials = [];
    return data;
  }

  // Upsert by domain (one credential per site). Password is encrypted immediately;
  // a blank password on an existing record keeps the stored secret.
  saveCredential(input = {}) {
    const domain = normalizeDomain(input.domain);
    const data = this._read();
    const existing = data.credentials.find((c) => c.domain === domain);
    const password = input.password !== undefined ? String(input.password) : "";
    const secretProtected = password ? protectSecret(password) : existing?.secretProtected || null;
    const record = {
      id: existing?.id || `webcred-${domain}`.replace(/[^a-z0-9-]+/gi, "-"),
      domain,
      loginUrl: input.loginUrl !== undefined ? String(input.loginUrl || "") : existing?.loginUrl || "",
      username: input.username !== undefined ? String(input.username || "") : existing?.username || "",
      secretProtected,
      createdAt: existing?.createdAt || this.now(),
      updatedAt: this.now(),
    };
    data.credentials = [...data.credentials.filter((c) => c.domain !== domain), record];
    writeJson(this.filePath, data);
    return publicView(record);
  }

  listCredentialsPublic() {
    return this._read().credentials.map(publicView);
  }

  deleteCredential(domainOrId) {
    const key = String(domainOrId || "");
    const data = this._read();
    const before = data.credentials.length;
    data.credentials = data.credentials.filter((c) => c.domain !== key && c.id !== key);
    writeJson(this.filePath, data);
    return data.credentials.length < before;
  }

  // MAIN-PROCESS ONLY. Returns the decrypted password. Callers must use it for an
  // in-process login and never forward it to the renderer/executor/logs.
  getCredentialWithSecret(domainOrId) {
    const key = String(domainOrId || "");
    const cred = this._read().credentials.find((c) => c.domain === key || c.id === key);
    if (!cred) return null;
    return { ...publicView(cred), password: unprotectSecret(cred.secretProtected) };
  }

  // Resolve the credential whose domain matches a request URL (exact or subdomain),
  // so the host can decide whether an auto re-login is possible for a stale session.
  findCredentialForUrl(url) {
    let host;
    try {
      host = new URL(String(url)).hostname.toLowerCase();
    } catch {
      return null;
    }
    const match = this._read().credentials.find((c) => host === c.domain || host.endsWith(`.${c.domain}`));
    return match ? publicView(match) : null;
  }
}

module.exports = {
  WebCredentialStore,
  defaultCredentialsPath,
  normalizeDomain,
  protectSecret,
  unprotectSecret,
};
