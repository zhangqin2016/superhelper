#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-release-admin-"));
const keyDir = path.join(tmp, "keys");
const artifact = path.join(tmp, "app.dmg");
const winArtifact = path.join(tmp, "app.exe");

function run(args) {
  const result = spawnSync(process.execPath, ["scripts/release-admin.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`release-admin failed: ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

function b64urlDecode(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
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

run(["keygen", "--out", keyDir]);
const publicKey = fs.readFileSync(path.join(keyDir, "license-public-key.pem"), "utf8");
const privateKey = path.join(keyDir, "license-private-key.pem");

const license = run([
  "license",
  "--key",
  privateKey,
  "--license-id",
  "LIC-TEST",
  "--customer",
  "ACME",
  "--expires-at",
  "2027-01-01T00:00:00Z",
]).stdout.trim();

const [payloadPart, sigPart] = license.split(".");
if (!payloadPart || !sigPart) throw new Error("license output should be token.token");
const licenseOk = crypto.verify(
  null,
  Buffer.from(payloadPart),
  crypto.createPublicKey(publicKey),
  b64urlDecode(sigPart),
);
if (!licenseOk) throw new Error("license signature should verify");

fs.writeFileSync(artifact, "fake dmg bytes", "utf8");
run([
  "publish",
  "--key",
  privateKey,
  "--bucket",
  "test-bucket",
  "--domain",
  "https://cdn.example.com",
  "--version",
  "9.9.9",
  "--artifact",
  `darwin-arm64=${artifact}`,
  "--dry-run",
]);

const manifestPath = path.join(ROOT, "release", "9.9.9", "latest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const signature = manifest.signature;
delete manifest.signature;
const manifestOk = crypto.verify(
  null,
  Buffer.from(stableStringify(manifest)),
  crypto.createPublicKey(publicKey),
  b64urlDecode(signature),
);
if (!manifestOk) throw new Error("manifest signature should verify");

fs.writeFileSync(winArtifact, "fake exe bytes", "utf8");
run([
  "publish",
  "--key",
  privateKey,
  "--bucket",
  "test-bucket",
  "--domain",
  "https://cdn.example.com",
  "--version",
  "9.9.9",
  "--base-manifest",
  manifestPath,
  "--artifact",
  `win32-x64=${winArtifact}`,
  "--dry-run",
]);
const mergedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!mergedManifest.platforms?.["darwin-arm64"]) {
  throw new Error("single-platform publish must preserve a verified existing platform");
}
if (!mergedManifest.platforms?.["win32-x64"]) {
  throw new Error("single-platform publish must add the new platform");
}
const mergedSignature = mergedManifest.signature;
delete mergedManifest.signature;
if (!crypto.verify(
  null,
  Buffer.from(stableStringify(mergedManifest)),
  crypto.createPublicKey(publicKey),
  b64urlDecode(mergedSignature),
)) {
  throw new Error("merged manifest signature should verify");
}

fs.rmSync(path.join(ROOT, "release", "9.9.9"), { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });

console.log("release-admin: ok");
