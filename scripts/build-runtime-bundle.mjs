#!/usr/bin/env node
/**
 * Build bundles/<platform>/runtime: Python 3.12 + uv + venv (common packages) + LibreOffice.
 *
 * Usage:
 *   node scripts/build-runtime-bundle.mjs
 *   node scripts/build-runtime-bundle.mjs --platform darwin-arm64
 *   node scripts/build-runtime-bundle.mjs --skip-libreoffice
 *
 * Requires: curl, tar, unzip; macOS also uses hdiutil for LibreOffice .dmg.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REQUIREMENTS = path.join(ROOT, "resources/runtime/requirements-runtime.txt");
const CACHE_DIR = path.join(ROOT, ".cache/runtime-build");
const PYTHON_VERSION = "3.12";
const UV_VERSION = "0.6.14";

const LO_VERSION = "25.8.7";
const LO_URLS = {
  "darwin-arm64": `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/mac/aarch64/LibreOffice_${LO_VERSION}_MacOS_aarch64.dmg`,
  "darwin-x64": `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/mac/x86_64/LibreOffice_${LO_VERSION}_MacOS_x86-64.dmg`,
  "linux-x64": `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/deb/x86_64/LibreOffice_${LO_VERSION}_Linux_x86-64_deb.tar.gz`,
  "win32-x64": `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/win/x86_64/LibreOffice_${LO_VERSION}_Win_x86-64.msi`,
};

const UV_RELEASE = {
  "darwin-arm64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
  "darwin-x64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-apple-darwin.tar.gz`,
  "linux-x64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`,
  "win32-x64": `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
};

function parseArgs(argv) {
  const out = {
    platform: detectPlatform(),
    skipLibreOffice: false,
    libreOfficeOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--platform" && argv[i + 1]) {
      out.platform = argv[++i];
    } else if (argv[i] === "--skip-libreoffice") {
      out.skipLibreOffice = true;
    } else if (argv[i] === "--libreoffice-only") {
      out.libreOfficeOnly = true;
    }
  }
  return out;
}

function detectPlatform() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (process.platform === "win32") return "win32-x64";
  return "linux-x64";
}

function log(msg) {
  console.log(`[runtime-build] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd,
    shell: opts.shell ?? false,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
}

function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function validateArchiveSize(filePath, minBytes, label) {
  const size = fs.statSync(filePath).size;
  if (size < minBytes) {
    throw new Error(`${label} too small (${size} bytes) — mirror may have returned HTML`);
  }
}

async function download(url, dest) {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) {
    log(`cache hit ${path.basename(dest)}`);
    return dest;
  }
  log(`download ${url}`);
  run("curl", ["-fSL", "--retry", "3", "-o", dest, url]);
  return dest;
}

function findUvBinary(extractDir) {
  const names = process.platform === "win32" ? ["uv.exe"] : ["uv"];
  for (const name of names) {
    const direct = path.join(extractDir, name);
    if (fs.existsSync(direct)) return direct;
  }
  const stack = [extractDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name === "uv" || ent.name === "uv.exe") return full;
    }
  }
  throw new Error(`uv binary not found under ${extractDir}`);
}

async function installUv(platform, runtimeRoot) {
  const binDir = path.join(runtimeRoot, "bin");
  ensureDir(binDir);
  const url = UV_RELEASE[platform];
  if (!url) throw new Error(`No uv release for ${platform}`);

  const archive = path.join(CACHE_DIR, `uv-${platform}${url.endsWith(".zip") ? ".zip" : ".tar.gz"}`);
  await download(url, archive);
  const extractDir = path.join(CACHE_DIR, `uv-extract-${platform}`);
  rmrf(extractDir);
  ensureDir(extractDir);

  if (archive.endsWith(".zip")) {
    run("unzip", ["-q", archive, "-d", extractDir]);
  } else {
    run("tar", ["-xzf", archive, "-C", extractDir]);
  }

  const uvSrc = findUvBinary(extractDir);
  const uvDest = path.join(binDir, process.platform === "win32" ? "uv.exe" : "uv");
  fs.copyFileSync(uvSrc, uvDest);
  if (process.platform !== "win32") fs.chmodSync(uvDest, 0o755);
  return uvDest;
}

function findPythonExecutable(pythonRoot) {
  const binDirs = [];
  const stack = [pythonRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "bin") binDirs.push(full);
        else stack.push(full);
      }
    }
  }
  const names =
    process.platform === "win32"
      ? ["python.exe", "python3.exe", "python3.12.exe"]
      : ["python3.12", "python3", "python"];
  for (const binDir of binDirs) {
    for (const name of names) {
      const candidate = path.join(binDir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Python executable not found under ${pythonRoot}`);
}

async function installPythonAndVenv(uvPath, platform, runtimeRoot) {
  const pythonRoot = path.join(runtimeRoot, "python");
  const venvDir = path.join(runtimeRoot, "venv");
  rmrf(pythonRoot);
  rmrf(venvDir);
  ensureDir(pythonRoot);

  run(uvPath, ["python", "install", PYTHON_VERSION], {
    env: {
      UV_PYTHON_INSTALL_DIR: pythonRoot,
    },
  });

  const pythonExe = findPythonExecutable(pythonRoot);
  log(`python at ${pythonExe}`);

  run(uvPath, ["venv", venvDir, "--python", pythonExe]);
  const venvPython =
    process.platform === "win32"
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python3");

  run(uvPath, [
    "pip",
    "install",
    "--python",
    venvPython,
    "-r",
    REQUIREMENTS,
  ]);

  return { pythonExe, venvPython };
}

function writeShims(runtimeRoot, venvPython, platform) {
  const binDir = path.join(runtimeRoot, "bin");
  ensureDir(binDir);

  if (process.platform === "win32") {
    for (const name of ["python.exe", "python3.exe"]) {
      const bat = `@echo off\r\n"${venvPython}" %*\r\n`;
      fs.writeFileSync(path.join(binDir, name), bat);
    }
    return;
  }

  const absExec = venvPython;
  for (const name of ["python", "python3"]) {
    const content = `#!/bin/sh\nexec "${absExec}" "$@"\n`;
    const shimPath = path.join(binDir, name);
    fs.writeFileSync(shimPath, content);
    fs.chmodSync(shimPath, 0o755);
  }
}

function writeSofficeShim(runtimeRoot, platform) {
  const binDir = path.join(runtimeRoot, "bin");
  const loRoot = path.join(runtimeRoot, "libreoffice");

  let realSoffice = null;
  if (platform.startsWith("darwin")) {
    realSoffice = path.join(loRoot, "LibreOffice.app", "Contents", "MacOS", "soffice");
  } else if (platform === "win32-x64") {
    realSoffice = path.join(loRoot, "program", "soffice.exe");
    if (!fs.existsSync(realSoffice)) {
      realSoffice = path.join(loRoot, "Program", "soffice.exe");
    }
  } else {
    realSoffice = path.join(loRoot, "program", "soffice");
    if (!fs.existsSync(realSoffice)) {
      const usrLib = path.join(loRoot, "usr-lib", "program", "soffice");
      if (fs.existsSync(usrLib)) realSoffice = usrLib;
    }
    if (!fs.existsSync(realSoffice)) {
      const opt = path.join(loRoot, "opt", "libreoffice", "program", "soffice");
      if (fs.existsSync(opt)) realSoffice = opt;
    }
  }

  if (!realSoffice || !fs.existsSync(realSoffice)) return;

  const shimPath = path.join(binDir, process.platform === "win32" ? "soffice.cmd" : "soffice");
  if (process.platform === "win32") {
    fs.writeFileSync(shimPath, `@echo off\r\n"${realSoffice}" %*\r\n`);
  } else {
    let content = `#!/bin/sh\n`;
    if (platform.startsWith("darwin")) {
      const uno = path.join(loRoot, "LibreOffice.app", "Contents", "Resources");
      content += `export UNO_PATH="${uno}"\n`;
    }
    content += `exec "${realSoffice}" "$@"\n`;
    fs.writeFileSync(shimPath, content);
    fs.chmodSync(shimPath, 0o755);
  }
}

async function installLibreOffice(platform, runtimeRoot) {
  const url = LO_URLS[platform];
  if (!url) throw new Error(`No LibreOffice URL for ${platform}`);

  const loDest = path.join(runtimeRoot, "libreoffice");
  rmrf(loDest);
  ensureDir(loDest);

  let archive = null;
  if (!platform.startsWith("darwin") || !fs.existsSync("/Applications/LibreOffice.app")) {
    archive = path.join(CACHE_DIR, `lo-${platform}-${LO_VERSION}${path.extname(url)}`);
    await download(url, archive);
  }

  if (platform.startsWith("darwin")) {
    const systemApp = "/Applications/LibreOffice.app";
    if (fs.existsSync(systemApp)) {
      log(`copy LibreOffice from ${systemApp}`);
      run("cp", ["-R", systemApp, loDest]);
    } else if (archive) {
      const mountPoint = path.join(CACHE_DIR, "lo-mount");
      rmrf(mountPoint);
      ensureDir(mountPoint);
      validateArchiveSize(archive, 50_000_000, "LibreOffice DMG");
      run("hdiutil", ["attach", archive, "-nobrowse", "-mountpoint", mountPoint]);
      try {
        const appSrc = path.join(mountPoint, "LibreOffice.app");
        if (!fs.existsSync(appSrc)) throw new Error("LibreOffice.app not found in DMG");
        run("cp", ["-R", appSrc, loDest]);
      } finally {
        run("hdiutil", ["detach", mountPoint, "-quiet"]);
      }
    } else {
      throw new Error("LibreOffice.app not found and DMG download unavailable");
    }
  } else if (platform === "linux-x64") {
    if (!archive) throw new Error("LibreOffice archive missing");
    const systemLo = "/usr/lib/libreoffice";
    const systemSoffice = "/usr/bin/soffice";
    if (fs.existsSync(systemLo) && fs.existsSync(systemSoffice)) {
      const target = path.join(loDest, "usr-lib");
      run("cp", ["-a", systemLo, target]);
    } else {
      throw new Error(
        "Linux LibreOffice: install system package first (apt install libreoffice) or build on CI with LO preinstalled",
      );
    }
  } else if (platform === "win32-x64") {
    const extractDir = path.join(loDest, "msi-extract");
    ensureDir(extractDir);
    run("msiexec", ["/a", archive, "/qb", `TARGETDIR=${extractDir}`]);
    const programSrc = path.join(extractDir, "PFiles", "LibreOffice", "program");
    if (!fs.existsSync(programSrc)) {
      throw new Error(`LibreOffice program dir not found after MSI extract: ${programSrc}`);
    }
    run("xcopy", [programSrc, path.join(loDest, "program"), "/E", "/I", "/Y"], { shell: true });
  }

  writeSofficeShim(runtimeRoot, platform);
  log(`LibreOffice installed under ${loDest}`);
}

function writeManifest(runtimeRoot, platform, meta) {
  const manifest = {
    platform,
    python: PYTHON_VERSION,
    uv: UV_VERSION,
    libreoffice: meta.libreoffice ? LO_VERSION : null,
    builtAt: new Date().toISOString(),
    requirementsHash: createHash("sha256")
      .update(fs.readFileSync(REQUIREMENTS))
      .digest("hex")
      .slice(0, 16),
  };
  fs.writeFileSync(
    path.join(runtimeRoot, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { platform, skipLibreOffice, libreOfficeOnly } = args;

  if (!UV_RELEASE[platform]) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const runtimeRoot = path.join(ROOT, "bundles", platform, "runtime");
  ensureDir(CACHE_DIR);
  ensureDir(runtimeRoot);

  log(`platform=${platform} dest=${runtimeRoot}`);

  let uvPath = path.join(runtimeBinDir(runtimeRoot), process.platform === "win32" ? "uv.exe" : "uv");
  let venvPython =
    process.platform === "win32"
      ? path.join(runtimeRoot, "venv", "Scripts", "python.exe")
      : path.join(runtimeRoot, "venv", "bin", "python3");

  if (!libreOfficeOnly) {
    uvPath = await installUv(platform, runtimeRoot);
    ({ venvPython } = await installPythonAndVenv(uvPath, platform, runtimeRoot));
    writeShims(runtimeRoot, venvPython, platform);
  } else if (!fs.existsSync(venvPython)) {
    throw new Error("--libreoffice-only requires an existing venv; run full build first");
  }

  let hasLo = false;
  if (!skipLibreOffice) {
    try {
      await installLibreOffice(platform, runtimeRoot);
      hasLo = true;
    } catch (err) {
      console.warn(`[runtime-build] LibreOffice install failed (continuing): ${err.message}`);
    }
  }

  writeManifest(runtimeRoot, platform, { libreoffice: hasLo });
  log("done");
}

function runtimeBinDir(runtimeRoot) {
  return path.join(runtimeRoot, "bin");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
