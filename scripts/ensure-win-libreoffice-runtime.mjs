#!/usr/bin/env node
/**
 * Ensure the Windows runtime contains LibreOffice before packaging.
 *
 * Windows LibreOffice cannot be built from macOS because MSI administrative
 * extraction needs Windows tooling. The release pipeline publishes the
 * extracted LibreOffice directory as a signed CDN artifact; this script pulls
 * that artifact back into bundles/win32-x64/runtime for cross-host packaging.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = "win32-x64";
const DEFAULT_MANIFEST_URL = "https://qny.lanrensoft.cn/app/runtime/win32-x64/latest.json";

function parseArgs(argv) {
  const out = { manifestUrl: DEFAULT_MANIFEST_URL, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--force") {
      out.force = true;
      continue;
    }
    if (item === "--manifest-url") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) fail("missing value for --manifest-url");
      out.manifestUrl = value;
      i += 1;
      continue;
    }
    fail(`unknown argument: ${item}`);
  }
  return out;
}

function fail(message) {
  console.error(`[ensure-win-libreoffice-runtime] ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[ensure-win-libreoffice-runtime] ${message}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeWritableTree(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.lstatSync(targetPath);
  try {
    fs.chmodSync(targetPath, stat.isDirectory() ? 0o755 : 0o644);
  } catch {
    // Best effort. fs.rmSync will report the real failure if this was required.
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const entry of fs.readdirSync(targetPath)) {
    makeWritableTree(path.join(targetPath, entry));
  }
}

function removeTree(targetPath) {
  makeWritableTree(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function commandExists(command) {
  const shell = process.platform === "win32" ? "where" : "command -v";
  const result = spawnSync(process.platform === "win32" ? "cmd" : "sh", [
    process.platform === "win32" ? "/c" : "-lc",
    `${shell} ${command}`,
  ], { stdio: "ignore" });
  return result.status === 0;
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.status !== 0) fail(`${command} failed`);
}

function runResult(command, args, options = {}) {
  log(`${command} ${args.join(" ")}`);
  return spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) fail(`download manifest failed: ${response.status} ${url}`);
  return response.json();
}

async function downloadFile(url, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp`;
  if (commandExists("curl")) {
    run("curl", [
      "-fL",
      "--retry",
      "8",
      "--retry-delay",
      "2",
      "--retry-all-errors",
      "--connect-timeout",
      "20",
      "--speed-time",
      "60",
      "--speed-limit",
      "1024",
      "-C",
      "-",
      "-o",
      tempFile,
      url,
    ]);
    fs.renameSync(tempFile, filePath);
    return;
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) fail(`download archive failed: ${response.status} ${url}`);
  fs.rmSync(tempFile, { force: true });
  await pipeline(response.body, fs.createWriteStream(tempFile));
  fs.renameSync(tempFile, filePath);
}

function unzipArchive(archivePath, outDir, executableRel) {
  removeTree(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  if (commandExists("unzip")) {
    const result = runResult("unzip", ["-q", archivePath, "-d", outDir]);
    if (result.status === 0) return;
    if (findExtractedRoot(outDir, executableRel)) {
      log("unzip returned a warning status, but the runtime executable was extracted");
      return;
    }
    fail("unzip failed");
    return;
  }
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(outDir)} -Force`,
    ]);
    return;
  }
  fail("unzip command not found");
}

function findExtractedRoot(outDir, executableRel) {
  if (fs.existsSync(path.join(outDir, executableRel))) return outDir;
  const entries = fs.readdirSync(outDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length === 1) {
    const nested = path.join(outDir, entries[0].name);
    if (fs.existsSync(path.join(nested, executableRel))) return nested;
  }
  return null;
}

const options = parseArgs(process.argv.slice(2));
const runtimeRoot = path.join(ROOT, "bundles", PLATFORM, "runtime");
const runtimeManifestPath = path.join(runtimeRoot, "runtime-manifest.json");
if (!fs.existsSync(runtimeManifestPath)) {
  fail(`missing ${path.relative(ROOT, runtimeManifestPath)}; build or restore the Windows runtime first`);
}

const runtimeManifest = readJson(runtimeManifestPath);
const remoteManifest = await fetchJson(options.manifestUrl);
if (remoteManifest.kind !== "libreoffice-runtime" || remoteManifest.platform !== PLATFORM) {
  fail(`manifest is not a ${PLATFORM} LibreOffice runtime manifest`);
}
if (!remoteManifest.archive?.url || !remoteManifest.archive?.sha256) {
  fail("manifest is missing archive url or sha256");
}

const targetSubdir = remoteManifest.install?.targetSubdir || "libreoffice";
const executableRel = remoteManifest.install?.executable || "program/soffice.exe";
const libreOfficeDir = path.join(runtimeRoot, targetSubdir);
const executable = path.join(libreOfficeDir, executableRel);
if (
  !options.force &&
  runtimeManifest.libreoffice === remoteManifest.libreoffice &&
  fs.existsSync(executable)
) {
  log(`ok ${PLATFORM} LibreOffice ${remoteManifest.libreoffice} already present`);
  process.exit(0);
}

const archiveName = path.basename(new URL(remoteManifest.archive.url).pathname);
const cacheFile = path.join(
  ROOT,
  "release",
  "runtime-cache",
  PLATFORM,
  remoteManifest.libreoffice,
  archiveName,
);

if (!fs.existsSync(cacheFile) || sha256(cacheFile) !== remoteManifest.archive.sha256) {
  log(`download ${remoteManifest.archive.url}`);
  await downloadFile(remoteManifest.archive.url, cacheFile);
}

const actualSha = sha256(cacheFile);
if (actualSha !== remoteManifest.archive.sha256) {
  fail(`sha256 mismatch for ${archiveName}: expected ${remoteManifest.archive.sha256}, got ${actualSha}`);
}
if (remoteManifest.archive.size && fs.statSync(cacheFile).size !== remoteManifest.archive.size) {
  fail(`size mismatch for ${archiveName}: expected ${remoteManifest.archive.size}, got ${fs.statSync(cacheFile).size}`);
}

const extractDir = path.join(ROOT, "release", "runtime-cache", PLATFORM, remoteManifest.libreoffice, "extract");
unzipArchive(cacheFile, extractDir, executableRel);
makeWritableTree(extractDir);
const extractedRoot = findExtractedRoot(extractDir, executableRel);
if (!extractedRoot) fail(`archive does not contain ${executableRel}`);

removeTree(libreOfficeDir);
fs.mkdirSync(path.dirname(libreOfficeDir), { recursive: true });
fs.cpSync(extractedRoot, libreOfficeDir, { recursive: true });

runtimeManifest.libreoffice = remoteManifest.libreoffice;
runtimeManifest.libreofficeRuntime = {
  source: options.manifestUrl,
  sha256: remoteManifest.archive.sha256,
  installedAt: new Date().toISOString(),
};
writeJson(runtimeManifestPath, runtimeManifest);
log(`installed LibreOffice ${remoteManifest.libreoffice} into ${path.relative(ROOT, libreOfficeDir)}`);
