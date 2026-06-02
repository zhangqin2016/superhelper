#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";

function usage() {
  console.error("usage: node scripts/sign-update-manifest.mjs --key private.pem --in latest.unsigned.json --out latest.json");
  process.exit(1);
}

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] || "" : "";
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const keyPath = arg("key");
const inPath = arg("in");
const outPath = arg("out");
if (!keyPath || !inPath || !outPath) usage();

const manifest = JSON.parse(fs.readFileSync(inPath, "utf8"));
delete manifest.signature;
const sig = crypto.sign(
  null,
  Buffer.from(stableStringify(manifest)),
  crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8")),
);
const signed = { ...manifest, signature: b64url(sig) };
fs.writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`, "utf8");
console.log(`wrote ${outPath}`);
