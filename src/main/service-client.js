"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { userDataPath, appVersion, appEdition } = require("./config");

// safeStorage is electron-only; lazy-require it inside the crypto functions so
// this module loads in plain node (tests/CLIs). Absent → graceful plaintext
// fallback via the `?.` guards below.
function electronSafeStorage() {
  try {
    return require("electron").safeStorage || null;
  } catch {
    return null;
  }
}
const { base64urlEncode, stableStringify } = require("./crypto-signing");

const DEVICE_FILE = "device-state.json";
const CLIENT_POLICY_FILE = "client-bootstrap-policy.json";
const FETCH_TIMEOUT_MS = 15_000;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;
const BUILTIN_SERVICE_API_BASE_URL = "https://lilych.lilywb.cn";
const BUILTIN_UAE_SERVICE_API_BASE_URL = "https://lilyuae.lilywb.cn";
const EDGE_FALLBACK_SAFE_POST_PATHS = new Set([
  "/api/devices/register",
  "/api/client/config",
  "/api/usage/summary",
]);

function devicePath() {
  return userDataPath(DEVICE_FILE);
}

function clientPolicyPath() {
  return userDataPath(CLIENT_POLICY_FILE);
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
  const safeStorage = electronSafeStorage();
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
  const safeStorage = electronSafeStorage();
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

function defaultFeatures() {
  const editionFeatures = appEdition().features || {};
  return {
    accountLogin: editionFeatures.account !== false,
    purchase: editionFeatures.billing !== false,
    licenseActivation: true,
    usage: true,
    modelDirect: false,
    account: editionFeatures.account !== false,
    billing: editionFeatures.billing !== false,
  };
}

function builtinServiceApiBaseUrl() {
  return localClientRegionHint() === "uae" ? BUILTIN_UAE_SERVICE_API_BASE_URL : BUILTIN_SERVICE_API_BASE_URL;
}

function hasExplicitServiceApiBaseUrl() {
  return Boolean(process.env.LILY_SERVICE_API_BASE_URL || process.env.SERVICE_API_BASE_URL);
}

function configuredServiceApiBaseUrl() {
  if (hasExplicitServiceApiBaseUrl()) {
    return normalizeBaseUrl(process.env.LILY_SERVICE_API_BASE_URL || process.env.SERVICE_API_BASE_URL);
  }
  if (localClientRegionHint() === "uae") return BUILTIN_UAE_SERVICE_API_BASE_URL;
  return appEdition().serviceApiBaseUrl || BUILTIN_SERVICE_API_BASE_URL;
}

function serviceBaseCandidates(primaryBaseUrl) {
  const primary = normalizeBaseUrl(primaryBaseUrl);
  const candidates = primary ? [primary] : [];
  if (
    !hasExplicitServiceApiBaseUrl() &&
    primary === BUILTIN_UAE_SERVICE_API_BASE_URL &&
    !candidates.includes(BUILTIN_SERVICE_API_BASE_URL)
  ) {
    candidates.push(BUILTIN_SERVICE_API_BASE_URL);
  }
  return candidates;
}

function serviceBaseCandidatesForRequest(primaryBaseUrl, pathname, method) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedPath = String(pathname || "").split("?")[0];
  if (normalizedMethod !== "GET" && !EDGE_FALLBACK_SAFE_POST_PATHS.has(normalizedPath)) {
    const primary = normalizeBaseUrl(primaryBaseUrl);
    return primary ? [primary] : [];
  }
  return serviceBaseCandidates(primaryBaseUrl);
}

function pinPolicyToServiceBase(policy, baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base || base === normalizeBaseUrl(policy?.apiBaseUrl || policy?.gatewayBaseUrl)) return policy;
  return {
    ...policy,
    gatewayBaseUrl: base,
    apiBaseUrl: base,
    modelGatewayBaseUrl: `${base}/llm`,
    edgeFallbackFrom: normalizeBaseUrl(policy?.apiBaseUrl || policy?.gatewayBaseUrl),
  };
}

function defaultClientPolicy() {
  const baseUrl = normalizeBaseUrl(configuredServiceApiBaseUrl() || builtinServiceApiBaseUrl());
  const region = localClientRegionHint() || "china";
  return {
    ok: true,
    schemaVersion: 1,
    source: "default",
    region,
    gatewayBaseUrl: baseUrl,
    apiBaseUrl: baseUrl,
    modelGatewayBaseUrl: `${baseUrl}/llm`,
    features: defaultFeatures(),
    routing: {
      modelMode: "gateway",
      releaseChannel: "domestic",
      skillRegistry: "default",
    },
    expiresAt: "",
  };
}

function localClientRegionHint() {
  const explicit = String(process.env.LILY_CLIENT_REGION || process.env.CLIENT_REGION || "").trim().toLowerCase();
  if (["uae", "ae", "are", "overseas"].includes(explicit)) return "uae";
  if (["china", "cn", "domestic"].includes(explicit)) return "china";

  const timeZone = String(
    Intl.DateTimeFormat?.().resolvedOptions?.().timeZone ||
      process.env.TZ ||
      "",
  ).trim().toLowerCase();
  if (["asia/dubai", "asia/muscat"].includes(timeZone)) return "uae";
  return "";
}

function normalizeClientPolicy(raw = {}, source = "remote") {
  const fallback = defaultClientPolicy();
  const apiBaseUrl = normalizeBaseUrl(raw.apiBaseUrl || raw.gatewayBaseUrl || fallback.apiBaseUrl);
  const gatewayBaseUrl = normalizeBaseUrl(raw.gatewayBaseUrl || apiBaseUrl);
  const modelGatewayBaseUrl = normalizeBaseUrl(raw.modelGatewayBaseUrl || `${gatewayBaseUrl}/llm`);
  const features = {
    ...fallback.features,
    ...(raw.features || {}),
  };
  if (features.accountLogin === false) features.account = false;
  if (features.purchase === false) features.billing = false;
  return {
    ...fallback,
    ...raw,
    ok: raw.ok !== false,
    source,
    region: String(raw.region || fallback.region || "china"),
    apiBaseUrl,
    gatewayBaseUrl,
    modelGatewayBaseUrl,
    features,
    routing: {
      ...fallback.routing,
      ...(raw.routing || {}),
    },
  };
}

let clientPolicyCache = null;

function loadStoredClientPolicy() {
  if (clientPolicyCache) return clientPolicyCache;
  const stored = readJson(clientPolicyPath(), null);
  if (stored?.apiBaseUrl) {
    const expiresAtMs = Date.parse(stored.expiresAt || "");
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > Date.now()) {
      clientPolicyCache = normalizeClientPolicy(stored, "cache");
      return clientPolicyCache;
    }
  }
  clientPolicyCache = defaultClientPolicy();
  return clientPolicyCache;
}

function storeClientPolicy(policy) {
  clientPolicyCache = normalizeClientPolicy(policy, "remote");
  writeJson(clientPolicyPath(), clientPolicyCache);
  return clientPolicyCache;
}

function getClientPolicy() {
  return loadStoredClientPolicy();
}

function defaultApiBaseUrl() {
  if (process.env.LILY_SERVICE_API_BASE_URL || process.env.SERVICE_API_BASE_URL) {
    return normalizeBaseUrl(process.env.LILY_SERVICE_API_BASE_URL || process.env.SERVICE_API_BASE_URL);
  }
  const policy = getClientPolicy();
  if (policy?.apiBaseUrl) return normalizeBaseUrl(policy.apiBaseUrl);
  return normalizeBaseUrl(
    appEdition().serviceApiBaseUrl ||
      BUILTIN_SERVICE_API_BASE_URL,
  );
}

function getServiceSettings() {
  return {
    ok: true,
    apiBaseUrl: defaultApiBaseUrl(),
    configurable: false,
    policy: getClientPolicy(),
  };
}

async function refreshClientBootstrap({ force = false } = {}) {
  const current = getClientPolicy();
  const expiresAtMs = Date.parse(current.expiresAt || "");
  const regionHint = localClientRegionHint();
  const cacheMatchesRegionHint = !regionHint || String(current.region || "").toLowerCase() === regionHint;
  if (!force && cacheMatchesRegionHint && current.source !== "default" && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
    return current;
  }
  const bootstrapBaseUrl = normalizeBaseUrl(
    configuredServiceApiBaseUrl() || builtinServiceApiBaseUrl(),
  );
  if (!bootstrapBaseUrl) return current;
  let lastError = null;
  for (const baseUrl of serviceBaseCandidates(bootstrapBaseUrl)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/api/client/bootstrap`, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Lily-Device-Id": getDeviceId(),
          "X-Lily-App-Version": appVersion(),
          "X-Lily-Platform": process.platform,
          ...(regionHint ? { "X-Lily-Region": regionHint } : {}),
        },
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.ok === false) {
        return { ...current, ok: false, error: json?.code || "BOOTSTRAP_FAILED", status: response.status };
      }
      const policy = baseUrl === bootstrapBaseUrl ? json : pinPolicyToServiceBase(json, baseUrl);
      return storeClientPolicy(policy);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ...current, ok: false, error: "BOOTSTRAP_FAILED", detail: lastError?.message || String(lastError) };
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
    appVersion: appVersion(),
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

  const method = String(options.method || "GET").toUpperCase();
  const body = options.body || "";
  let lastError = null;
  for (const baseUrl of serviceBaseCandidatesForRequest(apiBaseUrl, pathname, method)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}${pathname}`, {
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
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "SERVICE_REQUEST_FAILED", detail: lastError?.message || String(lastError) };
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

async function sendSmsCode(phone) {
  return serviceFetch("/api/auth/sms/send", {
    method: "POST",
    body: JSON.stringify({
      phone: String(phone || "").trim(),
      purpose: "login",
      deviceId: getDeviceId(),
    }),
  });
}

async function loginWithSms({ phone, code } = {}) {
  return serviceFetch("/api/auth/sms/login", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      phone: String(phone || "").trim(),
      code: String(code || "").trim(),
    }),
  });
}

async function refreshAccountAccessToken(refreshToken) {
  return serviceFetch("/api/auth/session/refresh", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      refreshToken: String(refreshToken || "").trim(),
    }),
  });
}

async function logoutAccount(refreshToken) {
  return serviceFetch("/api/auth/session/logout", {
    method: "POST",
    body: JSON.stringify({
      refreshToken: String(refreshToken || "").trim(),
    }),
  });
}

async function fetchAccountEntitlements(accessToken) {
  return serviceFetch("/api/account/entitlements", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(accessToken || "").trim()}`,
    },
    body: JSON.stringify(devicePayload()),
  });
}

async function createBillingLink(accessToken) {
  return serviceFetch("/api/account/billing-link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(accessToken || "").trim()}`,
    },
    body: JSON.stringify(devicePayload()),
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
  return serviceFetch("/api/skills/registry", {
    method: "GET",
    headers: {},
  });
}

async function workspaceAppCatalog() {
  return serviceFetch("/api/apps/catalog", {
    method: "GET",
    headers: {},
  });
}

// Resolve the artifact URL for a gated (VIP/pro) app. serviceFetch signs the
// request with this device's key; the server checks the device's license tier
// and returns the URL only if entitled (else 403 NOT_ENTITLED). Free apps don't
// need this — their URL is inline in the catalog.
async function workspaceAppDownload(appId, channel = "stable") {
  return serviceFetch(`/api/apps/${encodeURIComponent(String(appId || ""))}/download`, {
    method: "POST",
    body: JSON.stringify({ deviceId: getDeviceId(), channel: channel || "stable" }),
  });
}

// license-manager injects this at load time — service-client must not require
// it back (license-manager is a client of this module, not a dependency).
let licenseIdProvider = () => null;

function setLicenseIdProvider(provider) {
  licenseIdProvider = provider;
}

function currentLicenseId() {
  try {
    return licenseIdProvider() || null;
  } catch {
    return null;
  }
}

async function reportSkillEvent(payload) {
  return serviceFetch("/api/skills/events", {
    method: "POST",
    body: JSON.stringify({
      ...devicePayload(),
      licenseId: currentLicenseId(),
      eventType: payload?.eventType,
      skillId: payload?.skillId,
      skillVersion: payload?.skillVersion || null,
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

/**
 * Resolve the download for an optional runtime pack. The server
 * decides the artifact URL (e.g. a Qiniu CDN object), so the source is
 * configurable server-side and reachable inside China without hitting PyPI.
 * @returns {Promise<{ ok: boolean, artifact?: { url: string, sha256: string, version?: string, size?: number } }>}
 */
async function runtimePackArtifact(packId, platformKey) {
  const params = new URLSearchParams({
    pack: String(packId || ""),
    platform: String(platformKey || ""),
  });
  return serviceFetch(`/api/runtime-packs/artifact?${params.toString()}`, {
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

async function requestFeedbackAttachmentUpload(payload) {
  return serviceFetch("/api/contact-attachments/upload-token", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function uploadFeedbackAttachment(upload, attachment) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_UPLOAD_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("token", upload.token);
    form.append("key", upload.key);
    form.append("file", new Blob([attachment.data], { type: attachment.mimeType }), attachment.name);
    const response = await fetch(upload.uploadUrl, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: json?.error || "ATTACHMENT_UPLOAD_FAILED", status: response.status };
    }
    return {
      ok: true,
      attachment: {
        key: upload.key,
        url: upload.publicUrl,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        width: attachment.width || null,
        height: attachment.height || null,
        sha256: attachment.sha256 || null,
      },
    };
  } catch (error) {
    return { ok: false, error: "ATTACHMENT_UPLOAD_FAILED", detail: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  setLicenseIdProvider,
  getClientPolicy,
  refreshClientBootstrap,
  getServiceSettings,
  getDeviceId,
  devicePayload,
  sendSmsCode,
  loginWithSms,
  refreshAccountAccessToken,
  logoutAccount,
  fetchAccountEntitlements,
  createBillingLink,
  registerDevice,
  activateLicenseKey,
  verifyLicense,
  reportUsage,
  fetchUsageSummary,
  skillRegistry,
  workspaceAppCatalog,
  workspaceAppDownload,
  reportSkillEvent,
  reportRuntimeDiagnostic,
  fetchClientConfig,
  rotateDeviceKeypair,
  latestRelease,
  runtimePackArtifact,
  testConnection,
  submitContactRequest,
  requestFeedbackAttachmentUpload,
  uploadFeedbackAttachment,
};
