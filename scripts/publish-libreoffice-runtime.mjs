#!/usr/bin/env node
/**
 * Build and publish LibreOffice runtime packs.
 *
 * Full desktop installers bundle LibreOffice. This script publishes a repair or
 * upgrade runtime pack from an already-built runtime/libreoffice directory,
 * uploads the zip + latest.json to Qiniu, and optionally registers the artifact
 * with the Lily server so clients can repair missing packs without app reinstall.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DOMAIN = "https://qny.lanrensoft.cn";
const DEFAULT_BUCKET = "lanrensoft";
const DEFAULT_PREFIX = "app/runtime";
const DEFAULT_API = "https://lilych.lilywb.cn";

function usage() {
  console.error(`usage:
  node scripts/publish-libreoffice-runtime.mjs \\
    --platform darwin-arm64 \\
    --version 25.8.7 \\
    [--source bundles/darwin-arm64/runtime/libreoffice] \\
    [--bucket lanrensoft] [--domain https://qny.lanrensoft.cn] [--prefix app/runtime] \\
    [--upload] [--register] [--api https://lilych.lilywb.cn] [--dry-run]

env for --register:
  RELEASE_ADMIN_TOKEN
  RELEASE_ADMIN_EMAIL
  RELEASE_ADMIN_PASSWORD
`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) usage();
    const key = item.slice(2);
    if (["upload", "register", "dry-run"].includes(key)) {
      out[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) usage();
    out[key] = value;
    i += 1;
  }
  return out;
}

function fail(message) {
  console.error(`[publish-libreoffice-runtime] ${message}`);
  process.exit(1);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function joinUrl(base, key) {
  return `${String(base).replace(/\/+$/g, "")}/${String(key).replace(/^\/+/g, "")}`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function commandExists(command) {
  return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function run(command, args, options = {}) {
  console.log(`[publish-libreoffice-runtime] ${[command, ...args].join(" ")}`);
  if (options.dryRun) return;
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} failed`);
}

function detectExecutable(platform) {
  if (platform === "win32-x64") return "program/soffice.exe";
  if (platform.startsWith("darwin-")) return "LibreOffice.app/Contents/MacOS/soffice";
  return "program/soffice";
}

function ensureSource(source, platform) {
  const sourceDir = path.resolve(ROOT, source);
  if (!fs.existsSync(sourceDir)) fail(`source not found: ${source}`);
  const executable = path.join(sourceDir, detectExecutable(platform));
  if (!fs.existsSync(executable)) fail(`LibreOffice executable not found: ${path.relative(ROOT, executable)}`);
  return sourceDir;
}

function makeZip({ sourceDir, outFile, dryRun }) {
  if (!commandExists("zip")) fail("zip command not found");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });
  run("zip", ["-qry", outFile, "."], { cwd: sourceDir, dryRun });
}

async function adminHeaders(api) {
  const token = process.env.RELEASE_ADMIN_TOKEN || "";
  if (token) return { Authorization: `Bearer ${token}` };

  const email = process.env.RELEASE_ADMIN_EMAIL || "";
  const password = process.env.RELEASE_ADMIN_PASSWORD || "";
  if (!email || !password) {
    fail("--register requires RELEASE_ADMIN_TOKEN or RELEASE_ADMIN_EMAIL + RELEASE_ADMIN_PASSWORD");
  }

  const loginResponse = await fetch(`${api}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await loginResponse.json().catch(() => ({}));
  if (!loginResponse.ok) fail(`admin login failed: ${loginResponse.status} ${json.code || ""}`);
  const cookie = loginResponse.headers.get("set-cookie") || "";
  const session = cookie.match(/(?:^|,\s*)lily_admin_session=([^;]+)/)?.[1];
  if (!session) fail("admin login did not return lily_admin_session cookie");
  return { Cookie: `lily_admin_session=${session}` };
}

async function registerPack({ api, artifact, dryRun }) {
  if (dryRun) {
    console.log("[publish-libreoffice-runtime] dry-run: skip server registration");
    return;
  }
  const headers = await adminHeaders(api);
  const listResponse = await fetch(`${api}/api/admin/runtime-packs`, { headers });
  const listJson = await listResponse.json().catch(() => ({}));
  if (!listResponse.ok) fail(`list runtime packs failed: ${listResponse.status}`);
  const existing = (listJson.runtimePacks || []).find(
    (pack) =>
      pack.pack_id === artifact.packId &&
      pack.platform === artifact.platform &&
      pack.version === artifact.version &&
      pack.sha256 === artifact.sha256,
  );
  if (existing) {
    console.log(`[publish-libreoffice-runtime] server registration already exists: ${existing.id}`);
    return;
  }

  const response = await fetch(`${api}/api/admin/runtime-packs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      packId: artifact.packId,
      platform: artifact.platform,
      version: artifact.version,
      url: artifact.url,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      enabled: true,
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) fail(`register runtime pack failed: ${response.status} ${json.code || ""}`);
  console.log(`[publish-libreoffice-runtime] registered runtime pack: ${json.id}`);
}

const options = parseArgs(process.argv.slice(2));
const platform = options.platform || fail("missing --platform");
const version = options.version || fail("missing --version");
const bucket = options.bucket || DEFAULT_BUCKET;
const domain = options.domain || DEFAULT_DOMAIN;
const prefix = String(options.prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");
const api = String(options.api || DEFAULT_API).replace(/\/+$/g, "");
const source = options.source || path.join("bundles", platform, "runtime", "libreoffice");
const sourceDir = ensureSource(source, platform);

const outDir = path.join(ROOT, "release", "runtime", platform, version);
const zipName = `libreoffice-${platform}-${version}.zip`;
const zipFile = path.join(outDir, zipName);
makeZip({ sourceDir, outFile: zipFile, dryRun: options["dry-run"] });

const artifactKey = `${prefix}/${platform}/${version}/${zipName}`;
const latestKey = `${prefix}/${platform}/latest.json`;
const artifactUrl = joinUrl(domain, artifactKey);
const manifest = {
  kind: "libreoffice-runtime",
  platform,
  libreoffice: version,
  archive: {
    url: artifactUrl,
    sha256: options["dry-run"] ? "<dry-run>" : sha256(zipFile),
    size: options["dry-run"] ? 0 : fs.statSync(zipFile).size,
    format: "zip",
  },
  install: {
    targetSubdir: "libreoffice",
    executable: detectExecutable(platform),
  },
  generatedAt: new Date().toISOString(),
};
const manifestFile = path.join(outDir, "latest.json");
writeJson(manifestFile, manifest);

console.log("[publish-libreoffice-runtime] artifact:");
console.log(JSON.stringify({ file: zipFile, manifestFile, artifactKey, latestKey, manifest }, null, 2));

if (options.upload) {
  run("node", ["scripts/release-admin.mjs", "upload", "--bucket", bucket, "--key", artifactKey, "--file", zipFile], {
    dryRun: options["dry-run"],
  });
  run("node", ["scripts/release-admin.mjs", "upload", "--bucket", bucket, "--key", latestKey, "--file", manifestFile], {
    dryRun: options["dry-run"],
  });
}

if (options.register) {
  await registerPack({
    api,
    dryRun: options["dry-run"],
    artifact: {
      packId: "libreoffice",
      platform,
      version,
      url: artifactUrl,
      sha256: manifest.archive.sha256,
      sizeBytes: manifest.archive.size,
    },
  });
}
