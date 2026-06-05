"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("electron");
const { userDataPath } = require("./config");

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
  return {
    deviceId: getDeviceId(),
    fingerprintHash: fingerprintHash(),
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
  };
}

async function serviceFetch(pathname, options = {}) {
  const { apiBaseUrl } = getServiceSettings();
  if (!apiBaseUrl) return { ok: false, error: "NO_SERVICE_URL" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
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
  latestRelease,
  testConnection,
  submitContactRequest,
};
