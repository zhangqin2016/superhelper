#!/usr/bin/env node
//
// Build an optional runtime-pack artifact for upload to the CDN (Qiniu).
//
// What it does, for one pack + platform:
//   1. uv pip install --target <stage>  (the pack's requirements, into a flat
//      dir suitable for PYTHONPATH — same layout the app extracts to)
//   2. verify the pack's import probe against that dir
//   3. tar.gz the dir, compute sha256 + size, derive the version
//   4. print the metadata to register via POST /api/admin/runtime-packs
//
// Cross-platform note: heavy ML wheels (torch) are platform-specific, so build
// each platform's artifact ON that platform (or wire uv's --python-platform).
// This script defaults to the current platform and refuses if its bundle/uv is
// absent rather than producing a silently-wrong artifact.
//
// Usage:
//   node scripts/build-runtime-pack.mjs --pack pro-pdf [--platform darwin-arm64]
//        [--version 2.x] [--out dist/runtime-packs]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { PACK_SPECS } = require(path.join(ROOT, "src/main/runtime-pack-specs.js"));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith("--")) args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function detectPlatform() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  const plat =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  return `${plat}-${arch}`;
}

function die(message) {
  console.error(`[build-runtime-pack] ${message}`);
  process.exit(1);
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Derive the artifact version from the main package's dist-info in the stage. */
function deriveVersion(stageDir, mainPackage) {
  const norm = mainPackage.replace(/[-_.]+/g, "_").toLowerCase();
  const hit = fs
    .readdirSync(stageDir)
    .find((name) => /\.dist-info$/.test(name) && name.replace(/[-_.]+/g, "_").toLowerCase().startsWith(`${norm}_`));
  if (!hit) return null;
  const match = hit.replace(/\.dist-info$/, "").match(/-([0-9][^-]*)$/) || hit.match(/_([0-9][^_]*)\.dist-info$/);
  return match ? match[1] : null;
}

const args = parseArgs(process.argv.slice(2));
const packId = args.pack;
if (!packId) die("missing --pack <id> (e.g. pro-pdf)");
const spec = PACK_SPECS[packId];
if (!spec) die(`unknown pack '${packId}'. Known: ${Object.keys(PACK_SPECS).join(", ")}`);
if (!Array.isArray(spec.requirements) || spec.requirements.length === 0 || !spec.probe) {
  die(`pack '${packId}' is artifact-only (${spec.installKind || "native"}); use its dedicated build/publish pipeline, not the Python target builder`);
}

const platform = args.platform || detectPlatform();
// uv's --python-platform target for cross-builds (wheel-only, no execution).
const UV_PYTHON_PLATFORM = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
};
const PY_VERSION = "3.12"; // matches the bundled runtime

const cross = platform !== detectPlatform();
// uv is the host's bundled binary either way — it resolves for any platform.
const hostRoot = path.join(ROOT, "bundles", detectPlatform(), "runtime");
const uv = path.join(hostRoot, "bin", "uv");
const venvPython = path.join(hostRoot, "venv", "bin", "python3");
if (!fs.existsSync(uv)) die(`bundled uv not found at ${uv} — build the runtime bundle first`);
if (cross && !UV_PYTHON_PLATFORM[platform]) die(`no cross-build mapping for platform ${platform}`);
if (!cross && !fs.existsSync(venvPython)) die(`bundled venv python not found at ${venvPython}`);

const outDir = path.resolve(ROOT, args.out || path.join("dist", "runtime-packs"));
fs.mkdirSync(outDir, { recursive: true });
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `rpack-${packId}-`));

try {
  if (cross) {
    // Cross-build: download the target platform's wheels (no install/run). Every
    // dep must ship a wheel for the target (--only-binary), else this errors —
    // which is the right behavior, not a silently-wrong artifact.
    console.log(`[build-runtime-pack] cross-building ${platform} (uv --python-platform ${UV_PYTHON_PLATFORM[platform]})`);
    execFileSync(
      uv,
      [
        "pip", "install", "--target", stageDir,
        "--python-version", PY_VERSION,
        "--python-platform", UV_PYTHON_PLATFORM[platform],
        "--only-binary=:all:",
        ...spec.requirements,
      ],
      { stdio: "inherit" },
    );
    console.warn(`[build-runtime-pack] NOTE: cross-built artifact NOT probe-verified on ${detectPlatform()} — verify on a real ${platform} host.`);
  } else {
    console.log(`[build-runtime-pack] installing ${spec.requirements.join(" ")} → ${stageDir}`);
    execFileSync(uv, ["pip", "install", "--python", venvPython, "--target", stageDir, ...spec.requirements], {
      stdio: "inherit",
    });
    console.log(`[build-runtime-pack] verifying probe: ${spec.probe}`);
    execFileSync(venvPython, ["-c", spec.probe], {
      stdio: "inherit",
      env: { ...process.env, PYTHONPATH: [stageDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    });
  }

  const mainPackage = spec.requirements[0].split(/[<>=!~ ]/)[0];
  const version = args.version || deriveVersion(stageDir, mainPackage) || "0.0.0";

  const fileName = `${packId}-${platform}-${version}.tar.gz`;
  const outFile = path.join(outDir, fileName);
  console.log(`[build-runtime-pack] packing → ${outFile}`);
  // -C stageDir . : archive contents at the root, so the app extracts a flat
  // PYTHONPATH dir (matching runtime-packs.js extraction).
  execFileSync("tar", ["-czf", outFile, "-C", stageDir, "."], { stdio: "inherit" });

  const sizeBytes = fs.statSync(outFile).size;
  const sha256 = sha256File(outFile);

  const metadata = { packId, platform, version, sha256, sizeBytes, file: outFile };
  console.log("\n[build-runtime-pack] artifact ready:");
  console.log(JSON.stringify(metadata, null, 2));
  console.log(
    [
      "",
      "Next steps:",
      `  1. Upload ${fileName} to the CDN (Qiniu) and note its public URL.`,
      "  2. Register it so the app can resolve it (admin auth required):",
      "     POST /api/admin/runtime-packs",
      `     ${JSON.stringify({ packId, platform, version, url: "<qiniu-public-url>", sha256, sizeBytes })}`,
      "",
    ].join("\n"),
  );
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
