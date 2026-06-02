#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

function usage() {
  console.error("usage: node scripts/generate-license.mjs --key private.pem --license-id LIC-001 --customer ACME --expires-at 2026-12-31 [--plan pro] [--seats 10] [--features workspace,mcp]");
  process.exit(1);
}

function arg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] || "" : fallback;
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const keyPath = arg("key");
const licenseId = arg("license-id");
const customer = arg("customer");
const expiresAt = arg("expires-at");
if (!keyPath || !licenseId || !customer || !expiresAt) usage();

const payload = {
  licenseId,
  customer,
  plan: arg("plan", "standard"),
  issuedAt: new Date().toISOString(),
  expiresAt,
  seats: Number(arg("seats", "1")) || 1,
  features: arg("features", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8"));
const payloadPart = b64url(JSON.stringify(payload));
const signature = crypto.sign(null, Buffer.from(payloadPart), privateKey);
console.log(`${payloadPart}.${b64url(signature)}`);
