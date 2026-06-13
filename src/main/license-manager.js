"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { userDataPath, PROJECT_ROOT } = require("./config");
const serviceClient = require("./service-client");
const {
  base64urlDecode,
  base64urlEncode,
} = require("./crypto-signing");
const crypto = require("node:crypto");

const LICENSE_FILE = "license-state.json";
const DEFAULT_PUBLIC_KEY_PATHS = [
  path.join(process.resourcesPath || "", "resources", "license-public-key.pem"),
  path.join(PROJECT_ROOT, "resources", "license-public-key.pem"),
];

function nowIso() {
  return new Date().toISOString();
}

function parseIsoTime(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function isTransientServerLicenseError(error) {
  return error === "NO_SERVICE_URL" || error === "SERVICE_REQUEST_FAILED";
}

function normalizeServerTrial(payload = {}) {
  return {
    enabled: Boolean(payload.enabled),
    valid: Boolean(payload.valid),
    expiresAt: payload.expiresAt || "",
    rawPayload: payload,
  };
}

function loadPublicKey() {
  const envKey = process.env.LILY_LICENSE_PUBLIC_KEY;
  if (envKey?.includes("BEGIN PUBLIC KEY")) return envKey;
  const envPath = process.env.LILY_LICENSE_PUBLIC_KEY_PATH;
  const paths = envPath ? [envPath, ...DEFAULT_PUBLIC_KEY_PATHS] : DEFAULT_PUBLIC_KEY_PATHS;
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    } catch {
      // try next
    }
  }
  return "";
}

function decodeLicenseToken(token) {
  const [payloadPart, signaturePart] = String(token || "").trim().split(".");
  if (!payloadPart || !signaturePart) {
    return { ok: false, error: "INVALID_FORMAT" };
  }
  try {
    const payload = JSON.parse(base64urlDecode(payloadPart).toString("utf8"));
    return { ok: true, payload, signature: signaturePart, signedPart: payloadPart };
  } catch {
    return { ok: false, error: "INVALID_FORMAT" };
  }
}

function verifyLicenseToken(token, publicKeyPem = loadPublicKey(), opts = {}) {
  const decoded = decodeLicenseToken(token);
  if (!decoded.ok) return decoded;
  if (!publicKeyPem) return { ok: false, error: "NO_PUBLIC_KEY" };

  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(decoded.signedPart),
      crypto.createPublicKey(publicKeyPem),
      base64urlDecode(decoded.signature),
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, error: "BAD_SIGNATURE" };

  const payload = decoded.payload || {};
  const licenseId = String(payload.licenseId || "").trim();
  if (!licenseId) return { ok: false, error: "INVALID_PAYLOAD" };

  const expiresAtMs = parseIsoTime(payload.expiresAt);
  if (!expiresAtMs) return { ok: false, error: "INVALID_EXPIRES_AT" };

  const nowMs = opts.nowMs ?? Date.now();
  const expired = nowMs > expiresAtMs;

  return {
    ok: !expired,
    error: expired ? "EXPIRED" : undefined,
    license: {
      licenseId,
      customer: String(payload.customer || ""),
      plan: String(payload.plan || "standard"),
      issuedAt: payload.issuedAt || "",
      expiresAt: payload.expiresAt,
      seats: Number(payload.seats || 1),
      features: Array.isArray(payload.features) ? payload.features.map(String) : [],
      rawPayload: payload,
    },
  };
}

function statePath() {
  return userDataPath(LICENSE_FILE);
}

function protectText(text) {
  const buf = Buffer.from(text, "utf8");
  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      encrypted: true,
      data: safeStorage.encryptString(text).toString("base64"),
    };
  }
  return { encrypted: false, data: buf.toString("base64") };
}

function unprotectText(record) {
  if (!record?.data) return "";
  const buf = Buffer.from(record.data, "base64");
  if (record.encrypted) {
    if (!safeStorage?.isEncryptionAvailable?.()) return "";
    try {
      return safeStorage.decryptString(buf);
    } catch (err) {
      console.warn("[license] stored license could not be decrypted:", err?.message || err);
      return "";
    }
  }
  return buf.toString("utf8");
}

function readState() {
  try {
    const p = statePath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
}

function getLicenseStatus() {
  const state = readState();
  const token = unprotectText(state.license);
  if (!token && state.license && !state.serverLicense) {
    const invalidState = {
      ...state,
      licenseInvalid: {
        error: "DECRYPT_FAILED",
        checkedAt: nowIso(),
      },
    };
    delete invalidState.license;
    writeState(invalidState);
    return {
      ok: true,
      activated: false,
      valid: false,
      error: "DECRYPT_FAILED",
    };
  }
  if (!token && !state.serverLicense) {
    const trial = normalizeServerTrial(state.serverTrial || {});
    const expiresAtMs = parseIsoTime(trial.expiresAt);
    const valid = Boolean(trial.enabled && expiresAtMs && Date.now() <= expiresAtMs);
    if (trial.enabled) {
      return {
        ok: true,
        activated: true,
        valid,
        error: valid ? undefined : "TRIAL_EXPIRED",
        license: valid
          ? {
              licenseId: "trial",
              customer: "Trial",
              plan: "trial",
              expiresAt: trial.expiresAt,
              features: ["trial"],
              rawPayload: trial.rawPayload,
            }
          : null,
        source: "trial",
      };
    }
    return { ok: true, activated: false };
  }

  if (!token && state.serverLicense) {
    const license = normalizeServerLicense(state.serverLicense);
    const expiresAtMs = parseIsoTime(license?.expiresAt);
    const invalid = state.serverLicenseInvalid;
    const transientInvalid = isTransientServerLicenseError(invalid?.error);
    const valid = Boolean(expiresAtMs && Date.now() <= expiresAtMs && (!invalid?.error || transientInvalid));
    return {
      ok: true,
      activated: true,
      valid,
      error: transientInvalid ? undefined : invalid?.error || (valid ? undefined : "EXPIRED"),
      license,
      source: "server",
      lastSeenTime: state.lastSeenTime || "",
    };
  }

  const checked = verifyLicenseToken(token);
  const lastSeenMs = parseIsoTime(state.lastSeenTime);
  const now = nowIso();
  if (lastSeenMs && Date.now() + 5 * 60_000 < lastSeenMs) {
    return {
      ok: true,
      activated: true,
      valid: false,
      error: "CLOCK_ROLLBACK",
      license: checked.license || null,
      lastSeenTime: state.lastSeenTime,
    };
  }
  writeState({ ...state, lastSeenTime: now });
  return {
    ok: true,
    activated: true,
    valid: Boolean(checked.ok),
    error: checked.error,
    license: checked.license || null,
    source: "offline",
    lastSeenTime: now,
  };
}

function requireValidLicense() {
  const status = getLicenseStatus();
  if (status.activated && status.valid) {
    return { ok: true, license: status.license || null };
  }
  return {
    ok: false,
    error: "LICENSE_REQUIRED",
    licenseStatus: status,
  };
}

async function refreshServerLicense() {
  const state = readState();
  if (!state.serverLicense) {
    const registered = await serviceClient.registerDevice();
    if (!registered.ok) {
      if (isTransientServerLicenseError(registered.error)) {
        return { ...registered, transient: true };
      }
      return registered;
    }
    const trial = normalizeServerTrial(registered.json?.trial || {});
    writeState({
      ...state,
      serverTrial: trial.rawPayload,
      lastSeenTime: nowIso(),
    });
    return { ok: true, trial, source: "trial" };
  }
  const current = normalizeServerLicense(state.serverLicense);
  if (!current.licenseId) return { ok: false, error: "INVALID_PAYLOAD" };
  const verified = await serviceClient.verifyLicense(current.licenseId);
  if (!verified.ok) {
    if (isTransientServerLicenseError(verified.error)) {
      writeState({
        ...state,
        serverLicenseInvalid: null,
        lastSeenTime: nowIso(),
      });
      return { ...verified, transient: true };
    }
    writeState({
      ...state,
      serverLicenseInvalid: {
        error: verified.error,
        checkedAt: nowIso(),
      },
      lastSeenTime: nowIso(),
    });
    return verified;
  }
  const license = normalizeServerLicense(verified.json?.license || {});
  writeState({
    ...state,
    serverLicense: license.rawPayload,
    serverLicenseInvalid: null,
    lastSeenTime: nowIso(),
  });
  return { ok: true, license, source: "server" };
}

function normalizeServerLicense(payload = {}) {
  return {
    licenseId: String(payload.licenseId || ""),
    customer: String(payload.customer || payload.licenseId || ""),
    plan: String(payload.plan || "pro"),
    issuedAt: payload.issuedAt || "",
    expiresAt: payload.expiresAt || "",
    seats: Number(payload.seats || 1),
    features: Array.isArray(payload.features) ? payload.features.map(String) : [],
    deviceId: payload.deviceId || "",
    rawPayload: payload,
  };
}

function activateLicense(token) {
  const checked = verifyLicenseToken(token);
  if (!checked.ok && checked.error !== "INVALID_FORMAT" && checked.error !== "NO_PUBLIC_KEY" && checked.error !== "BAD_SIGNATURE") {
    return checked;
  }
  if (!checked.ok && String(token || "").includes(".")) return checked;

  if (!checked.ok) {
    return serviceClient.activateLicenseKey(token).then((activated) => {
      if (!activated.ok) return activated;
      const license = normalizeServerLicense(activated.json?.license || {});
      if (!license.licenseId || !parseIsoTime(license.expiresAt)) {
        return { ok: false, error: "INVALID_PAYLOAD" };
      }
      const state = readState();
      writeState({
        ...state,
        serverLicense: license.rawPayload,
        serverLicenseInvalid: null,
        serverTrial: null,
        activatedAt: nowIso(),
        lastSeenTime: nowIso(),
      });
      return { ok: true, license, source: "server" };
    });
  }

  const state = readState();
  writeState({
    ...state,
    license: protectText(String(token || "").trim()),
    serverLicense: null,
    serverTrial: null,
    activatedAt: nowIso(),
    lastSeenTime: nowIso(),
  });
  return { ok: true, license: checked.license, source: "offline" };
}

function clearLicense() {
  const state = readState();
  delete state.license;
  delete state.serverLicense;
  delete state.serverLicenseInvalid;
  writeState(state);
  return { ok: true };
}

function createLicenseToken(payload, privateKeyPem) {
  const payloadPart = base64urlEncode(JSON.stringify(payload));
  const sig = crypto.sign(
    null,
    Buffer.from(payloadPart),
    crypto.createPrivateKey(privateKeyPem),
  );
  return `${payloadPart}.${base64urlEncode(sig)}`;
}

serviceClient.setLicenseIdProvider(
  () => getLicenseStatus()?.license?.licenseId || null,
);

module.exports = {
  loadPublicKey,
  verifyLicenseToken,
  activateLicense,
  getLicenseStatus,
  requireValidLicense,
  clearLicense,
  createLicenseToken,
  refreshServerLicense,
};
