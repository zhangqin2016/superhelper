#!/usr/bin/env node
/**
 * Small release helper for static Qiniu updates and offline activation codes.
 *
 * It intentionally uses qshell instead of embedding Qiniu credentials in this
 * app. Run `qshell account ...` once on the release machine, then this script
 * can upload installers and the signed latest.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function usage() {
  console.error(`usage:
  node scripts/release-admin.mjs keygen [--out release-keys]

  node scripts/release-admin.mjs license \\
    --key release-keys/license-private-key.pem \\
    --license-id LIC-2026-0001 \\
    --customer "Customer Name" \\
    --expires-at 2026-12-31T23:59:59Z \\
    [--plan pro] [--seats 10] [--features workspace,mcp]

  node scripts/release-admin.mjs publish \\
    --key release-keys/license-private-key.pem \\
    --bucket your-qiniu-bucket \\
    --domain https://cdn.example.com \\
    --version 0.2.0 \\
    --artifact darwin-arm64="dist/Lily Workbench-0.2.0-arm64.dmg" \\
    [--artifact darwin-x64="dist/Lily Workbench-0.2.0-x64.dmg"] \\
    [--artifact win32-x64="dist/Lily Workbench-0.2.0-x64.exe"] \\
    [--prefix app/updates] [--notes "release notes"] [--force] [--build mac|win|all] [--up-host https://upload.qiniup.com] [--upload] [--dry-run]

  node scripts/release-admin.mjs upload \\
    --bucket your-qiniu-bucket \\
    --key app/updates/latest.json \\
    --file release/latest.json \\
    [--up-host https://upload.qiniup.com] [--dry-run]
`);
  process.exit(1);
}

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

function args() {
  const out = { _: [] };
  const listKeys = new Set(["artifact"]);
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      out._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (["upload", "dry-run", "force"].includes(key)) {
      out[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) usage();
    i += 1;
    if (listKeys.has(key)) {
      out[key] = out[key] || [];
      out[key].push(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function fail(message) {
  console.error(`[release-admin] ${message}`);
  process.exit(1);
}

function ensureFile(filePath, label = "file") {
  const resolved = path.resolve(ROOT, filePath);
  if (!fs.existsSync(resolved)) fail(`${label} not found: ${filePath}`);
  return resolved;
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(value) {
  const text = String(value || "");
  const padded = `${text}${"=".repeat((4 - (text.length % 4)) % 4)}`;
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

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileSize(filePath) {
  return fs.statSync(filePath).size;
}

function normalizePrefix(prefix) {
  return String(prefix || "app/updates").replace(/^\/+|\/+$/g, "");
}

function joinUrl(base, key) {
  return `${String(base || "").replace(/\/+$/g, "")}/${String(key || "").replace(/^\/+/g, "")}`;
}

function uploadQiniu({ bucket, key, file, dryRun, upHost }) {
  const localFile = path.resolve(ROOT, file);
  if (!bucket || !key || !file) usage();
  if (!fs.existsSync(localFile)) fail(`upload file not found: ${file}`);
  const uploadFile = path.relative(ROOT, localFile).startsWith("..")
    ? localFile
    : path.relative(ROOT, localFile);

  const resolvedUpHost = upHost || process.env.QINIU_UP_HOST || "https://upload.qiniup.com";
  const command = ["qshell", "rput", bucket, key, uploadFile, "--overwrite", "--up-host", resolvedUpHost];
  console.log(`[release-admin] upload: ${command.map(shellQuote).join(" ")}`);
  if (dryRun) return;

  let result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  if (result.status === 0) return;

  const legacy = ["qshell", "rput", bucket, key, uploadFile, "true"];
  console.log(`[release-admin] retry legacy qshell syntax: ${legacy.map(shellQuote).join(" ")}`);
  result = spawnSync(legacy[0], legacy.slice(1), { stdio: "inherit" });
  if (result.status !== 0) fail(`qshell upload failed for ${key}`);
}

function runBuild(target) {
  const scripts = {
    mac: "dist:mac",
    win: "dist:win",
    all: "dist:all",
  };
  const script = scripts[target];
  if (!script) fail(`invalid --build value: ${target}. expected mac, win, or all`);
  console.log(`[release-admin] build: npm run ${script}`);
  const result = spawnSync("npm", ["run", script], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) fail(`npm run ${script} failed`);
}

function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : JSON.stringify(s);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function signJson(payload, privateKeyPem) {
  const signature = crypto.sign(
    null,
    Buffer.from(stableStringify(payload)),
    crypto.createPrivateKey(privateKeyPem),
  );
  return b64url(signature);
}

function generateKeyPair(outDir) {
  const dir = path.resolve(ROOT, outDir || "release-keys");
  fs.mkdirSync(dir, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.writeFileSync(path.join(dir, "license-public-key.pem"), publicKey, "utf8");
  fs.writeFileSync(path.join(dir, "license-private-key.pem"), privateKey, { mode: 0o600 });
  console.log(`[release-admin] public key: ${path.join(dir, "license-public-key.pem")}`);
  console.log(`[release-admin] private key: ${path.join(dir, "license-private-key.pem")}`);
  console.log("[release-admin] copy the public key to resources/license-public-key.pem before packaging");
}

function generateLicense(options) {
  const keyPath = options.key && ensureFile(options.key, "private key");
  const licenseId = options["license-id"];
  const customer = options.customer;
  const expiresAt = options["expires-at"];
  if (!keyPath || !licenseId || !customer || !expiresAt) usage();

  const payload = {
    licenseId,
    customer,
    plan: options.plan || "standard",
    issuedAt: new Date().toISOString(),
    expiresAt,
    seats: Number(options.seats || "1") || 1,
    features: String(options.features || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };

  const payloadPart = b64url(JSON.stringify(payload));
  const signature = crypto.sign(
    null,
    Buffer.from(payloadPart),
    crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8")),
  );
  console.log(`${payloadPart}.${b64url(signature)}`);
}

function parseArtifacts(artifacts) {
  const result = {};
  for (const entry of artifacts || []) {
    const eq = entry.indexOf("=");
    if (eq <= 0) fail(`invalid artifact: ${entry}. expected platform=path`);
    const platform = entry.slice(0, eq).trim();
    const file = entry.slice(eq + 1).trim();
    result[platform] = ensureFile(file, `artifact ${platform}`);
  }
  if (!Object.keys(result).length) fail("at least one --artifact platform=file is required");
  return result;
}

function readVerifiedBaseManifest(file, version, privateKeyPem) {
  if (!file) return {};
  const filePath = ensureFile(file, "base manifest");
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const { signature, ...unsigned } = manifest;
  if (String(unsigned.version || "") !== String(version || "")) {
    fail(`base manifest version mismatch: expected ${version}, got ${unsigned.version || "<empty>"}`);
  }
  const verified = crypto.verify(
    null,
    Buffer.from(stableStringify(unsigned)),
    crypto.createPublicKey(privateKeyPem),
    b64urlDecode(signature),
  );
  if (!verified) fail("base manifest signature is invalid");

  const platforms = {};
  for (const [platform, entry] of Object.entries(unsigned.platforms || {})) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.url === "string" &&
      /^[a-f0-9]{64}$/i.test(String(entry.sha256 || "")) &&
      Number.isFinite(Number(entry.size)) &&
      Number(entry.size) > 0
    ) {
      platforms[platform] = {
        url: entry.url,
        sha256: String(entry.sha256).toLowerCase(),
        size: Number(entry.size),
      };
    }
  }
  return platforms;
}

function publish(options) {
  const privateKeyPath = options.key && ensureFile(options.key, "private key");
  const bucket = options.bucket;
  const domain = options.domain;
  const version = options.version || readPkg().version;
  if (!privateKeyPath || !bucket || !domain || !version) usage();

  if (options.build) runBuild(options.build);

  const prefix = normalizePrefix(options.prefix);
  const artifacts = parseArtifacts(options.artifact);
  const privateKeyPem = fs.readFileSync(privateKeyPath, "utf8");
  const platforms = readVerifiedBaseManifest(options["base-manifest"], version, privateKeyPem);
  const uploads = [];

  for (const [platform, filePath] of Object.entries(artifacts)) {
    const ext = path.extname(filePath) || ".bin";
    const objectKey = `${prefix}/${platform}/${version}/${path.basename(filePath)}`;
    platforms[platform] = {
      url: joinUrl(domain, objectKey),
      sha256: sha256(filePath),
      size: fileSize(filePath),
    };
    uploads.push({ bucket, key: objectKey, file: filePath });
  }

  const unsigned = {
    version,
    force: Boolean(options.force),
    notes: options.notes || "",
    platforms,
  };
  const signed = {
    ...unsigned,
    signature: signJson(unsigned, privateKeyPem),
  };

  const releaseDir = path.join(ROOT, "release", version);
  const unsignedPath = path.join(releaseDir, "latest.unsigned.json");
  const signedPath = path.join(releaseDir, "latest.json");
  writeJson(unsignedPath, unsigned);
  writeJson(signedPath, signed);
  console.log(`[release-admin] wrote ${path.relative(ROOT, unsignedPath)}`);
  console.log(`[release-admin] wrote ${path.relative(ROOT, signedPath)}`);
  console.log(`[release-admin] manifest url: ${joinUrl(domain, `${prefix}/latest.json`)}`);

  uploads.push({ bucket, key: `${prefix}/latest.json`, file: signedPath });

  if (options.upload || options["dry-run"]) {
    for (const item of uploads) {
      uploadQiniu({ ...item, dryRun: Boolean(options["dry-run"]), upHost: options["up-host"] });
    }
  } else {
    console.log("[release-admin] upload skipped. Add --upload to publish to Qiniu.");
    const resolvedUpHost = options["up-host"] || process.env.QINIU_UP_HOST || "https://upload.qiniup.com";
    for (const item of uploads) {
      console.log(
        `  qshell rput ${shellQuote(item.bucket)} ${shellQuote(item.key)} ${shellQuote(item.file)} --overwrite --up-host ${shellQuote(resolvedUpHost)}`,
      );
    }
  }
}

const options = args();
const command = options._[0];

if (command === "keygen") {
  generateKeyPair(options.out);
} else if (command === "license") {
  generateLicense(options);
} else if (command === "publish") {
  publish(options);
} else if (command === "upload") {
  uploadQiniu({
    bucket: options.bucket,
    key: options.key,
    file: options.file,
    dryRun: Boolean(options["dry-run"]),
    upHost: options["up-host"],
  });
} else {
  usage();
}
