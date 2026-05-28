"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { app } = require("electron");
const { PROJECT_ROOT, userDataPath } = require("./config");

function cliBinaryName() {
  return process.platform === "win32" ? "claude.exe" : "claude";
}

/** Platform keys to search for bundled CLI (order matters). */
function platformBundleKeys() {
  if (process.platform === "darwin") {
    // Rosetta/x64 Electron on Apple Silicon still ships arm64 CLI in darwin-arm64/.
    if (process.arch === "arm64") return ["darwin-arm64", "darwin-x64"];
    return ["darwin-x64", "darwin-arm64"];
  }
  if (process.platform === "win32") return ["win32-x64"];
  return ["linux-x64"];
}

function platformBundleKey() {
  return platformBundleKeys()[0];
}

function bundledCliSourceCandidates() {
  const name = cliBinaryName();
  const paths = [];
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  for (const key of platformBundleKeys()) {
    if (resourcesPath) {
      paths.push(path.join(resourcesPath, "bundles", key, name));
    }
    paths.push(path.join(PROJECT_ROOT, "bundles", key, name));
  }
  return paths;
}

function installedCliPath() {
  return path.join(userDataPath("claude-bin"), cliBinaryName());
}

function findBundledCliSource() {
  for (const candidate of bundledCliSourceCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyCliIfNeeded(source, target) {
  ensureDir(path.dirname(target));
  if (!fs.existsSync(source)) {
    return { ok: false, error: "BUNDLE_MISSING" };
  }

  const sourceStat = fs.statSync(source);
  if (fs.existsSync(target)) {
    const targetStat = fs.statSync(target);
    if (
      targetStat.size === sourceStat.size &&
      targetStat.mtimeMs >= sourceStat.mtimeMs
    ) {
      return { ok: true, copied: false };
    }
  }

  fs.copyFileSync(source, target);
  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o755);
    try {
      const { execFileSync } = require("node:child_process");
      execFileSync("xattr", ["-cr", target], { stdio: "ignore" });
    } catch {
      // ignore xattr failures
    }
  }
  return { ok: true, copied: true };
}

/**
 * Copy bundled CLI into userData if needed; return path or null.
 */
function ensureBundledCliInstalled() {
  const target = installedCliPath();
  if (fs.existsSync(target)) return target;

  const source = findBundledCliSource();
  if (!source) return null;

  const copyResult = copyCliIfNeeded(source, target);
  if (!copyResult.ok) {
    return fs.existsSync(target) ? target : null;
  }
  return target;
}

/**
 * Prepare isolated Claude CLI under app userData.
 * Does not touch the user's global ~/.claude or PATH claude.
 */
function bootstrapAgent() {
  ensureDir(userDataPath("claude-config"));
  ensureDir(userDataPath("claude-bin"));

  const { ensureRuntimeNodeShim } = require("./runtime-node");
  ensureRuntimeNodeShim();

  const { installAgentDefaults } = require("./agent-settings");
  const agentDefaults = installAgentDefaults();

  const source = findBundledCliSource();
  const target = installedCliPath();

  if (!source) {
    if (fs.existsSync(target)) {
      return {
        ok: true,
        mode: "installed",
        cliPath: target,
        message: "使用已安装的助手引擎",
        agentDefaults,
      };
    }
    if (!app.isPackaged && process.env.DEV_USE_SYSTEM_CLAUDE === "1") {
      return {
        ok: true,
        mode: "dev-system",
        cliPath: null,
        message: "开发模式：将尝试使用本机 Claude CLI（配置与 skill 已写入应用目录）",
        agentDefaults,
      };
    }
    return {
      ok: false,
      mode: "missing-bundle",
      cliPath: null,
      error: "未找到内置助手引擎。请确认安装包内含 bundles/ 目录，或联系管理员。",
      agentDefaults,
    };
  }

  const copyResult = copyCliIfNeeded(source, target);
  if (!copyResult.ok) {
    return {
      ok: false,
      mode: "copy-failed",
      cliPath: null,
      error: "助手引擎安装失败，请重新启动应用。",
      agentDefaults,
    };
  }

  return {
    ok: true,
    mode: "bundled",
    cliPath: target,
    bundledFrom: source,
    copied: copyResult.copied,
    agentDefaults,
  };
}

function getInstalledCliPath() {
  return ensureBundledCliInstalled();
}

module.exports = {
  bootstrapAgent,
  getInstalledCliPath,
  ensureBundledCliInstalled,
  findBundledCliSource,
  installedCliPath,
  platformBundleKey,
  platformBundleKeys,
};
