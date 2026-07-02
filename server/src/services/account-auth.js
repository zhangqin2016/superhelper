import crypto from "node:crypto";
import { config } from "../config.js";

const ACCESS_PREFIX = "lily_access_";
const REFRESH_PREFIX = "lily_refresh_";
const WEB_SESSION_PREFIX = "lily_user_";
const ACCESS_VERSION = "v1";
const WEB_SESSION_VERSION = "v1";

function base64urlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(input) {
  const value = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = value.length % 4 ? "=".repeat(4 - (value.length % 4)) : "";
  return Buffer.from(value + pad, "base64");
}

function hmacHex(value, secret = config.sessionSecret) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

function tokenPepper() {
  return process.env.USER_TOKEN_PEPPER || config.sessionSecret;
}

function smsPepper() {
  return process.env.SMS_CODE_PEPPER || config.sessionSecret;
}

export function normalizePhoneE164(value, defaultCountryCode = "+86") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const compact = raw.replace(/[\s()-]/g, "");
  if (/^\+861[3-9]\d{9}$/.test(compact)) return compact;
  if (/^1[3-9]\d{9}$/.test(compact) && defaultCountryCode === "+86") return `+86${compact}`;
  return "";
}

export function hashSmsCode(phoneE164, code) {
  return hmacHex(`${String(phoneE164 || "").trim()}:${String(code || "").trim()}`, smsPepper());
}

export function verifySmsCodeHash(phoneE164, code, expectedHash) {
  const expected = Buffer.from(String(expectedHash || ""));
  const actual = Buffer.from(hashSmsCode(phoneE164, code));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function createRefreshToken() {
  return `${REFRESH_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashRefreshToken(token) {
  return hmacHex(String(token || ""), tokenPepper());
}

export function createAccessToken({
  userId,
  sessionId,
  deviceId,
  scopes = ["account"],
  nowMs = Date.now(),
  ttlSeconds = 15 * 60,
} = {}) {
  const payload = {
    typ: "access",
    sub: String(userId || ""),
    sid: String(sessionId || ""),
    did: String(deviceId || ""),
    scope: Array.isArray(scopes) ? scopes.map(String) : ["account"],
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + Number(ttlSeconds || 0),
  };
  const body = `${ACCESS_VERSION}.${base64urlEncode(JSON.stringify(payload))}`;
  return `${ACCESS_PREFIX}${body}.${hmacHex(body)}`;
}

export function verifyAccessToken(token, { nowMs = Date.now() } = {}) {
  const text = String(token || "");
  if (!text.startsWith(ACCESS_PREFIX)) return { ok: false, code: "ACCESS_TOKEN_INVALID" };
  const value = text.slice(ACCESS_PREFIX.length);
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== ACCESS_VERSION) return { ok: false, code: "ACCESS_TOKEN_INVALID" };
  const body = `${parts[0]}.${parts[1]}`;
  const actual = Buffer.from(parts[2]);
  const expected = Buffer.from(hmacHex(body));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, code: "ACCESS_TOKEN_INVALID" };
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, code: "ACCESS_TOKEN_INVALID" };
  }
  if (payload?.typ !== "access") return { ok: false, code: "ACCESS_TOKEN_INVALID" };
  if (Number(payload.exp || 0) <= Math.floor(nowMs / 1000)) {
    return { ok: false, code: "ACCESS_TOKEN_EXPIRED" };
  }
  return {
    ok: true,
    userId: String(payload.sub || ""),
    sessionId: String(payload.sid || ""),
    deviceId: String(payload.did || ""),
    scopes: Array.isArray(payload.scope) ? payload.scope.map(String) : [],
    expiresAt: new Date(Number(payload.exp || 0) * 1000).toISOString(),
  };
}

export function createWebSessionToken({
  userId,
  sessionId,
  nowMs = Date.now(),
  ttlSeconds = 7 * 24 * 60 * 60,
} = {}) {
  const payload = {
    typ: "web_session",
    sub: String(userId || ""),
    sid: String(sessionId || ""),
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + Number(ttlSeconds || 0),
  };
  const body = `${WEB_SESSION_VERSION}.${base64urlEncode(JSON.stringify(payload))}`;
  return `${WEB_SESSION_PREFIX}${body}.${hmacHex(body)}`;
}

export function verifyWebSessionToken(token, { nowMs = Date.now() } = {}) {
  const text = String(token || "");
  if (!text.startsWith(WEB_SESSION_PREFIX)) return { ok: false, code: "WEB_SESSION_INVALID" };
  const value = text.slice(WEB_SESSION_PREFIX.length);
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== WEB_SESSION_VERSION) return { ok: false, code: "WEB_SESSION_INVALID" };
  const body = `${parts[0]}.${parts[1]}`;
  const actual = Buffer.from(parts[2]);
  const expected = Buffer.from(hmacHex(body));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { ok: false, code: "WEB_SESSION_INVALID" };
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, code: "WEB_SESSION_INVALID" };
  }
  if (payload?.typ !== "web_session") return { ok: false, code: "WEB_SESSION_INVALID" };
  if (Number(payload.exp || 0) <= Math.floor(nowMs / 1000)) {
    return { ok: false, code: "WEB_SESSION_EXPIRED" };
  }
  return {
    ok: true,
    userId: String(payload.sub || ""),
    sessionId: String(payload.sid || ""),
  };
}

export function evaluateSmsRisk({
  phoneRecentCount = 0,
  ipRecentCount = 0,
  deviceRecentCount = 0,
  prefixRecentCount = 0,
  hasActiveCode = false,
} = {}) {
  if (hasActiveCode) return { level: "low", action: "cooldown", reason: "ACTIVE_CODE" };
  if (phoneRecentCount >= 10 || ipRecentCount >= 100 || deviceRecentCount >= 30 || prefixRecentCount >= 120) {
    return { level: "high", action: "blocked", reason: "RATE_LIMIT_HIGH" };
  }
  if (phoneRecentCount >= 4 || ipRecentCount >= 20 || deviceRecentCount >= 7 || prefixRecentCount >= 40) {
    return { level: "medium", action: "captcha_required", reason: "RATE_LIMIT_MEDIUM" };
  }
  return { level: "low", action: "send", reason: "" };
}
