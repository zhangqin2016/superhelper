"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const {
  PROJECT_ROOT,
  agentBinDir,
  agentConfigDir,
  bundledCliBasename,
  installedCliBasename,
  legacyInstalledCliBasenames,
  legacyBundledCliBasenames,
} = require("./config");
const { runDataMigrations } = require("./data-migration");

/** Platform keys to search for bundled CLI (order matters). */
function platformBundleKeys() {
  if (process.platform === "darwin") {
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
  const names = [bundledCliBasename(), ...legacyBundledCliBasenames()];
  const paths = [];
  const resourcesPath =
    typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  for (const key of platformBundleKeys()) {
    for (const name of names) {
      if (resourcesPath) {
        paths.push(path.join(resourcesPath, "bundles", key, name));
      }
      paths.push(path.join(PROJECT_ROOT, "bundles", key, name));
    }
  }
  return paths;
}

function installedCliPath() {
  return path.join(agentBinDir(), installedCliBasename());
}

function legacyInstalledCliPaths() {
  const target = installedCliPath();
  const binDir = agentBinDir();
  const legacyDirs = ["claude-bin", binDir];
  const paths = [];
  for (const dir of legacyDirs) {
    for (const name of legacyInstalledCliBasenames()) {
      const legacy = path.join(
        dir === binDir ? binDir : path.join(require("./config").userDataPath(), dir),
        name,
      );
      if (legacy !== target) paths.push(legacy);
    }
  }
  return paths;
}

function findLegacyInstalledCli() {
  for (const legacy of legacyInstalledCliPaths()) {
    if (fs.existsSync(legacy)) return legacy;
  }
  return null;
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

function removeLegacyInstalledCli() {
  for (const legacy of legacyInstalledCliPaths()) {
    if (!fs.existsSync(legacy)) continue;
    try {
      fs.unlinkSync(legacy);
    } catch {
      // ignore
    }
  }
}

function migrateLegacyInstalledCli() {
  const target = installedCliPath();
  if (fs.existsSync(target)) return target;

  const legacy = findLegacyInstalledCli();
  if (!legacy) return null;

  ensureDir(path.dirname(target));
  try {
    fs.renameSync(legacy, target);
    removeLegacyInstalledCli();
    return target;
  } catch {
    const copyResult = copyCliIfNeeded(legacy, target);
    if (copyResult.ok) {
      removeLegacyInstalledCli();
      return target;
    }
  }
  return null;
}

function ensureBundledCliInstalled() {
  const migrated = migrateLegacyInstalledCli();
  if (migrated) return migrated;

  const target = installedCliPath();
  if (fs.existsSync(target)) {
    removeLegacyInstalledCli();
    return target;
  }

  const source = findBundledCliSource();
  if (!source) return null;

  const copyResult = copyCliIfNeeded(source, target);
  if (!copyResult.ok) {
    return fs.existsSync(target) ? target : null;
  }
  removeLegacyInstalledCli();
  return target;
}

function bootstrapAgent() {
  runDataMigrations();

  ensureDir(agentConfigDir());
  ensureDir(agentBinDir());

  const { ensureRuntimeNodeShim } = require("./runtime-node");
  ensureRuntimeNodeShim();

  const { installAgentDefaults } = require("./agent-settings");
  const agentDefaults = installAgentDefaults();
  const { migrateSettingsEnvKeys, migrateLegacyGuideFile } = require("./data-migration");
  migrateSettingsEnvKeys();
  migrateLegacyGuideFile();

  const source = findBundledCliSource();
  const target = installedCliPath();

  if (!source) {
    const migrated = migrateLegacyInstalledCli();
    if (migrated || fs.existsSync(target)) {
      removeLegacyInstalledCli();
      return {
        ok: true,
        mode: "installed",
        cliPath: migrated || target,
        message: "使用已安装的助手引擎",
        agentDefaults,
      };
    }
    if (!app.isPackaged && process.env.DEV_USE_SYSTEM_AGENT === "1") {
      return {
        ok: true,
        mode: "dev-system",
        cliPath: null,
        message: "开发模式：将尝试使用本机助手 CLI（配置与 skill 已写入应用目录）",
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
  removeLegacyInstalledCli();

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
  legacyInstalledCliPaths,
  platformBundleKey,
  platformBundleKeys,
};
