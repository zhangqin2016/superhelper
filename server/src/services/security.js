import crypto from "node:crypto";
import { config } from "../config.js";

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Symmetric encryption for secrets stored at rest (e.g. model-provider API keys
// in the DB). Key is derived from SESSION_SECRET so no new required env is
// introduced; rotating SESSION_SECRET invalidates stored ciphertexts.
const SECRET_ENC_PREFIX = "gcm1:";

function dataEncryptionKey() {
  return crypto.createHash("sha256").update(`provider-secret::${config.sessionSecret}`).digest();
}

export function encryptSecret(plain) {
  const text = String(plain ?? "");
  if (!text) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataEncryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return SECRET_ENC_PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(blob) {
  const text = String(blob || "");
  if (!text) return "";
  // Tolerate legacy/plaintext values that predate encryption.
  if (!text.startsWith(SECRET_ENC_PREFIX)) return text;
  try {
    const raw = Buffer.from(text.slice(SECRET_ENC_PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function hashLicenseKey(key) {
  return sha256(String(key || "").trim().toUpperCase());
}

export function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

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

export function verifyDetachedPayload(payload, signature, publicKeyPem) {
  if (!signature || !publicKeyPem) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(stableStringify(payload)),
      crypto.createPublicKey(publicKeyPem),
      base64urlDecode(signature),
    );
  } catch {
    return false;
  }
}

export function signLicensePayload(payload) {
  const body = JSON.stringify(payload);
  if (!config.licensePrivateKey) {
    if (!config.allowUnsignedLicenses) {
      throw new Error("LICENSE_PRIVATE_KEY is required");
    }
    return `dev.${sha256(body)}`;
  }
  const signature = crypto.sign(null, Buffer.from(body), config.licensePrivateKey);
  return signature.toString("base64");
}

export function signConfigPayload(payload) {
  const body = stableStringify(payload);
  if (!config.configSigningPrivateKey) {
    if (!config.allowUnsignedLicenses) {
      throw new Error("CONFIG_SIGNING_PRIVATE_KEY is required");
    }
    return `dev.${sha256(body)}`;
  }
  const signature = crypto.sign(null, Buffer.from(body), config.configSigningPrivateKey);
  return base64urlEncode(signature);
}

// --- Admin session tokens -------------------------------------------------
// The admin cookie used to BE the session secret, so leaking one cookie was
// equivalent to leaking the signing secret for everyone, forever. Tokens are
// now per-login HMAC-signed values with an expiry: v1.<expires>.<nonce>.<mac>.
// Stateless by design (single-admin self-hosted deployment) — rotation of
// SESSION_SECRET still invalidates all outstanding sessions.

const ADMIN_SESSION_VERSION = "v1";

export function createAdminSessionToken(ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const expiresAt = Date.now() + ttlMs;
  const nonce = crypto.randomBytes(16).toString("hex");
  const body = `${ADMIN_SESSION_VERSION}.${expiresAt}.${nonce}`;
  const mac = crypto.createHmac("sha256", config.sessionSecret).update(body).digest("hex");
  return `${body}.${mac}`;
}

export function verifyAdminSessionToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== ADMIN_SESSION_VERSION) return false;
  const [version, expiresAt, nonce, mac] = parts;
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;
  const body = `${version}.${expiresAt}.${nonce}`;
  const expected = crypto.createHmac("sha256", config.sessionSecret).update(body).digest("hex");
  return timingSafeEqualText(mac, expected);
}
