"use strict";

const crypto = require("node:crypto");

const TOKEN_VERSION = 1;
const REQUIRED_SCOPE_KEYS = ["ownerScope", "sessionId", "projectId", "turnId"];
const OPERATION_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function secretBytes(secret) {
  let bytes;
  try {
    bytes = Buffer.from(String(secret || ""), "base64url");
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (bytes.length < 32) throw new TypeError("scope token secret must contain at least 32 bytes");
  return bytes;
}

function boundedText(value, name, limit = 160) {
  const text = String(value || "").trim();
  if (!text || Buffer.byteLength(text, "utf8") > limit) throw new TypeError(`invalid scope ${name}`);
  return text;
}

function normalizeScope(scope) {
  const out = {};
  for (const key of REQUIRED_SCOPE_KEYS) out[key] = boundedText(scope?.[key], key);
  return Object.freeze(out);
}

function normalizeOperations(operations) {
  const list = [...new Set((Array.isArray(operations) ? operations : []).map((item) => String(item || "").trim()))];
  if (!list.length || list.length > 16 || list.some((item) => !OPERATION_RE.test(item))) {
    throw new TypeError("scope token operations are invalid");
  }
  return list.sort();
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signature(bytes, body) {
  return crypto.createHmac("sha256", bytes).update(body).digest();
}

function decodeCanonical(value) {
  const bytes = Buffer.from(String(value || ""), "base64url");
  if (!value || bytes.toString("base64url") !== value) throw new Error("non-canonical base64url");
  return bytes;
}

function issueScopeToken({ secret, scope, operations, ttlMs = 30 * 60_000, now = Date.now } = {}) {
  const bytes = secretBytes(secret);
  const issuedAt = Number(now());
  const ttl = Math.max(1_000, Math.min(Number(ttlMs) || 0, 7 * 24 * 60 * 60_000));
  const payload = {
    v: TOKEN_VERSION,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + ttl,
    scope: normalizeScope(scope),
    ops: normalizeOperations(operations),
  };
  const body = encode(payload);
  return `${body}.${signature(bytes, body).toString("base64url")}`;
}

function failure(error) {
  return Object.freeze({ ok: false, error });
}

function verifyScopeToken(token, { secret, operation, now = Date.now } = {}) {
  let bytes;
  try {
    bytes = secretBytes(secret);
  } catch {
    return failure("INVALID_SCOPE_TOKEN");
  }
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return failure("INVALID_SCOPE_TOKEN");
  let provided;
  try {
    decodeCanonical(parts[0]);
    provided = decodeCanonical(parts[1]);
  } catch {
    return failure("INVALID_SCOPE_TOKEN");
  }
  const expected = signature(bytes, parts[0]);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return failure("INVALID_SCOPE_TOKEN");
  }
  let payload;
  try {
    payload = JSON.parse(decodeCanonical(parts[0]).toString("utf8"));
  } catch {
    return failure("INVALID_SCOPE_TOKEN");
  }
  if (payload?.v !== TOKEN_VERSION || !Array.isArray(payload.ops)) return failure("INVALID_SCOPE_TOKEN");
  let scope;
  try {
    scope = normalizeScope(payload.scope);
  } catch {
    return failure("INVALID_SCOPE_TOKEN");
  }
  const current = Number(now());
  if (!Number.isFinite(payload.exp) || current > payload.exp) return failure("SCOPE_TOKEN_EXPIRED");
  if (!Number.isFinite(payload.iat) || payload.iat > current + 60_000) return failure("INVALID_SCOPE_TOKEN");
  if (!payload.ops.includes(String(operation || ""))) return failure("SCOPE_OPERATION_FORBIDDEN");
  return Object.freeze({
    ok: true,
    scope,
    tokenId: String(payload.jti || ""),
    expiresAt: payload.exp,
    operations: Object.freeze([...payload.ops]),
  });
}

module.exports = { issueScopeToken, normalizeScope, verifyScopeToken };
