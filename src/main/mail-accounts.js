"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { userDataPath } = require("./config");

const PROVIDERS = new Set(["imap-smtp", "gmail", "outlook", "microsoft-365"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}

function defaultMailAccountsPath() {
  return userDataPath("mail-accounts.json");
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
  return {
    encrypted: false,
    data: Buffer.from(text, "utf8").toString("base64"),
  };
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

function normalizeHost(value, field) {
  const host = String(value || "").trim();
  if (!host) throw new Error(`${field} host is required`);
  if (/[/:\\\s]/.test(host)) throw new Error(`${field} host must be a hostname, not a URL`);
  return host;
}

function normalizePort(value, fallback, field) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${field} port is invalid`);
  }
  return port;
}

function normalizeEndpoint(raw, field, fallbackPort) {
  const endpoint = raw && typeof raw === "object" ? raw : {};
  return {
    host: normalizeHost(endpoint.host, field),
    port: normalizePort(endpoint.port, fallbackPort, field),
    secure: endpoint.secure !== false,
  };
}

function normalizeAccount(raw, previous = null) {
  if (!raw || typeof raw !== "object") throw new Error("mail account is required");
  const provider = String(raw.provider || "").trim();
  if (!PROVIDERS.has(provider)) throw new Error(`unsupported mail provider: ${provider || "(empty)"}`);
  const account = String(raw.account || "").trim();
  if (!EMAIL_RE.test(account)) throw new Error("mail account email is invalid");

  const id = String(raw.id || previous?.id || `mail_${crypto.randomUUID()}`).replace(/[^A-Za-z0-9_.:-]/g, "_");
  const label = String(raw.label || previous?.label || account).trim().slice(0, 80) || account;
  const now = new Date().toISOString();
  const base = {
    id,
    provider,
    label,
    account,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    enabled: raw.enabled !== false,
    metadata: raw.metadata && typeof raw.metadata === "object" ? { ...raw.metadata } : {},
  };

  if (provider === "imap-smtp") {
    const secretRecord = String(raw.secret || "").trim()
      ? protectSecret(raw.secret)
      : previous?.secretProtected || null;
    if (!secretRecord) throw new Error("IMAP/SMTP account secret is required");
    return {
      ...base,
      authType: "password",
      status: "connected",
      imap: normalizeEndpoint(raw.imap || previous?.imap, "imap", 993),
      smtp: normalizeEndpoint(raw.smtp || previous?.smtp, "smtp", 465),
      secretProtected: secretRecord,
    };
  }

  const oauth = raw.oauth && typeof raw.oauth === "object" ? raw.oauth : previous?.oauth || {};
  const clientId = String(oauth.clientId || "").trim();
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.map(String).filter(Boolean) : defaultScopes(provider);
  const tokenProtected = previous?.tokenProtected || null;
  return {
    ...base,
    authType: "oauth2",
    status: tokenProtected?.data ? "connected" : clientId ? "configured" : "needs-config",
    oauth: {
      clientId,
      tenantId: String(oauth.tenantId || "").trim(),
      redirectUri: String(oauth.redirectUri || "").trim(),
      scopes,
    },
    secretProtected: previous?.secretProtected || null,
    tokenProtected,
    connectedAt: previous?.connectedAt || null,
  };
}

function defaultScopes(provider) {
  if (provider === "gmail") {
    return [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ];
  }
  return ["Mail.Read", "Mail.ReadWrite", "Mail.Send", "offline_access"];
}

function publicAccount(account) {
  if (!account) return null;
  const copy = { ...account, secretSet: Boolean(account.secretProtected?.data) };
  delete copy.secretProtected;
  delete copy.tokenProtected;
  delete copy.token;
  delete copy.secret;
  return copy;
}

function createMailAccountStore({ filePath = defaultMailAccountsPath() } = {}) {
  function load() {
    const raw = readJson(filePath, { version: 1, accounts: [] });
    return {
      version: 1,
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    };
  }

  function save(data) {
    writeJson(filePath, {
      version: 1,
      accounts: data.accounts || [],
    });
  }

  function find(id) {
    const data = load();
    return {
      data,
      index: data.accounts.findIndex((item) => item.id === id),
    };
  }

  return {
    listAccountsPublic() {
      return load().accounts.map(publicAccount);
    },

    getAccount(id) {
      const { data, index } = find(String(id || ""));
      return index >= 0 ? publicAccount(data.accounts[index]) : null;
    },

    getAccountWithSecret(id) {
      const { data, index } = find(String(id || ""));
      if (index < 0) return null;
      const account = data.accounts[index];
      return {
        ...account,
        secret: unprotectSecret(account.secretProtected),
        token: unprotectJson(account.tokenProtected),
      };
    },

    saveOAuthToken(id, token) {
      const data = load();
      const index = data.accounts.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("mail account not found");
      data.accounts[index] = {
        ...data.accounts[index],
        status: "connected",
        tokenProtected: protectJson(token),
        connectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      save(data);
      return publicAccount(data.accounts[index]);
    },

    saveAccount(raw) {
      const data = load();
      const id = String(raw?.id || "");
      const index = id ? data.accounts.findIndex((item) => item.id === id) : -1;
      const previous = index >= 0 ? data.accounts[index] : null;
      const normalized = normalizeAccount(raw, previous);
      if (index >= 0) data.accounts[index] = normalized;
      else data.accounts.push(normalized);
      save(data);
      return publicAccount(normalized);
    },

    removeAccount(id) {
      const data = load();
      const before = data.accounts.length;
      data.accounts = data.accounts.filter((item) => item.id !== id);
      if (data.accounts.length === before) return false;
      save(data);
      return true;
    },
  };
}

module.exports = {
  createMailAccountStore,
  defaultMailAccountsPath,
  normalizeAccount,
};
