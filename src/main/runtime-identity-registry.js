"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MAX_REVOKED_NONCES = 2_000;

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, sessions: {}, revokedNonces: {} };
}

function safeId(value, name, max = 256) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    const error = new Error(`RUNTIME_IDENTITY_REGISTRY_INVALID: ${name}`);
    error.code = "RUNTIME_IDENTITY_REGISTRY_INVALID";
    throw error;
  }
  return text;
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !parsed.sessions || typeof parsed.sessions !== "object") {
      return emptyState();
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: Number(parsed.revision || 0),
      sessions: parsed.sessions,
      revokedNonces: parsed.revokedNonces && typeof parsed.revokedNonces === "object" ? parsed.revokedNonces : {},
    };
  } catch {
    return emptyState();
  }
}

function atomicWrite(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(temp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
  }
}

function createRuntimeIdentityRegistry({ filePath, now = () => Date.now() } = {}) {
  const registryPath = path.resolve(safeId(filePath, "filePath"));

  function update(mutator) {
    const state = readState(registryPath);
    const result = mutator(state);
    state.revision = Number(state.revision || 0) + 1;
    atomicWrite(registryPath, state);
    return result;
  }

  function grant(input = {}) {
    const engineSessionId = safeId(input.engineSessionId, "engineSessionId");
    const token = safeId(input.token, "token", 8_192);
    const sessionId = safeId(input.sessionId, "sessionId");
    const nonce = safeId(input.nonce, "nonce");
    const expiresAt = Math.floor(Number(input.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      throw Object.assign(new Error("RUNTIME_IDENTITY_REGISTRY_INVALID: expiresAt"), {
        code: "RUNTIME_IDENTITY_REGISTRY_INVALID",
      });
    }
    return update((state) => {
      state.sessions[engineSessionId] = {
        token,
        sessionId,
        nonce,
        expiresAt,
        grantedAt: now(),
        revokedAt: null,
      };
      delete state.revokedNonces[nonce];
      return token;
    });
  }

  function revoke(engineSessionId, reason = "revoked") {
    const id = safeId(engineSessionId, "engineSessionId");
    const state = readState(registryPath);
    if (!state.sessions[id]) return false;
    return update((next) => {
      const grantRecord = next.sessions[id];
      if (!grantRecord) return false;
      next.revokedNonces[grantRecord.nonce] = {
        revokedAt: now(),
        reason: String(reason || "revoked").slice(0, 160),
      };
      delete next.sessions[id];
      const entries = Object.entries(next.revokedNonces).sort((a, b) => Number(b[1]?.revokedAt || 0) - Number(a[1]?.revokedAt || 0));
      next.revokedNonces = Object.fromEntries(entries.slice(0, MAX_REVOKED_NONCES));
      return true;
    });
  }

  function resolve(engineSessionId) {
    const id = String(engineSessionId || "").trim();
    if (!id) return "";
    const record = readState(registryPath).sessions[id];
    if (!record || Number(record.expiresAt || 0) <= now()) return "";
    return String(record.token || "");
  }

  function isRevoked(nonce) {
    return Boolean(readState(registryPath).revokedNonces[String(nonce || "")]);
  }

  function prune() {
    const state = readState(registryPath);
    const expired = Object.entries(state.sessions)
      .filter(([, value]) => Number(value?.expiresAt || 0) <= now())
      .map(([key]) => key);
    if (!expired.length) return 0;
    return update((next) => {
      for (const key of expired) delete next.sessions[key];
      return expired.length;
    });
  }

  return Object.freeze({ filePath: registryPath, grant, revoke, resolve, isRevoked, prune });
}

module.exports = { createRuntimeIdentityRegistry };
