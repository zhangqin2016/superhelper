"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const {
  PROJECT_ROOT,
  agentBinDir,
  agentConfigDir,
  installedCliBasename,
  legacyInstalledCliBasenames,
} = require("./config");
const {
  runDataMigrations,
  migrateSettingsEnvKeys,
  migrateLegacyGuideFile,
} = require("./data-migration");
const {
  platformBundleKeys,
  platformBundleKey,
  findBundledCliSource,
} = require("./bundle-locator");
const { getLogger } = require("./logger");
const log = getLogger("agent-bootstrap");

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
        log.warn("xattr cleanup failed (non-critical)");
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
      log.warn("legacy cli removal failed", legacy);
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
  const target = installedCliPath();
  const source = findBundledCliSource();

  const migrated = migrateLegacyInstalledCli();
  if (migrated) {
    if (source) copyCliIfNeeded(source, migrated);
    return migrated;
  }

  if (source) {
    const copyResult = copyCliIfNeeded(source, target);
    if (copyResult.ok) {
      removeLegacyInstalledCli();
      return target;
    }
  }

  if (fs.existsSync(target)) {
    removeLegacyInstalledCli();
    return target;
  }

  return null;
}

function bootstrapAgent() {
  runDataMigrations();

  ensureDir(agentConfigDir());
  ensureDir(agentBinDir());
  ensureDir(require("./learned-skills").learnedSkillsInboxDir());

  const { ensureRuntimeNodeShim } = require("./runtime-node");
  ensureRuntimeNodeShim();

  const { installAgentDefaults } = require("./agent-settings");
  const agentDefaults = installAgentDefaults();

  // Post-edit verification hook: the engine syntax-checks every file it
  // edits and feeds failures back to the model (self-correction loop).
  try {
    const { ensureVerificationHooks } = require("./verification-hooks");
    const { resolveRuntimeNodePath } = require("./runtime-node");
    const hookScript = [
      path.join(process.resourcesPath || "", "resources/hooks/verify-edit.cjs"),
      path.join(PROJECT_ROOT, "resources/hooks/verify-edit.cjs"),
    ].find((p) => fs.existsSync(p));
    ensureVerificationHooks({
      settingsPath: path.join(agentConfigDir(), "settings.json"),
      nodePath: resolveRuntimeNodePath(),
      scriptPath: hookScript,
    });
  } catch (err) {
    log.warn("verification hook install failed: %s", err?.message || err);
  }
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
        message: "Using installed assistant engine",
        agentDefaults,
      };
    }
    if (!app.isPackaged && process.env.DEV_USE_SYSTEM_AGENT === "1") {
      return {
        ok: true,
        mode: "dev-system",
        cliPath: null,
        message: "Dev mode: will attempt to use system assistant CLI (config and skills written to app directory)",
        agentDefaults,
      };
    }
    return {
      ok: false,
      mode: "missing-bundle",
      cliPath: null,
      error: "Built-in assistant engine not found. Please verify the installation package contains a bundles/ directory, or contact your administrator.",
      agentDefaults,
    };
  }

  const copyResult = copyCliIfNeeded(source, target);
  if (!copyResult.ok) {
    return {
      ok: false,
      mode: "copy-failed",
      cliPath: null,
      error: "Assistant engine installation failed. Please restart the application.",
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
