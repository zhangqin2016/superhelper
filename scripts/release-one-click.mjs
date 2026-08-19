#!/usr/bin/env node
/**
 * One command release:
 * 1. bump package version
 * 2. build installers
 * 3. publish immutable artifacts first, then server rows, then latest pointers
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  assertRemoteReleaseNotNewer,
  compareReleaseVersions,
} from "./lib/release-version-guard.mjs";
import { releaseArtifactName } from "./lib/release-artifact-naming.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DEFAULT_BUCKET = "lanrensoft";
const DEFAULT_DOMAIN = "https://qny.lanrensoft.cn";
const DEFAULT_PREFIX = "app/updates";
const DEFAULT_AUTO_PREFIX = "app/auto-updates";
const DEFAULT_KEY = "release-keys/license-private-key.pem";
const DEFAULT_SERVER_API = "https://lilych.lilywb.cn";

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
  --server-api ${DEFAULT_SERVER_API}
  --qiniu-up-host https://upload.qiniup.com

release flow:
  build -> immutable artifact upload -> server release rows -> latest pointers -> CDN refresh -> public verification

useful options:
  --skip-build             reuse existing dist artifacts
  --skip-preflight         do not run dependency/runtime-pack release preflight
  --skip-server-publish    upload Qiniu only, do not write server release rows
  --skip-catalog-publish   do not publish local skill/app catalog packages to the server
  --skip-skill-publish     publish workspace apps but skip local skill packages
  --skip-app-publish       publish skill packages but skip local workspace apps
  --skip-cdn-refresh       do not refresh Qiniu CDN metadata
  --skip-verify            do not verify public manifest/feed/API after upload

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
    if (
      [
        "upload",
        "dry-run",
        "force",
        "skip-build",
        "skip-preflight",
        "skip-server-publish",
        "skip-catalog-publish",
        "skip-skill-publish",
        "skip-app-publish",
        "skip-cdn-refresh",
        "skip-verify",
      ].includes(key)
    ) {
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
  const files = ["package.json", "package-lock.json", "resources/app-edition.json"];
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

function restoreAppEditionFile(snapshot) {
  const file = "resources/app-edition.json";
  const full = path.join(ROOT, file);
  if (snapshot.has(file)) {
    fs.writeFileSync(full, snapshot.get(file), "utf8");
  } else {
    fs.rmSync(full, { force: true });
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
  const isCmdShim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const actualCommand = isCmdShim ? (process.env.ComSpec || "cmd.exe") : command;
  const actualArgs = isCmdShim ? ["/d", "/s", "/c", command, ...argsList] : argsList;
  const result = spawnSync(actualCommand, actualArgs, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
    ...(isCmdShim ? { shell: false } : {}),
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${argsList.join(" ")} failed`);
  }
}

function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : JSON.stringify(s);
}

function publicArtifactUrl({ domain, prefix, platform, version, file }) {
  const base = String(domain || "").replace(/\/+$/g, "");
  const normalizedPrefix = String(prefix || "").replace(/^\/+|\/+$/g, "");
  return `${base}/${normalizedPrefix}/${platform}/${version}/${path.basename(file)}`;
}

function releaseObjectKey({ prefix, platform, version, file }) {
  return `${String(prefix || "").replace(/^\/+|\/+$/g, "")}/${platform}/${version}/${path.basename(file)}`;
}

function latestManifestPath(version) {
  return path.join("release", version, "latest.json");
}

function fetchBaseManifest({ domain, prefix, version }) {
  const url = `${String(domain).replace(/\/+$/g, "")}/${String(prefix).replace(/^\/+|\/+$/g, "")}/latest.json`;
  const text = fetchUrl(url);
  const manifest = JSON.parse(text);
  assertRemoteReleaseNotNewer(manifest.version, version);
  if (compareReleaseVersions(manifest.version, version) !== 0) return "";
  const file = path.join("release", version, "latest.base.json");
  fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, file), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[release-one] preserving platforms from signed base manifest: ${url}`);
  return file;
}

function uploadItem({ scriptNode, bucket, key, file, qiniuUpHost, dryRun }) {
  const uploadArgs = [
    "scripts/release-admin.mjs",
    "upload",
    "--bucket",
    bucket,
    "--key",
    key,
    "--file",
    file,
    "--up-host",
    qiniuUpHost,
  ];
  if (dryRun) uploadArgs.push("--dry-run");
  run(scriptNode, uploadArgs);
}

function uploadItems({ label, items, scriptNode, bucket, domain, qiniuUpHost, dryRun }) {
  if (!items.length) return;
  console.log(`[release-one] ${label}:`);
  for (const item of items) {
    console.log(`  ${domain.replace(/\/+$/g, "")}/${item.key}`);
    uploadItem({ scriptNode, bucket, qiniuUpHost, dryRun, ...item });
  }
}

function isMutablePointerUpload(item) {
  const name = path.basename(item.file);
  return name === "latest.json" || name === "latest-mac.yml" || name === "latest.yml";
}

function appBuilderBinPath() {
  if (process.env.USE_SYSTEM_APP_BUILDER === "true") return "app-builder";
  if (process.env.CUSTOM_APP_BUILDER_PATH) return path.resolve(process.env.CUSTOM_APP_BUILDER_PATH);
  const { platform, arch } = process;
  if (platform === "darwin") {
    return path.join(ROOT, "node_modules", "app-builder-bin", "mac", `app-builder_${arch === "x64" ? "amd64" : arch}`);
  }
  if (platform === "win32") {
    return path.join(ROOT, "node_modules", "app-builder-bin", "win", arch, "app-builder.exe");
  }
  return path.join(ROOT, "node_modules", "app-builder-bin", "linux", arch, "app-builder");
}

function ensureBlockmap(inputFile) {
  const outputFile = `${inputFile}.blockmap`;
  const absoluteInput = path.join(ROOT, inputFile);
  const absoluteOutput = path.join(ROOT, outputFile);
  if (fs.existsSync(absoluteOutput)) return outputFile;
  console.log(`[release-one] generating Windows blockmap for stable installer: ${outputFile}`);
  run(appBuilderBinPath(), ["blockmap", "--input", absoluteInput, "--output", absoluteOutput]);
  if (!fs.existsSync(absoluteOutput)) {
    fail(`Windows blockmap generation did not create ${outputFile}`);
  }
  return outputFile;
}

function runCapture(command, argsList, options = {}) {
  const result = spawnSync(command, argsList, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`${command} ${argsList.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
  return result.stdout || "";
}

function majorNodeVersion(command) {
  try {
    const stdout = runCapture(command, ["-e", "console.log(process.versions.node)"], { stdio: "pipe" }).trim();
    const major = Number.parseInt(stdout.split(".")[0], 10);
    return Number.isFinite(major) ? major : 0;
  } catch {
    return 0;
  }
}

function findModernNode() {
  const nvmNodes =
    fs
      .globSync?.(path.join(os.homedir(), ".nvm", "versions", "node", "v*", "bin", "node"))
      ?.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) ?? [];
  const candidates = [
    process.env.RELEASE_NODE_PATH,
    "node",
    process.execPath,
    ...nvmNodes,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (majorNodeVersion(candidate) >= 18) return candidate;
  }
  fail("release scripts require Node.js 18+ for fetch/FormData support. Set RELEASE_NODE_PATH to a modern node binary.");
}

function refreshCdn(urls) {
  if (!urls.length) return;
  const file = path.join(os.tmpdir(), `lily-cdn-refresh-${Date.now()}.txt`);
  fs.writeFileSync(file, `${urls.join("\n")}\n`, "utf8");
  try {
    run("qshell", ["cdnrefresh", "-i", file]);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function fetchUrl(url) {
  return runCapture("curl", ["-fsS", "--connect-timeout", "15", "--max-time", "45", url]);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRetry(label, fn, { attempts = 5, delayMs = 3000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) break;
      console.log(`[release-one] ${label} failed, retry ${attempt}/${attempts - 1}: ${err.message}`);
      sleepMs(delayMs);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message || "unknown error"}`);
}

function verifyStaticManifest({ domain, prefix, version, platforms }) {
  const url = `${String(domain).replace(/\/+$/g, "")}/${String(prefix).replace(/^\/+|\/+$/g, "")}/latest.json`;
  const json = JSON.parse(fetchUrl(url));
  if (json.version !== version) {
    throw new Error(`static manifest version mismatch: expected ${version}, got ${json.version || "<empty>"}`);
  }
  for (const platform of platforms) {
    if (!json.platforms?.[platform]?.url) {
      throw new Error(`static manifest missing platform: ${platform}`);
    }
  }
  console.log(`[release-one] verified static manifest: ${url}`);
}

function verifyAutoFeeds({ domain, autoPrefix, version, platforms }) {
  const base = `${String(domain).replace(/\/+$/g, "")}/${String(autoPrefix).replace(/^\/+|\/+$/g, "")}`;
  for (const platform of platforms) {
    const metadataName = platform.startsWith("darwin-") ? "latest-mac.yml" : "latest.yml";
    const url = `${base}/${platform}/stable/${metadataName}`;
    const text = fetchUrl(url);
    if (!text.includes(`version: "${version}"`) && !text.includes(`version: ${version}`)) {
      throw new Error(`auto update feed version mismatch for ${platform}: ${url}`);
    }
    console.log(`[release-one] verified auto feed: ${url}`);
  }
}

function verifyServerReleases({ api, version, platforms }) {
  const base = String(api).replace(/\/+$/g, "");
  for (const platform of platforms) {
    const url = `${base}/api/releases/latest?platform=${encodeURIComponent(platform)}&version=0.0.0`;
    const json = JSON.parse(fetchUrl(url));
    const gotVersion = json.version || json.release?.version;
    const gotPlatform = json.platform || json.release?.platform;
    if (gotVersion !== version || gotPlatform !== platform) {
      throw new Error(
        `server release mismatch for ${platform}: expected ${version}/${platform}, got ${gotVersion || "<empty>"}/${gotPlatform || "<empty>"}`,
      );
    }
    console.log(`[release-one] verified server release: ${platform}`);
  }
}

function hasServerReleaseAuth() {
  return Boolean(
    process.env.RELEASE_ADMIN_TOKEN ||
      (process.env.RELEASE_ADMIN_EMAIL && process.env.RELEASE_ADMIN_PASSWORD),
  );
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
  const metadataName = platform.startsWith("darwin-") ? "latest-mac.yml" : "latest.yml";
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
    const arm64Dmg = distFile(releaseArtifactName("darwin-arm64", productName, version, "dmg"));
    if (fs.existsSync(path.join(ROOT, arm64Dmg))) {
      items.push(["darwin-arm64", arm64Dmg]);
    }
    const x64Dmg = distFile(releaseArtifactName("darwin-x64", productName, version, "dmg"));
    if (fs.existsSync(path.join(ROOT, x64Dmg))) {
      items.push(["darwin-x64", x64Dmg]);
    }
    if (!items.some(([platform]) => platform === "darwin-arm64")) {
      fail(`no mac arm64 DMG found for ${version} under dist/`);
    }
    if (!items.some(([platform]) => platform === "darwin-x64")) {
      fail(`no mac x64 DMG found for ${version} under dist/`);
    }
  }
  if (target === "win" || target === "all") {
    const winExe = distFile(releaseArtifactName("win32-x64", productName, version, "exe"));
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
    const arm64Zip = distFile(releaseArtifactName("darwin-arm64", productName, version, "zip"));
    if (fs.existsSync(path.join(ROOT, arm64Zip))) {
      items.push({
        platform: "darwin-arm64",
        artifact: arm64Zip,
        blockmap: "",
      });
    } else {
      fail(`no mac arm64 auto-update zip found for ${version}: ${arm64Zip}`);
    }

    const x64Zip = distFile(releaseArtifactName("darwin-x64", productName, version, "zip"));
    if (fs.existsSync(path.join(ROOT, x64Zip))) {
      items.push({
        platform: "darwin-x64",
        artifact: x64Zip,
        blockmap: "",
      });
    } else {
      fail(`no mac x64 auto-update zip found for ${version}: ${x64Zip}`);
    }
  }
  if (target === "win" || target === "all") {
    const winExe = distFile(releaseArtifactName("win32-x64", productName, version, "exe"));
    if (fs.existsSync(path.join(ROOT, winExe))) {
      const winBlockmap = ensureBlockmap(winExe);
      items.push({
        platform: "win32-x64",
        artifact: winExe,
        blockmap: winBlockmap,
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
if (options.edition) {
  fail("--edition has been removed. Publish one universal client; region/features are delivered by /api/client/bootstrap.");
}
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
const qiniuUpHost = options["qiniu-up-host"] || process.env.QINIU_UP_HOST || "https://upload.qiniup.com";
const publishServerRelease = Boolean(options.upload && !options["dry-run"] && !options["skip-server-publish"]);
const publishLocalCatalog = Boolean(
  options.upload && !options["skip-server-publish"] && !options["skip-catalog-publish"],
);

ensureFile(key, "private key");
if (!fs.existsSync(path.join(ROOT, "resources", "license-public-key.pem"))) {
  fail("resources/license-public-key.pem not found. Run `npm run release:admin -- keygen --out release-keys` and copy the public key first.");
}
if ((publishServerRelease || (publishLocalCatalog && !options["dry-run"])) && !hasServerReleaseAuth()) {
  fail("server release publish requires RELEASE_ADMIN_TOKEN or RELEASE_ADMIN_EMAIL + RELEASE_ADMIN_PASSWORD. Use --skip-server-publish only for static-only uploads.");
}
const scriptNode = findModernNode();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

console.log(`[release-one] version ${currentVersion} -> ${nextVersion}`);
console.log("[release-one] universal client package; runtime region policy is delivered by /api/client/bootstrap");
const versionSnapshot = snapshotVersionFiles();
let keepVersionFiles = false;

try {
  if (!options["skip-preflight"]) {
    run(scriptNode, ["scripts/release-preflight.mjs"], {
      env: {
        ...process.env,
        LILY_RELEASE_TARGET: target,
        ...(options.upload ? { LILY_RELEASE_ONLINE_PREFLIGHT: "1" } : {}),
      },
    });
  }

  setPackageVersion(nextVersion);

  if (!options["skip-build"]) {
    const buildScript = target === "mac" ? "dist:mac" : target === "win" ? "dist:win" : target === "all" ? "dist:all" : "";
    if (!buildScript) fail(`invalid --target value: ${target}. expected mac, win, or all`);
    run(npmCommand, ["run", buildScript]);
  }

  const artifacts = artifactCandidates(target, pkg.build?.productName || pkg.name, nextVersion)
    .map(([platform, file]) => [platform, ensureFile(file, `artifact ${platform}`)]);

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
    "--up-host",
    qiniuUpHost,
  ];
  if (options.upload && !options["dry-run"]) {
    const baseManifest = fetchBaseManifest({
      domain,
      prefix,
      version: nextVersion,
    });
    if (baseManifest) publishArgs.push("--base-manifest", baseManifest);
  }
  if (notes) publishArgs.push("--notes", notes);
  for (const [platform, file] of artifacts) {
    publishArgs.push("--artifact", `${platform}=${file}`);
  }
  if (options.force) publishArgs.push("--force");

  run(scriptNode, publishArgs);

  const releaseArtifactUploads = artifacts.map(([platform, file]) => ({
    key: releaseObjectKey({ prefix, platform, version: nextVersion, file }),
    file,
  }));

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
  const autoPointerUploads = autoUploads.filter(isMutablePointerUpload);
  const autoArtifactUploads = autoUploads.filter((item) => !isMutablePointerUpload(item));

  if (options.upload || options["dry-run"]) {
    uploadItems({
      label: "immutable release artifacts",
      items: releaseArtifactUploads,
      scriptNode,
      bucket,
      domain,
      qiniuUpHost,
      dryRun: Boolean(options["dry-run"]),
    });
    uploadItems({
      label: "immutable auto-update artifacts",
      items: autoArtifactUploads,
      scriptNode,
      bucket,
      domain,
      qiniuUpHost,
      dryRun: Boolean(options["dry-run"]),
    });
  } else {
    for (const item of [...releaseArtifactUploads, ...autoArtifactUploads, ...autoPointerUploads]) {
      console.log(`  upload skipped: ${item.file}`);
    }
  }

  if (publishServerRelease) {
    const serverArgs = [
      "scripts/publish-release-server.mjs",
      "--api",
      options["server-api"] || DEFAULT_SERVER_API,
      "--version",
      nextVersion,
    ];
    for (const [platform, file] of artifacts) {
      serverArgs.push(
        "--artifact",
        `${platform}=${file}=${publicArtifactUrl({ domain, prefix, platform, version: nextVersion, file })}`,
      );
    }
    if (notes) serverArgs.push("--notes", notes);
    if (options.force) serverArgs.push("--force");
    run(scriptNode, serverArgs);
    keepVersionFiles = true;
  } else if (options.upload && !options["dry-run"]) {
    console.log("[release-one] server release publish skipped by --skip-server-publish.");
  }

  if (publishLocalCatalog) {
    const catalogArgs = [
      "scripts/publish-local-catalog-server.mjs",
      "--api",
      options["server-api"] || DEFAULT_SERVER_API,
      "--channel",
      "stable",
      "--version",
      nextVersion,
      "--bucket",
      bucket,
      "--domain",
      domain,
      "--qiniu-up-host",
      qiniuUpHost,
    ];
    if (options.force) catalogArgs.push("--force");
    if (options["skip-skill-publish"]) catalogArgs.push("--skip-skills");
    if (options["skip-app-publish"]) catalogArgs.push("--skip-apps");
    if (options["dry-run"]) catalogArgs.push("--dry-run");
    else catalogArgs.push("--upload");
    run(scriptNode, catalogArgs);
  } else if (options["skip-catalog-publish"]) {
    console.log("[release-one] local skill/app catalog publish skipped by --skip-catalog-publish.");
  }

  const pointerUploads = [
    { key: `${String(prefix).replace(/^\/+|\/+$/g, "")}/latest.json`, file: latestManifestPath(nextVersion) },
    ...autoPointerUploads,
  ];
  if (options.upload || options["dry-run"]) {
    if (options.upload && !options["dry-run"]) {
      const latestUrl = `${domain.replace(/\/+$/g, "")}/${prefix.replace(/^\/+|\/+$/g, "")}/latest.json`;
      const remoteManifest = JSON.parse(fetchUrl(latestUrl));
      assertRemoteReleaseNotNewer(remoteManifest.version, nextVersion);
    }
    uploadItems({
      label: "mutable latest pointers",
      items: pointerUploads,
      scriptNode,
      bucket,
      domain,
      qiniuUpHost,
      dryRun: Boolean(options["dry-run"]),
    });
    keepVersionFiles = true;
  }

  if (options.upload && !options["dry-run"]) {
    const cdnUrls = [
      `${domain.replace(/\/+$/g, "")}/${prefix.replace(/^\/+|\/+$/g, "")}/latest.json`,
      ...autoUploads
        .filter((item) => path.basename(item.file) === "latest-mac.yml" || path.basename(item.file) === "latest.yml")
        .map((item) => `${domain.replace(/\/+$/g, "")}/${item.key}`),
    ];
    if (options["skip-cdn-refresh"]) {
      console.log("[release-one] CDN refresh skipped by --skip-cdn-refresh.");
    } else {
      refreshCdn(cdnUrls);
    }

    if (options["skip-verify"]) {
      console.log("[release-one] public verification skipped by --skip-verify.");
    } else {
      const artifactPlatforms = artifacts.map(([platform]) => platform);
      withRetry("static manifest verification", () =>
        verifyStaticManifest({ domain, prefix, version: nextVersion, platforms: artifactPlatforms }),
      );
      withRetry("auto feed verification", () =>
        verifyAutoFeeds({
          domain,
          autoPrefix,
          version: nextVersion,
          platforms: autoUpdateCandidates(target, pkg.build?.productName || pkg.name, nextVersion).map(
            (item) => item.platform,
          ),
        }),
      );
      if (publishServerRelease) {
        withRetry("server release verification", () =>
          verifyServerReleases({
            api: options["server-api"] || DEFAULT_SERVER_API,
            version: nextVersion,
            platforms: artifactPlatforms,
          }),
        );
      }
    }
  }

  console.log(`[release-one] done ${nextVersion}`);
  console.log(`[release-one] manifest: ${domain.replace(/\/+$/g, "")}/${prefix.replace(/^\/+|\/+$/g, "")}/latest.json`);
  console.log(`[release-one] auto feed base: ${domain.replace(/\/+$/g, "")}/${String(autoPrefix).replace(/^\/+|\/+$/g, "")}`);
} catch (err) {
  if (keepVersionFiles) {
    fail(`${err.message}; kept package version files at ${nextVersion} because the release is already visible`);
  }
  restoreVersionFiles(versionSnapshot);
  fail(`${err.message}; restored package version files to ${currentVersion}`);
}
