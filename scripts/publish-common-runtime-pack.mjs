#!/usr/bin/env node
/**
 * Build and publish artifact-only runtime packs:
 * - web-automation: Node Playwright modules + Chromium browser cache
 * - ffmpeg: ffmpeg + ffprobe binaries
 * - pandoc: official pandoc binary
 * - git: a platform-native Git directory supplied by the release builder
 *
 * These packs are not Python target packs, so scripts/build-runtime-pack.mjs is
 * intentionally the wrong tool for them. Build on the target OS; browser/native
 * binaries must be verified where they will run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { healthProbeForSpec, updateRuntimePackLock } from "./lib/runtime-pack-lock.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PACK_SPECS } = require(path.join(ROOT, "src/main/runtime-pack-specs.js"));
const DEFAULT_DOMAIN = "https://qny.lanrensoft.cn";
const DEFAULT_BUCKET = "lanrensoft";
const DEFAULT_PREFIX = "app/runtime-packs";
const DEFAULT_API = "https://lilych.lilywb.cn";
const CACHE_DIR = path.join(ROOT, ".cache", "runtime-pack-build");

const DEFAULT_VERSIONS = {
  playwright: "1.61.1",
  playwrightMcp: "0.0.77",
  ffmpegStatic: "5.3.0",
  ffprobeStatic: "3.1.0",
  pandoc: "3.10",
};

const PANDOC_URLS = {
  "darwin-arm64": (v) => `https://github.com/jgm/pandoc/releases/download/${v}/pandoc-${v}-arm64-macOS.zip`,
  "darwin-x64": (v) => `https://github.com/jgm/pandoc/releases/download/${v}/pandoc-${v}-x86_64-macOS.zip`,
  "win32-x64": (v) => `https://github.com/jgm/pandoc/releases/download/${v}/pandoc-${v}-windows-x86_64.zip`,
  "linux-x64": (v) => `https://github.com/jgm/pandoc/releases/download/${v}/pandoc-${v}-linux-amd64.tar.gz`,
};

function usage() {
  console.error(`usage:
  node scripts/publish-common-runtime-pack.mjs --pack web-automation|ffmpeg|pandoc|git|all \\
    [--platform darwin-arm64] [--out dist/runtime-packs] \\
    [--upload] [--register] [--dry-run]

  node scripts/publish-common-runtime-pack.mjs --pack git --source <portable-git-dir> \\
    --platform win32-x64 --version 2.50.1 [--upload] [--register]

env for --register:
  RELEASE_ADMIN_TOKEN
  RELEASE_ADMIN_EMAIL + RELEASE_ADMIN_PASSWORD
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

function detectPlatform() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  const plat = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  return `${plat}-${arch}`;
}

function fail(message) {
  console.error(`[publish-runtime-pack] ${message}`);
  process.exit(1);
}

function platformCommand(command) {
  if (process.platform !== "win32") return command;
  if (command === "qshell") return "qshell.exe";
  return command;
}

function quoteWindowsCmdArg(value) {
  const text = String(value ?? "");
  if (!text) return "\"\"";
  if (!/[ \t\r\n"&|<>^]/.test(text)) return text;
  return `"${text.replace(/(["^])/g, "^$1")}"`;
}

function spawnTarget(command, args) {
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsCmdArg).join(" ")],
    };
  }
  return { command: platformCommand(command), args };
}

function run(command, args, options = {}) {
  console.log(`[publish-runtime-pack] ${[command, ...args].join(" ")}`);
  if (options.dryRun) return;
  const target = spawnTarget(command, args);
  const result = spawnSync(target.command, target.args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    stdio: options.stdio || "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed with exit code ${result.status ?? "unknown"}`);
}

function runCapture(command, args, options = {}) {
  const target = spawnTarget(command, args);
  const result = spawnSync(target.command, target.args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout.trim();
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function joinUrl(base, key) {
  return `${String(base).replace(/\/+$/g, "")}/${String(key).replace(/^\/+/g, "")}`;
}

function download(url, dest) {
  ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  if (fs.existsSync(dest)) return dest;
  const args = [
    "-fL",
    "--connect-timeout", "30",
    "--max-time", "0",
    "--retry", "10",
    "--retry-delay", "2",
    "--retry-all-errors",
    "-C", "-",
    "-o", part,
    url,
  ];
  run("curl", args);
  fs.renameSync(part, dest);
  return dest;
}

function assertCurrentPlatform(platform, packId) {
  if (platform === detectPlatform()) return;
  fail(`${packId} must be built on ${platform}. Current host is ${detectPlatform()}; refusing to publish unverified native/browser binaries.`);
}

function copyExecutable(src, dest) {
  if (!fs.existsSync(src)) fail(`source executable not found: ${src}`);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
}

function packTarGz(stageDir, outFile) {
  ensureDir(path.dirname(outFile));
  rmrf(outFile);
  execFileSync("tar", ["-czf", outFile, "-C", stageDir, "."], { stdio: "inherit" });
}

function findFile(root, names) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (names.includes(entry.name)) return full;
    }
  }
  return "";
}

function findExecutableFile(root, names) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!names.includes(entry.name)) continue;
      if (process.platform === "win32" || (fs.statSync(full).mode & 0o111)) return full;
    }
  }
  return "";
}

function copyDirectoryContents(source, destination) {
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    fail(`runtime pack source directory not found: ${source || ""}`);
  }
  const hardlinks = new Map();
  const copyEntry = (from, to) => {
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) {
      ensureDir(to);
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        copyEntry(path.join(from, entry.name), path.join(to, entry.name));
      }
      return;
    }
    ensureDir(path.dirname(to));
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
      return;
    }
    const inodeKey = `${stat.dev}:${stat.ino}`;
    const existing = hardlinks.get(inodeKey);
    if (existing) {
      fs.linkSync(existing, to);
      return;
    }
    fs.copyFileSync(from, to);
    fs.chmodSync(to, stat.mode & 0o7777);
    hardlinks.set(inodeKey, to);
  };
  copyEntry(source, destination);
}

function buildGit({ stageDir, platform, source, version }) {
  assertCurrentPlatform(platform, "git");
  if (!source) fail("git pack requires --source <portable-git-directory>");
  copyDirectoryContents(path.resolve(source), stageDir);
  const names = platform.startsWith("win32") ? ["git.exe", "git.cmd", "git.bat"] : ["git"];
  const git = findExecutableFile(stageDir, names);
  if (!git) fail(`portable Git source does not contain ${names.join(" / ")}`);
  const pathEntries = [
    path.dirname(git),
    path.join(stageDir, "bin"),
    path.join(stageDir, "cmd"),
    path.join(stageDir, "usr", "bin"),
    path.join(stageDir, "mingw64", "bin"),
  ].filter((entry, index, all) => fs.existsSync(entry) && all.indexOf(entry) === index);
  const output = runCapture(git, ["--version"], {
    env: { PATH: [...pathEntries, process.env.PATH || ""].join(path.delimiter) },
  });
  const detected = output.match(/git version\s+([^\s]+)/i)?.[1] || "";
  const resolvedVersion = version || detected;
  if (!resolvedVersion) fail(`could not derive Git version from: ${output}`);
  return resolvedVersion;
}

function buildWebAutomation({ stageDir, platform }) {
  assertCurrentPlatform(platform, "web-automation");
  const playwrightVersion = process.env.LILY_PLAYWRIGHT_VERSION || DEFAULT_VERSIONS.playwright;
  const mcpVersion = process.env.LILY_PLAYWRIGHT_MCP_VERSION || DEFAULT_VERSIONS.playwrightMcp;
  const npmDir = path.join(stageDir, ".npm-stage");
  ensureDir(npmDir);
  fs.writeFileSync(
    path.join(npmDir, "package.json"),
    `${JSON.stringify({ private: true, dependencies: {} }, null, 2)}\n`,
    "utf8",
  );
  run("npm", [
    "install",
    "--omit=dev",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    `playwright@${playwrightVersion}`,
    `@playwright/mcp@${mcpVersion}`,
  ], {
    cwd: npmDir,
    env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });

  fs.renameSync(path.join(npmDir, "node_modules"), path.join(stageDir, "node_modules"));
  rmrf(npmDir);
  ensureDir(path.join(stageDir, "browsers"));
  ensureDir(path.join(stageDir, "bin"));

  run(process.execPath, [path.join(stageDir, "node_modules", "playwright", "cli.js"), "install", "chromium"], {
    env: { PLAYWRIGHT_BROWSERS_PATH: path.join(stageDir, "browsers") },
  });

  const probe = [
    "const { chromium } = require('playwright');",
    "(async()=>{ const b = await chromium.launch({ headless: true }); await b.close(); })().catch(e=>{ console.error(e); process.exit(1); });",
  ].join("\n");
  run(process.execPath, ["-e", probe], {
    env: {
      NODE_PATH: path.join(stageDir, "node_modules"),
      PLAYWRIGHT_BROWSERS_PATH: path.join(stageDir, "browsers"),
    },
  });

  const chromiumDir = fs.readdirSync(path.join(stageDir, "browsers"))
    .find((name) => /^chromium(?:_headless_shell)?-\d+$/.test(name));
  const chromiumRevision = chromiumDir?.match(/-(\d+)$/)?.[1];
  if (!chromiumRevision) fail("Playwright Chromium revision could not be derived after probe");
  return {
    version: `playwright-${playwrightVersion}_mcp-${mcpVersion}`,
    components: {
      playwright: playwrightVersion,
      "@playwright/mcp": mcpVersion,
      chromiumRevision,
    },
  };
}

function buildFfmpeg({ stageDir, platform }) {
  assertCurrentPlatform(platform, "ffmpeg");
  const ffmpegVersion = process.env.LILY_FFMPEG_STATIC_VERSION || DEFAULT_VERSIONS.ffmpegStatic;
  const ffprobeVersion = process.env.LILY_FFPROBE_STATIC_VERSION || DEFAULT_VERSIONS.ffprobeStatic;
  const npmDir = path.join(stageDir, ".npm-stage");
  ensureDir(npmDir);
  fs.writeFileSync(path.join(npmDir, "package.json"), JSON.stringify({ private: true }, null, 2), "utf8");
  run("npm", [
    "install",
    "--omit=dev",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    `ffmpeg-static@${ffmpegVersion}`,
    `ffprobe-static@${ffprobeVersion}`,
  ], { cwd: npmDir });

  const req = createRequire(path.join(npmDir, "package.json"));
  const ffmpegSrc = req("ffmpeg-static");
  const ffprobeSrc = req("ffprobe-static").path;
  const exe = process.platform === "win32" ? ".exe" : "";
  copyExecutable(ffmpegSrc, path.join(stageDir, "bin", `ffmpeg${exe}`));
  copyExecutable(ffprobeSrc, path.join(stageDir, "bin", `ffprobe${exe}`));
  run(path.join(stageDir, "bin", `ffmpeg${exe}`), ["-version"]);
  run(path.join(stageDir, "bin", `ffprobe${exe}`), ["-version"]);
  rmrf(npmDir);
  return `ffmpeg-static-${ffmpegVersion}_ffprobe-static-${ffprobeVersion}`;
}

function buildPandoc({ stageDir, platform }) {
  const pandocVersion = process.env.LILY_PANDOC_VERSION || DEFAULT_VERSIONS.pandoc;
  const urlFactory = PANDOC_URLS[platform];
  if (!urlFactory) fail(`unsupported pandoc platform: ${platform}`);
  const url = urlFactory(pandocVersion);
  const ext = url.endsWith(".zip") ? ".zip" : ".tar.gz";
  const archive = download(url, path.join(CACHE_DIR, `pandoc-${pandocVersion}-${platform}${ext}`));
  const extractDir = path.join(stageDir, ".extract");
  ensureDir(extractDir);
  if (ext === ".zip") run("unzip", ["-q", archive, "-d", extractDir]);
  else run("tar", ["-xzf", archive, "-C", extractDir]);

  const exeName = platform.startsWith("win32") ? "pandoc.exe" : "pandoc";
  const pandoc = findFile(extractDir, [exeName]);
  if (!pandoc) fail(`pandoc executable not found in ${archive}`);
  copyExecutable(pandoc, path.join(stageDir, "bin", exeName));
  rmrf(extractDir);
  if (platform === detectPlatform()) {
    const versionOut = runCapture(path.join(stageDir, "bin", exeName), ["--version"]);
    if (!versionOut.includes(pandocVersion)) fail(`pandoc probe returned unexpected version: ${versionOut}`);
  } else {
    console.warn(`[publish-runtime-pack] pandoc cross-built for ${platform}; verify on target OS before rollout.`);
  }
  return pandocVersion;
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
    console.log("[publish-runtime-pack] dry-run: skip server registration");
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
    console.log(`[publish-runtime-pack] server registration already exists: ${existing.id}`);
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
  console.log(`[publish-runtime-pack] registered runtime pack: ${json.id}`);
}

async function buildOne(packId, options) {
  const platform = options.platform;
  const outDir = path.resolve(ROOT, options.out || path.join("dist", "runtime-packs"));
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `lily-${packId}-`));
  try {
    let build;
    if (packId === "web-automation") build = buildWebAutomation({ stageDir, platform });
    else if (packId === "ffmpeg") build = buildFfmpeg({ stageDir, platform });
    else if (packId === "pandoc") build = buildPandoc({ stageDir, platform });
    else if (packId === "git") build = buildGit({ stageDir, platform, source: options.source, version: options.version });
    else fail(`unsupported pack: ${packId}`);
    const version = typeof build === "string" ? build : build.version;
    const components = typeof build === "object" ? build.components : undefined;

    const fileName = `${packId}-${platform}-${version}.tar.gz`;
    const file = path.join(outDir, fileName);
    packTarGz(stageDir, file);
    const sizeBytes = fs.statSync(file).size;
    const sha256 = sha256File(file);
    const key = `${options.prefix}/${fileName}`;
    const url = joinUrl(options.domain, key);
    const artifact = { packId, platform, version, url, sha256, sizeBytes, file };
    if (platform === detectPlatform()) {
      updateRuntimePackLock({
        ...artifact,
        healthProbe: healthProbeForSpec(PACK_SPECS[packId]),
        components,
      });
      console.log(`[publish-runtime-pack] updated verified lock entry: ${packId}:${platform}`);
    }
    console.log("[publish-runtime-pack] artifact:");
    console.log(JSON.stringify(artifact, null, 2));

    if (options.upload) {
      run("node", ["scripts/release-admin.mjs", "upload", "--bucket", options.bucket, "--key", key, "--file", file], {
        dryRun: options.dryRun,
      });
    }
    if (options.register) await registerPack({ api: options.api, artifact, dryRun: options.dryRun });
    return artifact;
  } finally {
    rmrf(stageDir);
  }
}

const args = parseArgs(process.argv.slice(2));
const pack = args.pack || usage();
const packs = pack === "all" ? ["web-automation", "ffmpeg", "pandoc"] : [pack];
const platform = args.platform || detectPlatform();
const options = {
  platform,
  out: args.out,
  upload: Boolean(args.upload),
  register: Boolean(args.register),
  dryRun: Boolean(args["dry-run"]),
  bucket: args.bucket || DEFAULT_BUCKET,
  domain: args.domain || DEFAULT_DOMAIN,
  prefix: String(args.prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, ""),
  api: String(args.api || DEFAULT_API).replace(/\/+$/g, ""),
  source: args.source || "",
  version: args.version || "",
};

ensureDir(CACHE_DIR);
const results = [];
for (const packId of packs) {
  // eslint-disable-next-line no-await-in-loop
  results.push(await buildOne(packId, options));
}
console.log("[publish-runtime-pack] done:");
console.log(JSON.stringify(results, null, 2));
