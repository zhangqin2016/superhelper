"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MAX_PATH_ENTRIES = 96;
const MAX_PATH_VALUE_CHARS = 32_768;
const LOGIN_SHELL_TIMEOUT_MS = 1_500;
const PATH_MARKER = "__LILY_EXECUTABLE_PATH__";
const FAILED_DISCOVERY_CACHE_MS = 30_000;
let loginShellCache = null;

function splitPathValue(value, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return String(value || "").split(delimiter);
}

function directoryExists(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function sanitizeExecutablePathEntries(entries = [], options = {}) {
  const platform = options.platform || process.platform;
  const isDirectory = options.isDirectory || directoryExists;
  const seen = new Set();
  const result = [];

  for (const raw of entries) {
    const candidate = String(raw || "").trim();
    if (!candidate || candidate.length > 4_096 || !path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key) || !isDirectory(normalized)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= MAX_PATH_ENTRIES) break;
  }
  return result;
}

function platformPathCandidates({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "win32") {
    const winRoot = env.WINDIR || env.SYSTEMROOT || "C:\\Windows";
    return [
      path.win32.join(winRoot, "System32"),
      path.win32.join(winRoot, "System32", "WindowsPowerShell", "v1.0"),
      path.win32.join(winRoot, "System32", "Wbem"),
      ...splitPathValue(env.PATH, platform),
    ];
  }

  const common = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  if (platform === "darwin") {
    return [
      ...common,
      "/opt/homebrew/bin", "/opt/homebrew/sbin",
      "/usr/local/bin", "/usr/local/sbin",
      "/opt/local/bin", "/opt/local/sbin",
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".npm-global", "bin"),
      path.join(home, "go", "bin"),
      ...splitPathValue(env.PATH, platform),
    ];
  }

  return [
    ...common,
    "/usr/local/bin", "/usr/local/sbin", "/snap/bin",
    "/var/lib/flatpak/exports/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".nix-profile", "bin"),
    "/nix/var/nix/profiles/default/bin",
    ...splitPathValue(env.PATH, platform),
  ];
}

function loginShellPathEntries(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") return [];
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const run = options.spawnSync || spawnSync;
  const requestedShell = String(env.SHELL || "").trim();
  const shell = path.isAbsolute(requestedShell) && fs.existsSync(requestedShell)
    ? requestedShell
    : platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  if (!fs.existsSync(shell)) return [];
  const cacheKey = [platform, home, shell, env.PATH || ""].join("\u0000");
  if (loginShellCache?.key === cacheKey && loginShellCache.expiresAt > Date.now()) {
    return [...loginShellCache.entries];
  }

  try {
    const result = run(shell, ["-ilc", `printf '${PATH_MARKER}%s\\n' "$PATH"`], {
      cwd: home,
      env: {
        HOME: home,
        USER: env.USER || "",
        LOGNAME: env.LOGNAME || env.USER || "",
        SHELL: shell,
        PATH: env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: env.LANG || "C.UTF-8",
        TERM: "dumb",
      },
      encoding: "utf8",
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const output = String(result?.stdout || "");
    const markedLines = output.split(/\r?\n/).filter((item) => item.startsWith(PATH_MARKER));
    const line = markedLines[markedLines.length - 1];
    const value = line ? line.slice(PATH_MARKER.length, PATH_MARKER.length + MAX_PATH_VALUE_CHARS) : "";
    const entries = splitPathValue(value, platform);
    loginShellCache = {
      key: cacheKey,
      entries,
      expiresAt: value ? Number.POSITIVE_INFINITY : Date.now() + FAILED_DISCOVERY_CACHE_MS,
    };
    return [...entries];
  } catch {
    loginShellCache = { key: cacheKey, entries: [], expiresAt: Date.now() + FAILED_DISCOVERY_CACHE_MS };
    return [];
  }
}

function discoverHostExecutablePaths(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  return sanitizeExecutablePathEntries([
    ...platformPathCandidates({ platform, home, env }),
    ...loginShellPathEntries({ ...options, platform, home, env }),
  ], { platform, isDirectory: options.isDirectory });
}

module.exports = {
  discoverHostExecutablePaths,
  loginShellPathEntries,
  platformPathCandidates,
  sanitizeExecutablePathEntries,
  splitPathValue,
};
