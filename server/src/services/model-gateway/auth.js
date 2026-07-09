import crypto from "node:crypto";
import { config } from "../../config.js";
import { stableStringify, timingSafeEqualText } from "../security.js";
import { base64urlDecodeText, base64urlEncode } from "./utils.js";

const GATEWAY_TOKEN_PREFIX = "lilygw";

function hmac(payload) {
  return base64urlEncode(crypto.createHmac("sha256", config.modelGatewayTokenSecret).update(payload).digest());
}

export function signModelGatewayToken({
  deviceId,
  licenseId = "",
  providerId = "",
  userId = "",
  sessionId = "",
  trialEndsAt = "",
  expiresAt = "",
}) {
  const ttlMs = Math.max(60, config.modelGatewayTokenTtlSeconds || 3600) * 1000;
  const payload = {
    deviceId: String(deviceId || ""),
    licenseId: String(licenseId || ""),
    providerId: String(providerId || ""),
    userId: String(userId || ""),
    sessionId: String(sessionId || ""),
    // Server-issued free-trial expiry for un-logged-in / unlicensed devices. The
    // gateway honors it (tokenTrialActive) so the configured trial actually
    // grants model access instead of being display-only.
    trialEndsAt: String(trialEndsAt || ""),
    expiresAt: expiresAt || new Date(Date.now() + ttlMs).toISOString(),
  };
  const encoded = base64urlEncode(stableStringify(payload));
  return `${GATEWAY_TOKEN_PREFIX}.${encoded}.${hmac(encoded)}`;
}

export function verifyModelGatewayToken(token, providerId = "") {
  const value = String(token || "").trim();
  if (config.modelGatewayClientToken && timingSafeEqualText(value, config.modelGatewayClientToken)) {
    return { ok: true, static: true, providerId };
  }
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== GATEWAY_TOKEN_PREFIX) return { ok: false, code: "MODEL_GATEWAY_TOKEN_INVALID" };
  const [, encoded, signature] = parts;
  if (!timingSafeEqualText(signature, hmac(encoded))) return { ok: false, code: "MODEL_GATEWAY_TOKEN_INVALID" };
  let payload;
  try {
    payload = JSON.parse(base64urlDecodeText(encoded));
  } catch {
    return { ok: false, code: "MODEL_GATEWAY_TOKEN_INVALID" };
  }
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    const graceMs = Math.max(0, Number(config.modelGatewayExpiredTokenGraceSeconds) || 0) * 1000;
    if (!Number.isFinite(expiresAt) || !graceMs || expiresAt + graceMs <= Date.now()) {
      return { ok: false, code: "MODEL_GATEWAY_TOKEN_EXPIRED" };
    }
    if (payload.providerId && providerId && payload.providerId !== providerId) {
      return { ok: false, code: "MODEL_GATEWAY_PROVIDER_MISMATCH" };
    }
    return { ok: true, ...payload, expiredGrace: true };
  }
  if (payload.providerId && providerId && payload.providerId !== providerId) {
    return { ok: false, code: "MODEL_GATEWAY_PROVIDER_MISMATCH" };
  }
  return { ok: true, ...payload };
}
