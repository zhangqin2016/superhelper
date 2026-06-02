"use strict";

const crypto = require("node:crypto");

function stableStringify(value) {
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

function verifyDetached(payload, signature, publicKeyPem) {
  if (!publicKeyPem || !signature) return false;
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

function signDetached(payload, privateKeyPem) {
  const sig = crypto.sign(
    null,
    Buffer.from(stableStringify(payload)),
    crypto.createPrivateKey(privateKeyPem),
  );
  return base64urlEncode(sig);
}

module.exports = {
  stableStringify,
  base64urlEncode,
  base64urlDecode,
  verifyDetached,
  signDetached,
};
