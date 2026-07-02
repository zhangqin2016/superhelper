"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { userDataPath } = require("./config");
const serviceClient = require("./service-client");

const ACCOUNT_FILE = "account-state.json";

let accessToken = "";
let accessExpiresAt = 0;

function electronSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}

function statePath() {
  return userDataPath(ACCOUNT_FILE);
}

function readState() {
  try {
    const file = statePath();
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

function protectText(text) {
  const safeStorage = electronSafeStorage();
  if (safeStorage?.isEncryptionAvailable?.()) {
    return { encrypted: true, data: safeStorage.encryptString(String(text || "")).toString("base64") };
  }
  return { encrypted: false, data: Buffer.from(String(text || ""), "utf8").toString("base64") };
}

function unprotectText(record) {
  if (!record?.data) return "";
  const buf = Buffer.from(record.data, "base64");
  if (!record.encrypted) return buf.toString("utf8");
  const safeStorage = electronSafeStorage();
  if (!safeStorage?.isEncryptionAvailable?.()) return "";
  try {
    return safeStorage.decryptString(buf);
  } catch {
    return "";
  }
}

function tokenFresh() {
  return accessToken && accessExpiresAt && Date.now() + 30_000 < accessExpiresAt;
}

async function ensureAccessToken() {
  if (tokenFresh()) return { ok: true, accessToken };
  const state = readState();
  const refreshToken = unprotectText(state.refreshToken);
  if (!refreshToken) return { ok: false, error: "ACCOUNT_LOGIN_REQUIRED" };
  const refreshed = await serviceClient.refreshAccountAccessToken(refreshToken);
  if (!refreshed.ok) {
    clearAccount();
    return refreshed;
  }
  accessToken = refreshed.json?.accessToken || "";
  accessExpiresAt = Date.now() + Number(refreshed.json?.expiresIn || 0) * 1000;
  if (!accessToken) return { ok: false, error: "INVALID_ACCOUNT_TOKEN" };
  return { ok: true, accessToken };
}

function accountStatus() {
  const state = readState();
  const refreshToken = unprotectText(state.refreshToken);
  return {
    ok: true,
    loggedIn: Boolean(refreshToken && state.user?.id),
    user: state.user || null,
    entitlements: state.entitlements || null,
  };
}

async function sendSmsCode(phone) {
  return serviceClient.sendSmsCode(phone);
}

async function loginWithSms({ phone, code } = {}) {
  const result = await serviceClient.loginWithSms({ phone, code });
  if (!result.ok) return result;
  const refreshToken = result.json?.refreshToken || "";
  accessToken = result.json?.accessToken || "";
  accessExpiresAt = Date.now() + Number(result.json?.expiresIn || 0) * 1000;
  writeState({
    user: result.json?.user || null,
    entitlements: result.json?.entitlements || null,
    refreshToken: protectText(refreshToken),
    loggedInAt: new Date().toISOString(),
  });
  return {
    ok: true,
    user: result.json?.user || null,
    entitlements: result.json?.entitlements || null,
  };
}

async function refreshEntitlements() {
  const token = await ensureAccessToken();
  if (!token.ok) return token;
  const result = await serviceClient.fetchAccountEntitlements(token.accessToken);
  if (!result.ok) return result;
  const state = readState();
  writeState({
    ...state,
    entitlements: result.json?.entitlements || null,
    entitlementsRefreshedAt: new Date().toISOString(),
  });
  return { ok: true, entitlements: result.json?.entitlements || null };
}

async function createBillingLink() {
  const token = await ensureAccessToken();
  if (!token.ok) return token;
  const result = await serviceClient.createBillingLink(token.accessToken);
  if (!result.ok) return result;
  return {
    ok: true,
    url: result.json?.url || "",
    expiresIn: result.json?.expiresIn || 0,
  };
}

async function accessTokenForService() {
  return ensureAccessToken();
}

async function logout() {
  const state = readState();
  const refreshToken = unprotectText(state.refreshToken);
  if (refreshToken) await serviceClient.logoutAccount(refreshToken);
  clearAccount();
  return { ok: true };
}

function clearAccount() {
  accessToken = "";
  accessExpiresAt = 0;
  writeState({});
}

module.exports = {
  accountStatus,
  sendSmsCode,
  loginWithSms,
  refreshEntitlements,
  createBillingLink,
  accessTokenForService,
  logout,
  clearAccount,
};
