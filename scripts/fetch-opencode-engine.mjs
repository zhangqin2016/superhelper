#!/usr/bin/env node
/**
 * Fetch the prebuilt OpenCode engine binary (npm package `opencode-ai`) and place
 * it where bundle-locator.findBundledOpencodeBinary() looks:
 *   bundles/<platform-key>/opencode/bin/opencode
 *
 *   node scripts/fetch-opencode-engine.mjs [version] [--platform darwin-arm64]
 *
 * Defaults to the pinned version and the current platform. The npm package ships
 * the platform binary as an optional dep (opencode-<os>-<arch>); we install into
 * a temp dir, then copy the binary into the bundle.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const platIdx = args.indexOf("--platform");
const platArg = platIdx >= 0 ? args[platIdx + 1] : null;
// The positional version arg — but never the value that follows --platform
// (otherwise `--platform darwin-arm64` is misread as version "darwin-arm64").
const version = args.find((a, i) => !a.startsWith("--") && i !== platIdx + 1) || "1.17.13";

// Map our bundle platform key -> the opencode-ai optional-dep package name.
const KEY_TO_PKG = {
  "darwin-arm64": "opencode-darwin-arm64",
  "darwin-x64": "opencode-darwin-x64",
  "linux-x64": "opencode-linux-x64",
  "win32-x64": "opencode-windows-x64",
};
function currentKey() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "win32") return "win32-x64";
  return "linux-x64";
}
const key = platArg || currentKey();
const pkg = KEY_TO_PKG[key];
if (!pkg) { console.error(`Unsupported platform key: ${key}`); process.exit(1); }

const installTimeoutMs = (() => {
  const raw = process.env.OPENCODE_FETCH_INSTALL_TIMEOUT_MS || process.env.LILY_OPENCODE_FETCH_INSTALL_TIMEOUT_MS || "300000";
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 300000;
})();
const copyRetryDelayMs = 500;
const copyRetryAttempts = 12;
const installer = String(process.env.OPENCODE_FETCH_INSTALLER || "auto").toLowerCase();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const bunCommand = process.platform === "win32" ? "bun.cmd" : "bun";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-fetch-"));
console.log(`[fetching opencode-ai@${version} (${key}) ...]`);
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "ocfetch", private: true }));

// Prefer bun (handles cross-platform optional deps cleanly); fall back to npm.
function targetEnv() {
  const [targetOs, targetArch] = key === "win32-x64" ? ["win32", "x64"] : key.split("-");
  return {
    ...process.env,
    npm_config_os: targetOs,
    npm_config_cpu: targetArch,
  };
}

function install(cmd, cmdArgs) {
  console.log(`[install] ${cmd} ${cmdArgs.join(" ")} (timeout ${Math.round(installTimeoutMs / 1000)}s)`);
  const isCmdShim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(cmd);
  const actualCmd = isCmdShim ? (process.env.ComSpec || "cmd.exe") : cmd;
  const actualArgs = isCmdShim ? ["/d", "/s", "/c", cmd, ...cmdArgs] : cmdArgs;
  execFileSync(actualCmd, actualArgs, {
    cwd: tmp,
    stdio: "inherit",
    timeout: installTimeoutMs,
    env: path.basename(cmd).toLowerCase().startsWith("npm") ? targetEnv() : process.env,
  });
}

function installEngine() {
  if (installer === "npm") {
    install(npmCommand, ["install", "--include=optional", `opencode-ai@${version}`]);
    return;
  }
  if (installer === "bun") {
    install(bunCommand, ["add", "--os=*", "--cpu=*", `opencode-ai@${version}`]);
    return;
  }
  if (installer !== "auto") {
    console.warn(`[install] unknown OPENCODE_FETCH_INSTALLER=${installer}; using auto`);
  }
  try {
    install(bunCommand, ["add", "--os=*", "--cpu=*", `opencode-ai@${version}`]);
  } catch (err) {
    console.warn(`[install] bun failed or timed out; falling back to npm: ${err?.message || err}`);
    install(npmCommand, ["install", "--include=optional", `opencode-ai@${version}`]);
  }
}
installEngine();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function copyBinaryWithRetry(src, dest) {
  let lastError = null;
  for (let attempt = 1; attempt <= copyRetryAttempts; attempt += 1) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (err) {
      lastError = err;
      if (!["EBUSY", "EPERM", "EACCES"].includes(err?.code) || attempt === copyRetryAttempts) break;
      console.warn(
        `[copy] ${err.code} while writing ${path.relative(repoRoot, dest)}; retry ${attempt}/${copyRetryAttempts - 1}`,
      );
      sleepSync(copyRetryDelayMs);
    }
  }
  throw lastError;
}

const exe = key.startsWith("win32") ? "opencode.exe" : "opencode";
const srcCandidates = [
  path.join(tmp, "node_modules", pkg, "bin", exe),
  path.join(tmp, "node_modules", pkg, "bin", "opencode"),
];
const src = srcCandidates.find((p) => fs.existsSync(p));
if (!src) { console.error(`binary not found for ${pkg}; looked in:\n  ${srcCandidates.join("\n  ")}`); process.exit(1); }

const destDir = path.join(repoRoot, "bundles", key, "opencode", "bin");
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, exe);
copyBinaryWithRetry(src, dest);
fs.chmodSync(dest, 0o755);
fs.rmSync(tmp, { recursive: true, force: true });

// macOS: the opencode binary is bun "linker-signed" ad-hoc but WITHOUT entitlements.
// On Apple Silicon a signed binary that JITs — which `opencode serve` does — is
// SIGKILLed by the kernel ("Code Signature Invalid") unless its signature carries
// com.apple.security.cs.allow-jit. `opencode --version` survives (barely JITs),
// `serve` dies — surfacing in the app as "engine stopped unexpectedly (code null)".
// Re-sign with our entitlements so the engine actually starts. Dev runs use this
// binary directly; packaging (dist-mac.sh) re-signs again with the app identity.
if (key.startsWith("darwin") && process.platform === "darwin") {
  const entitlements = path.join(repoRoot, "build", "entitlements.mac.inherit.plist");
  try {
    execFileSync(
      "codesign",
      ["--force", "--options", "runtime", "--entitlements", entitlements, "--sign", "-", dest],
      { stdio: "inherit" },
    );
    execFileSync("codesign", ["--verify", "--strict", dest], { stdio: "inherit" });
    console.log("[codesign] engine re-signed with allow-jit entitlements");
  } catch (err) {
    console.warn(
      `[codesign] WARNING: could not sign the engine — on Apple Silicon it may be SIGKILLed at startup. ${err?.message || err}`,
    );
  }
}

console.log(`[done] ${path.relative(repoRoot, dest)}`);
