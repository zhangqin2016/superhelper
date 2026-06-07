import crypto from "node:crypto";
import { config } from "../config.js";

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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
