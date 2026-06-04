#!/usr/bin/env node
/**
 * One command release:
 * 1. bump package version
 * 2. build installers
 * 3. publish signed latest.json + installers to Qiniu
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_BUCKET = "lanrensoft";
const DEFAULT_DOMAIN = "https://qny.lanrensoft.cn";
const DEFAULT_PREFIX = "app/updates";
const DEFAULT_AUTO_PREFIX = "app/auto-updates";
const DEFAULT_KEY = "release-keys/license-private-key.pem";

function usage() {
  console.error(`usage:
  node scripts/release-one-click.mjs --bump patch|minor|major [--target mac|win|all] --upload [--notes "release notes"]
  node scripts/release-one-click.mjs --version 0.2.0 [--target mac|win|all] --upload [--notes "release notes"]

defaults:
  --bucket ${DEFAULT_BUCKET}
  --domain ${DEFAULT_DOMAIN}
  --prefix ${DEFAULT_PREFIX}
  --auto-prefix ${DEFAULT_AUTO_PREFIX}
  --key ${DEFAULT_KEY}

examples:
  npm run release:one -- --bump patch --upload --notes "修复会话卡住问题"
  npm run release:one -- --version 0.2.0 --upload
`);
  process.exit(1);
}

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) usage();
    const key = item.slice(2);
    if (["upload", "dry-run", "force", "skip-build"].includes(key)) {
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
  console.error(`[release-one] ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, filePath), "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(path.join(ROOT, filePath), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function snapshotVersionFiles() {
  const files = ["package.json", "package-lock.json"];
  const snapshot = new Map();
  for (const file of files) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) {
      snapshot.set(file, fs.readFileSync(full, "utf8"));
    }
  }
  return snapshot;
}

function restoreVersionFiles(snapshot) {
  for (const [file, content] of snapshot.entries()) {
    fs.writeFileSync(path.join(ROOT, file), content, "utf8");
  }
}

function parseVersion(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) fail(`invalid version: ${version}. expected x.y.z`);
  return match.slice(1).map((x) => Number.parseInt(x, 10));
}

function bumpVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  fail(`invalid --bump value: ${bump}. expected patch, minor, or major`);
}

function run(command, argsList, options = {}) {
  console.log(`[release-one] ${command} ${argsList.map(shellQuote).join(" ")}`);
  const result = spawnSync(command, argsList, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${argsList.join(" ")} failed`);
  }
}

function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : JSON.stringify(s);
}

function ensureFile(filePath, label) {
  const full = path.join(ROOT, filePath);
  if (!fs.existsSync(full)) fail(`${label} not found: ${filePath}`);
  return filePath;
}

function distFile(name) {
  return path.join("dist", name);
}

function sha512Base64(filePath) {
  return crypto.createHash("sha512").update(fs.readFileSync(path.join(ROOT, filePath))).digest("base64");
}

function fileSize(filePath) {
  return fs.statSync(path.join(ROOT, filePath)).size;
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function writeAutoUpdateYaml({ platform, version, artifact, notes }) {
  const metadataName = platform === "darwin-arm64" ? "latest-mac.yml" : "latest.yml";
  const releaseDir = path.join(ROOT, "release", version, "auto", platform);
  fs.mkdirSync(releaseDir, { recursive: true });
  const artifactName = path.basename(artifact);
  const sha512 = sha512Base64(artifact);
  const size = fileSize(artifact);
  const lines = [
    `version: ${yamlString(version)}`,
    "files:",
    `  - url: ${yamlString(artifactName)}`,
    `    sha512: ${yamlString(sha512)}`,
    `    size: ${size}`,
    `path: ${yamlString(artifactName)}`,
    `sha512: ${yamlString(sha512)}`,
    `releaseDate: ${yamlString(new Date().toISOString())}`,
  ];
  if (notes) lines.push(`releaseNotes: ${yamlString(notes)}`);
  const file = path.join(releaseDir, metadataName);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return path.relative(ROOT, file);
}

function artifactCandidates(target, productName, version) {
  const items = [];
  if (target === "mac" || target === "all") {
    const arm64Dmg = distFile(`${productName}-${version}-arm64.dmg`);
    if (fs.existsSync(path.join(ROOT, arm64Dmg))) {
      items.push(["darwin-arm64", arm64Dmg]);
    }
    const x64Dmg = distFile(`${productName}-${version}-x64.dmg`);
    if (fs.existsSync(path.join(ROOT, x64Dmg))) {
      items.push(["darwin-x64", x64Dmg]);
    }
    if (target === "mac" && !items.some(([platform]) => platform.startsWith("darwin-"))) {
      fail(`no mac DMG found for ${version} under dist/`);
    }
  }
  if (target === "win" || target === "all") {
    const winExe = distFile(`${productName}-${version}-x64.exe`);
    if (fs.existsSync(path.join(ROOT, winExe))) {
      items.push(["win32-x64", winExe]);
    } else if (target === "win") {
      fail(`no Windows installer found for ${version} under dist/`);
    }
  }
  if (!items.length) fail(`invalid --target value: ${target}. expected mac, win, or all`);
  if (target === "all" && !items.some(([platform]) => platform.startsWith("darwin-"))) {
    fail(`target all requires at least one mac DMG for ${version} under dist/`);
  }
  if (target === "all" && !items.some(([platform]) => platform === "win32-x64")) {
    fail(`target all requires a Windows installer for ${version} under dist/`);
  }
  return items;
}

function autoUpdateCandidates(target, productName, version) {
  const items = [];
  if (target === "mac" || target === "all") {
    const macZip = distFile(`${productName}-${version}-arm64.zip`);
    if (fs.existsSync(path.join(ROOT, macZip))) {
      items.push({
        platform: "darwin-arm64",
        artifact: macZip,
        blockmap: fs.existsSync(path.join(ROOT, `${macZip}.blockmap`)) ? `${macZip}.blockmap` : "",
      });
    } else if (target === "mac" || target === "all") {
      fail(`no mac auto-update zip found for ${version}: ${macZip}`);
    }
  }
  if (target === "win" || target === "all") {
    const winExe = distFile(`${productName}-${version}-x64.exe`);
    if (fs.existsSync(path.join(ROOT, winExe))) {
      items.push({
        platform: "win32-x64",
        artifact: winExe,
        blockmap: fs.existsSync(path.join(ROOT, `${winExe}.blockmap`)) ? `${winExe}.blockmap` : "",
      });
    } else if (target === "win" || target === "all") {
      fail(`no Windows auto-update installer found for ${version}: ${winExe}`);
    }
  }
  return items;
}

function setPackageVersion(version) {
  const pkg = readJson("package.json");
  if (pkg.version === version) return;
  pkg.version = version;
  writeJson("package.json", pkg);

  const lockPath = path.join(ROOT, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    const lock = readJson("package-lock.json");
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    writeJson("package-lock.json", lock);
  }
}

const options = args();
const target = options.target || "all";
const pkg = readJson("package.json");
const currentVersion = pkg.version;
const nextVersion = options.version || bumpVersion(currentVersion, options.bump || "patch");
parseVersion(nextVersion);

const bucket = options.bucket || DEFAULT_BUCKET;
const domain = options.domain || DEFAULT_DOMAIN;
const prefix = options.prefix || DEFAULT_PREFIX;
const autoPrefix = options["auto-prefix"] || DEFAULT_AUTO_PREFIX;
const key = options.key || DEFAULT_KEY;
const notes = options.notes || "";

ensureFile(key, "private key");
if (!fs.existsSync(path.join(ROOT, "resources", "license-public-key.pem"))) {
  fail("resources/license-public-key.pem not found. Run `npm run release:admin -- keygen --out release-keys` and copy the public key first.");
}

console.log(`[release-one] version ${currentVersion} -> ${nextVersion}`);
const versionSnapshot = snapshotVersionFiles();

try {
  setPackageVersion(nextVersion);

  if (!options["skip-build"]) {
    const buildScript = target === "mac" ? "dist:mac" : target === "win" ? "dist:win" : target === "all" ? "dist:all" : "";
    if (!buildScript) fail(`invalid --target value: ${target}. expected mac, win, or all`);
    run("npm", ["run", buildScript]);
  }

  const artifacts = artifactCandidates(target, pkg.build?.productName || pkg.name, nextVersion)
    .map(([platform, file]) => `${platform}=${ensureFile(file, `artifact ${platform}`)}`);

  const publishArgs = [
    "scripts/release-admin.mjs",
    "publish",
    "--key",
    key,
    "--bucket",
    bucket,
    "--domain",
    domain,
    "--version",
    nextVersion,
    "--prefix",
    prefix,
    "--notes",
    notes,
  ];
  for (const artifact of artifacts) {
    publishArgs.push("--artifact", artifact);
  }
  if (options.force) publishArgs.push("--force");
  if (options.upload) publishArgs.push("--upload");
  if (options["dry-run"]) publishArgs.push("--dry-run");

  run(process.execPath, publishArgs);

  const autoUploads = [];
  for (const item of autoUpdateCandidates(target, pkg.build?.productName || pkg.name, nextVersion)) {
    const metadata = writeAutoUpdateYaml({
      platform: item.platform,
      version: nextVersion,
      artifact: item.artifact,
      notes,
    });
    const feedPrefix = `${String(autoPrefix).replace(/^\/+|\/+$/g, "")}/${item.platform}/stable`;
    autoUploads.push(
      { key: `${feedPrefix}/${path.basename(item.artifact)}`, file: item.artifact },
      { key: `${feedPrefix}/${path.basename(metadata)}`, file: metadata },
    );
    if (item.blockmap) {
      autoUploads.push({ key: `${feedPrefix}/${path.basename(item.blockmap)}`, file: item.blockmap });
    }
  }

  if (autoUploads.length) {
    console.log(`[release-one] auto update feeds:`);
    for (const item of autoUploads) {
      console.log(`  ${domain.replace(/\/+$/g, "")}/${item.key}`);
      const uploadArgs = [
        "scripts/release-admin.mjs",
        "upload",
        "--bucket",
        bucket,
        "--key",
        item.key,
        "--file",
        item.file,
      ];
      if (options["dry-run"]) uploadArgs.push("--dry-run");
      if (options.upload || options["dry-run"]) {
        run(process.execPath, uploadArgs);
      } else {
        console.log(`  upload skipped: ${item.file}`);
      }
    }
  }

  console.log(`[release-one] done ${nextVersion}`);
  console.log(`[release-one] manifest: ${domain.replace(/\/+$/g, "")}/${prefix.replace(/^\/+|\/+$/g, "")}/latest.json`);
  console.log(`[release-one] auto feed base: ${domain.replace(/\/+$/g, "")}/${String(autoPrefix).replace(/^\/+|\/+$/g, "")}`);
} catch (err) {
  restoreVersionFiles(versionSnapshot);
  fail(`${err.message}; restored package version files to ${currentVersion}`);
}
