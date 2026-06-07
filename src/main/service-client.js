"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");
const { userDataPath } = require("./config");
const { base64urlEncode, stableStringify } = require("./crypto-signing");

const DEVICE_FILE = "device-state.json";
const FETCH_TIMEOUT_MS = 15_000;
const BUILTIN_SERVICE_API_BASE_URL = "https://lily.lanrensoft.cn";

function devicePath() {
  return userDataPath(DEVICE_FILE);
}

function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function protectText(text) {
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

function unprotectText(record) {
  if (!record?.data) return "";
  const buf = Buffer.from(record.data, "base64");
  if (!record.encrypted) return buf.toString("utf8");
  if (!safeStorage?.isEncryptionAvailable?.()) return "";
  try {
    return safeStorage.decryptString(buf);
  } catch {
    return "";
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function defaultApiBaseUrl() {
  return normalizeBaseUrl(
    process.env.LILY_SERVICE_API_BASE_URL ||
      process.env.SERVICE_API_BASE_URL ||
      BUILTIN_SERVICE_API_BASE_URL,
  );
}

function getServiceSettings() {
  return {
    ok: true,
    apiBaseUrl: defaultApiBaseUrl(),
    configurable: false,
  };
}

function getDeviceId() {
  const state = readJson(devicePath(), {});
  if (state.deviceId) return String(state.deviceId);
  const deviceId = `dev_${crypto.randomUUID()}`;
  writeJson(devicePath(), { ...state, deviceId, createdAt: new Date().toISOString() });
  return deviceId;
}

function getDeviceKeypair() {
  const state = readJson(devicePath(), {});
  const existingPrivateKey = unprotectText(state.privateKey);
  if (state.publicKey && existingPrivateKey) {
    return {
      publicKey: String(state.publicKey),
      privateKey: existingPrivateKey,
      keyAlg: state.keyAlg || "ed25519",
    };
  }

  const keypair = createDeviceKeypair();
  storeDeviceKeypair(keypair, state);
  return keypair;
}

function createDeviceKeypair() {
  const pair = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    keyAlg: "ed25519",
  };
}

function storeDeviceKeypair(keypair, existingState = readJson(devicePath(), {})) {
  const state = existingState || {};
  writeJson(devicePath(), {
    ...state,
    deviceId: state.deviceId || `dev_${crypto.randomUUID()}`,
    publicKey: keypair.publicKey,
    privateKey: protectText(keypair.privateKey),
    keyAlg: keypair.keyAlg || "ed25519",
    createdAt: state.createdAt || new Date().toISOString(),
    keyCreatedAt: new Date().toISOString(),
  });
}

function fingerprintHash() {
  const source = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.userInfo().username,
  ].join("|");
  return crypto.createHash("sha256").update(source).digest("hex");
}

function devicePayload() {
  const keypair = getDeviceKeypair();
  return {
    deviceId: getDeviceId(),
    fingerprintHash: fingerprintHash(),
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    publicKey: keypair.publicKey,
    keyAlg: keypair.keyAlg,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function parseJsonBody(body) {
  if (!body) return null;
  try {
    return JSON.parse(String(body));
  } catch {
    return null;
  }
}

function requestSignatureHeaders(method, pathname, body) {
  const keypair = getDeviceKeypair();
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyObject = parseJsonBody(body);
  const bodyHash = sha256(bodyObject ? stableStringify(bodyObject) : "");
  const canonical = {
    method: String(method || "GET").toUpperCase(),
    pathname: String(pathname || "").split("?")[0],
    timestamp,
    nonce,
    bodyHash,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(stableStringify(canonical)),
    crypto.createPrivateKey(keypair.privateKey),
  );
  return {
    "X-Lily-Device-Id": getDeviceId(),
    "X-Lily-Key-Alg": keypair.keyAlg,
    "X-Lily-Timestamp": timestamp,
    "X-Lily-Nonce": nonce,
    "X-Lily-Body-Sha256": bodyHash,
    "X-Lily-Signature": base64urlEncode(signature),
  };
}

async function serviceFetch(pathname, options = {}) {
  const { apiBaseUrl } = getServiceSettings();
  if (!apiBaseUrl) return { ok: false, error: "NO_SERVICE_URL" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const method = String(options.method || "GET").toUpperCase();
  const body = options.body || "";
  try {
    const response = await fetch(`${apiBaseUrl}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...requestSignatureHeaders(method, pathname, body),
        ...(options.headers || {}),
      },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json?.ok === false) {
      return { ok: false, error: json?.code || "SERVICE_REQUEST_FAILED", status: response.status };
    }
    return { ok: true, json };
  } catch (error) {
    return { ok: false, error: "SERVICE_REQUEST_FAILED", detail: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function registerDevice() {
  return serviceFetch("/api/devices/register", {
    method: "POST",
    body: JSON.stringify(devicePayload()),
  });
}

async function activateLicenseKey(licenseKey) {
  const payload = {
    ...devicePayload(),
    licenseKey: String(licenseKey || "").trim(),
  };
  return serviceFetch("/api/licenses/activate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function verifyLicense(licenseId) {
  return serviceFetch("/api/licenses/verify", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      licenseId: String(licenseId || "").trim(),
    }),
  });
}

async function reportUsage(payload) {
  return serviceFetch("/api/usage/report", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      ...payload,
      deviceId: getDeviceId(),
    }),
  });
}

async function fetchUsageSummary({ historyDays = 30 } = {}) {
  return serviceFetch("/api/usage/summary", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      historyDays,
    }),
  });
}

async function skillRegistry() {
  return serviceFetch("/api/plugins/registry", {
    method: "GET",
    headers: {},
  });
}

function currentLicenseId() {
  try {
    const status = require("./license-manager").getLicenseStatus();
    return status?.license?.licenseId || null;
  } catch {
    return null;
  }
}

async function reportSkillEvent(payload) {
  return serviceFetch("/api/plugins/events", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      licenseId: currentLicenseId(),
      eventType: payload?.eventType,
      pluginId: payload?.pluginId,
      pluginVersion: payload?.pluginVersion || null,
      metadata: payload?.metadata || {},
    }),
  });
}

async function reportRuntimeDiagnostic(payload) {
  return serviceFetch("/api/diagnostics/runtime-traces", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      licenseId: currentLicenseId(),
      claudeVersion: payload?.claudeVersion || null,
      eventType: payload?.eventType || null,
      eventSubtype: payload?.eventSubtype || null,
      normalizedKind: payload?.normalizedKind || null,
      severity: payload?.severity || "warning",
      turnPhase: payload?.turnPhase || null,
      sessionState: payload?.sessionState || null,
      summary: payload?.summary || null,
      trace: payload?.trace || {},
    }),
  });
}

async function fetchClientConfig(payload = {}) {
  return serviceFetch("/api/client/config", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      licenseId: currentLicenseId(),
      ...payload,
      deviceId: getDeviceId(),
    }),
  });
}

async function rotateDeviceKeypair() {
  const current = getDeviceKeypair();
  const next = createDeviceKeypair();
  const payload = {
    ...devicePayload(),
    keyAlg: current.keyAlg,
    newPublicKey: next.publicKey,
    newKeyAlg: next.keyAlg,
  };
  const result = await serviceFetch("/api/devices/rotate-key", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (result.ok) {
    storeDeviceKeypair(next);
  }
  return result;
}

async function latestRelease(platformKey, version) {
  const params = new URLSearchParams({
    platform: String(platformKey || ""),
    version: String(version || ""),
  });
  return serviceFetch(`/api/releases/latest?${params.toString()}`, {
    method: "GET",
    headers: {},
  });
}

async function testConnection() {
  return serviceFetch("/health", { method: "GET", headers: {} });
}

async function submitContactRequest(payload) {
  return serviceFetch("/api/contact-requests", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

module.exports = {
  getServiceSettings,
  getDeviceId,
  devicePayload,
  registerDevice,
  activateLicenseKey,
  verifyLicense,
  reportUsage,
  fetchUsageSummary,
  skillRegistry,
  reportSkillEvent,
  reportRuntimeDiagnostic,
  fetchClientConfig,
  rotateDeviceKeypair,
  latestRelease,
  testConnection,
  submitContactRequest,
};
