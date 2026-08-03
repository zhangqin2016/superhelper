"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN_PREFIX = "lilyri1";
const SCHEMA_VERSION = 1;
const MAX_FIELD_CHARS = 256;
const MAX_CAPABILITIES = 64;
const MIN_SECRET_BYTES = 32;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

let processSecret = "";

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function requireSecret(secret) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ""));
  if (value.length < MIN_SECRET_BYTES) {
    throw codedError("RUNTIME_IDENTITY_SECRET_INVALID", "secret must contain at least 32 bytes");
  }
  return value;
}

function boundedString(value, name, { required = true, max = MAX_FIELD_CHARS } = {}) {
  const text = String(value || "").trim();
  if ((required && !text) || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw codedError("RUNTIME_IDENTITY_FIELD_INVALID", `${name} is invalid`);
  }
  return text;
}

function normalizeCapabilities(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw codedError("RUNTIME_IDENTITY_FIELD_INVALID", "capabilities are invalid");
  }
  return [...new Set(value.map((item) => boundedString(item, "capability", { max: 120 })))].sort();
}

function normalizeIdentity(input = {}, options = {}) {
  const now = Number.isFinite(options.now) ? Math.floor(options.now) : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.floor(options.ttlMs) : DEFAULT_TTL_MS;
  if (ttlMs < 1_000 || ttlMs > 7 * 24 * 60 * 60 * 1_000) {
    throw codedError("RUNTIME_IDENTITY_FIELD_INVALID", "ttlMs is outside the allowed range");
  }
  const issuedAt = Number.isFinite(input.issuedAt) ? Math.floor(input.issuedAt) : now;
  const expiresAt = Number.isFinite(input.expiresAt) ? Math.floor(input.expiresAt) : issuedAt + ttlMs;
  if (expiresAt <= issuedAt) {
    throw codedError("RUNTIME_IDENTITY_FIELD_INVALID", "expiresAt must follow issuedAt");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    audience: boundedString(options.audience || input.audience, "audience", { max: 80 }),
    principalId: boundedString(input.principalId, "principalId"),
    workspaceId: boundedString(input.workspaceId, "workspaceId"),
    projectId: boundedString(input.projectId, "projectId"),
    sessionId: boundedString(input.sessionId, "sessionId"),
    turnId: boundedString(input.turnId, "turnId"),
    taskRunId: boundedString(input.taskRunId || "task:none", "taskRunId"),
    agentId: boundedString(input.agentId || "lead", "agentId"),
    attemptId: boundedString(input.attemptId, "attemptId"),
    issuedAt,
    expiresAt,
    nonce: boundedString(options.nonce || input.nonce || crypto.randomUUID(), "nonce"),
    capabilities: normalizeCapabilities(input.capabilities),
    activeSkillIds: normalizeCapabilities(input.activeSkillIds),
    workspacePath: boundedString(input.workspacePath || "workspace:none", "workspacePath", { max: 2_048 }),
    permissionMode: boundedString(input.permissionMode || "ask", "permissionMode", { max: 40 }),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function signatureFor(payloadPart, secret) {
  return crypto.createHmac("sha256", requireSecret(secret)).update(`${TOKEN_PREFIX}.${payloadPart}`).digest("base64url");
}

function issueRuntimeIdentity(input, options = {}) {
  const identity = normalizeIdentity(input, options);
  const payloadPart = Buffer.from(canonicalJson(identity)).toString("base64url");
  return `${TOKEN_PREFIX}.${payloadPart}.${signatureFor(payloadPart, options.secret)}`;
}

function safeSignatureEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function deepFreeze(identity) {
  if (Array.isArray(identity.capabilities)) Object.freeze(identity.capabilities);
  if (Array.isArray(identity.activeSkillIds)) Object.freeze(identity.activeSkillIds);
  return Object.freeze(identity);
}

function verifyRuntimeIdentity(token, options = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw codedError("RUNTIME_IDENTITY_MALFORMED");
  }
  const expectedSignature = signatureFor(parts[1], options.secret);
  if (!safeSignatureEqual(parts[2], expectedSignature)) {
    throw codedError("RUNTIME_IDENTITY_INVALID_SIGNATURE");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw codedError("RUNTIME_IDENTITY_MALFORMED");
  }
  if (parsed?.schemaVersion !== SCHEMA_VERSION) {
    throw codedError("RUNTIME_IDENTITY_VERSION_UNSUPPORTED");
  }
  const identity = normalizeIdentity(parsed, {
    audience: parsed.audience,
    now: parsed.issuedAt,
    ttlMs: parsed.expiresAt - parsed.issuedAt,
    nonce: parsed.nonce,
  });
  if (canonicalJson(identity) !== canonicalJson(parsed)) {
    throw codedError("RUNTIME_IDENTITY_MALFORMED", "payload is not canonical");
  }
  const expectedAudience = boundedString(options.audience, "audience", { max: 80 });
  if (identity.audience !== expectedAudience) {
    throw codedError("RUNTIME_IDENTITY_AUDIENCE_MISMATCH");
  }
  const now = Number.isFinite(options.now) ? Math.floor(options.now) : Date.now();
  if (now >= identity.expiresAt) throw codedError("RUNTIME_IDENTITY_EXPIRED");
  if (now + 60_000 < identity.issuedAt) throw codedError("RUNTIME_IDENTITY_NOT_YET_VALID");
  for (const [key, value] of Object.entries(options.expected || {})) {
    if (value != null && String(identity[key] || "") !== String(value)) {
      throw codedError("RUNTIME_IDENTITY_SCOPE_MISMATCH", key);
    }
  }
  if (typeof options.isRevoked === "function" && options.isRevoked(identity)) {
    throw codedError("RUNTIME_IDENTITY_REVOKED");
  }
  return deepFreeze(identity);
}

function redactRuntimeIdentity(identity = {}) {
  return {
    schemaVersion: identity.schemaVersion || SCHEMA_VERSION,
    audience: String(identity.audience || ""),
    principalId: String(identity.principalId || ""),
    workspaceId: String(identity.workspaceId || ""),
    projectId: String(identity.projectId || ""),
    sessionId: String(identity.sessionId || ""),
    turnId: String(identity.turnId || ""),
    taskRunId: String(identity.taskRunId || ""),
    agentId: String(identity.agentId || ""),
    attemptId: String(identity.attemptId || ""),
    nonce: String(identity.nonce || ""),
    issuedAt: Number(identity.issuedAt || 0),
    expiresAt: Number(identity.expiresAt || 0),
    capabilities: Array.isArray(identity.capabilities) ? [...identity.capabilities] : [],
  };
}

function runtimeIdentityProcessSecret() {
  if (!processSecret) processSecret = runtimeIdentityInstallSecret();
  return processSecret;
}

function runtimeIdentityInstallSecret(options = {}) {
  const filePath = options.filePath || require("./config").userDataPath("runtime-identity.secret");
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (Buffer.from(existing, "base64url").length >= MIN_SECRET_BYTES) return existing;
  } catch { /* create below */ }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const generated = crypto.randomBytes(48).toString("base64url");
  try {
    fs.writeFileSync(filePath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return generated;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const raced = fs.readFileSync(filePath, "utf8").trim();
    if (Buffer.from(raced, "base64url").length < MIN_SECRET_BYTES) throw codedError("RUNTIME_IDENTITY_SECRET_INVALID");
    return raced;
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  issueRuntimeIdentity,
  redactRuntimeIdentity,
  runtimeIdentityInstallSecret,
  runtimeIdentityProcessSecret,
  verifyRuntimeIdentity,
};
