#!/usr/bin/env node
/**
 * Package and optionally upload the optional LibreOffice runtime bundle.
 *
 * The desktop app can use the generated manifest to offer an on-demand install
 * instead of shipping LibreOffice in every installer.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_BUCKET = "lanrensoft";
const DEFAULT_DOMAIN = "https://qny.lanrensoft.cn";
const DEFAULT_PREFIX = "app/runtime";
const DEFAULT_PLATFORM = "win32-x64";

function usage() {
  console.error(`usage:
  node scripts/publish-libreoffice-runtime.mjs [--platform win32-x64] [--bucket lanrensoft] [--domain https://qny.lanrensoft.cn] [--prefix app/runtime] [--upload] [--dry-run]
`);
  process.exit(1);
}

function args() {
  const out = {
    platform: DEFAULT_PLATFORM,
    bucket: DEFAULT_BUCKET,
    domain: DEFAULT_DOMAIN,
    prefix: DEFAULT_PREFIX,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) usage();
    const key = item.slice(2);
    if (["upload", "dry-run"].includes(key)) {
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
  console.error(`[libreoffice-runtime] ${message}`);
  process.exit(1);
}

function run(command, argsList) {
  console.log(`[libreoffice-runtime] ${command} ${argsList.map(shellQuote).join(" ")}`);
  const result = spawnSync(command, argsList, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${argsList.join(" ")} failed`);
  }
}

function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : JSON.stringify(s);
}

function normalizePrefix(prefix) {
  return String(prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "");
}

function joinUrl(base, key) {
  return `${String(base || "").replace(/\/+$/g, "")}/${String(key || "").replace(/^\/+/g, "")}`;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function zipDirectory(sourceDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (process.platform === "win32") {
    const quotePs = (value) => `'${String(value).replace(/'/g, "''")}'`;
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Set-Location -LiteralPath ${quotePs(sourceDir)}; Compress-Archive -Path * -DestinationPath ${quotePs(zipPath)} -Force`,
    ]);
  } else {
    const result = spawnSync("zip", ["-qr", zipPath, "."], { cwd: sourceDir, stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`zip -qr ${zipPath} . failed`);
    }
  }
}

function uploadQiniu({ bucket, key, file, dryRun }) {
  run("node", [
    "scripts/release-admin.mjs",
    "upload",
    "--bucket",
    bucket,
    "--key",
    key,
    "--file",
    file,
    ...(dryRun ? ["--dry-run"] : []),
  ]);
}

const options = args();
if (options.platform !== "win32-x64") {
  fail("only win32-x64 LibreOffice runtime publishing is currently supported");
}

const runtimeRoot = path.join(ROOT, "bundles", options.platform, "runtime");
const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
const libreOfficeDir = path.join(runtimeRoot, "libreoffice");
const sofficeExe = path.join(libreOfficeDir, "program", "soffice.exe");

if (!fs.existsSync(manifestPath)) fail(`runtime manifest not found: ${manifestPath}`);
if (!fs.existsSync(sofficeExe)) fail(`LibreOffice executable not found: ${sofficeExe}`);

const runtimeManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const libreOfficeVersion = runtimeManifest.libreoffice;
if (!libreOfficeVersion) fail("runtime manifest does not declare a LibreOffice version");

const releaseDir = path.join(ROOT, "release", "runtime", options.platform);
const archiveName = `libreoffice-${options.platform}-${libreOfficeVersion}.zip`;
const archivePath = path.join(releaseDir, archiveName);
zipDirectory(libreOfficeDir, archivePath);

const prefix = normalizePrefix(options.prefix);
const archiveKey = `${prefix}/${options.platform}/${libreOfficeVersion}/${archiveName}`;
const publicUrl = joinUrl(options.domain, archiveKey);
const manifest = {
  kind: "libreoffice-runtime",
  platform: options.platform,
  libreoffice: libreOfficeVersion,
  archive: {
    url: publicUrl,
    sha256: sha256(archivePath),
    size: fs.statSync(archivePath).size,
  },
  install: {
    targetSubdir: "libreoffice",
    executable: "program/soffice.exe",
  },
  generatedAt: new Date().toISOString(),
};

const publishManifestPath = path.join(releaseDir, "libreoffice-runtime.json");
fs.writeFileSync(publishManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`[libreoffice-runtime] archive: ${path.relative(ROOT, archivePath)}`);
console.log(`[libreoffice-runtime] manifest: ${path.relative(ROOT, publishManifestPath)}`);
console.log(`[libreoffice-runtime] url: ${publicUrl}`);
console.log(`[libreoffice-runtime] sha256: ${manifest.archive.sha256}`);

if (options.upload || options["dry-run"]) {
  uploadQiniu({
    bucket: options.bucket,
    key: archiveKey,
    file: path.relative(ROOT, archivePath),
    dryRun: Boolean(options["dry-run"]),
  });
  uploadQiniu({
    bucket: options.bucket,
    key: `${prefix}/${options.platform}/latest.json`,
    file: path.relative(ROOT, publishManifestPath),
    dryRun: Boolean(options["dry-run"]),
  });
} else {
  console.log("[libreoffice-runtime] upload skipped. Add --upload to publish to Qiniu.");
}
