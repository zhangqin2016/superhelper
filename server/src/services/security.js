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
