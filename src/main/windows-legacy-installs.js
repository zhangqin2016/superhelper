"use strict";

/**
 * Windows legacy-install healing (改名遗留).
 *
 * The product renames (AI Super Terminal / 智能助手 / 智能工作台 → Lily
 * Workbench) changed the NSIS appId (`com.company.ai-super-terminal` →
 * `cn.lilywb.workbench`), so Windows machines keep BOTH products installed
 * side by side. The old binaries pass their local license health check but
 * speak a dead protocol against today's server — users launching a stale
 * shortcut see "authorized but never works" until someone hand-runs an
 * uninstall script.
 *
 * This module lets the CURRENT app heal that: detect legacy installs from the
 * old uninstall registry keys and old per-user install dirs, and (with the
 * user's consent — never silently) run their own uninstallers quietly.
 *
 * FAIL-SAFE: every step is best-effort behind try/catch; detection errors mean
 * "nothing found"; the current install directory is always excluded; nothing
 * is ever deleted directly — only the legacy product's own uninstaller runs.
 */

const path = require("node:path");

/** Old NSIS appIds whose uninstall registry keys identify legacy products. */
const LEGACY_UNINSTALL_APP_IDS = Object.freeze([
  "com.company.ai-super-terminal",
]);

/** Old per-user install dirs (%LOCALAPPDATA%\Programs\<productName>). */
const LEGACY_PRODUCT_DIR_NAMES = Object.freeze([
  "AI Super Terminal",
  "智能助手",
  "智能工作台",
  "ai-super-terminal",
]);

const REGISTRY_ROOTS = Object.freeze([
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
]);

/** Parse `reg query` output into a {valueName: data} map. */
function parseRegQueryOutput(stdout = "") {
  const values = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    // "    UninstallString    REG_SZ    C:\...\Uninstall App.exe"
    const match = line.match(/^\s{2,}(\S[^\s].*?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  return values;
}

function normalizeDir(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
}

function underDir(child, parent) {
  const c = normalizeDir(child);
  const p = normalizeDir(parent);
  return Boolean(c && p && (c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`)));
}

/**
 * Detect legacy installs. Pure given injected deps:
 *  - execRegQuery(keyPath) -> stdout string ("" / throw = not found)
 *  - existsDir(dirPath) -> boolean
 *  - listUninstallers(dirPath) -> array of absolute uninstaller exe paths
 *  - currentExeDir: the RUNNING app's install dir (always excluded)
 *  - localAppData: %LOCALAPPDATA% (skip dir scan when absent)
 */
function detectLegacyInstalls({
  execRegQuery,
  existsDir,
  listUninstallers,
  currentExeDir = "",
  localAppData = "",
} = {}) {
  const found = [];
  const seen = new Set();

  for (const appId of LEGACY_UNINSTALL_APP_IDS) {
    for (const root of REGISTRY_ROOTS) {
      let values = null;
      try {
        const stdout = execRegQuery(`${root}\\${appId}`);
        if (!stdout) continue;
        values = parseRegQueryOutput(stdout);
      } catch {
        continue;
      }
      const uninstall = values.QuietUninstallString || values.UninstallString || "";
      const installLocation = values.InstallLocation || "";
      if (!uninstall) continue;
      if (installLocation && underDir(installLocation, currentExeDir)) continue;
      if (currentExeDir && underDir(uninstall.replace(/^"|"$/g, ""), currentExeDir)) continue;
      const key = `reg:${appId}:${uninstall.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        kind: "registry",
        appId,
        displayName: values.DisplayName || appId,
        installLocation,
        uninstall,
        quiet: Boolean(values.QuietUninstallString),
      });
    }
  }

  if (localAppData) {
    for (const dirName of LEGACY_PRODUCT_DIR_NAMES) {
      const dir = path.win32.join(localAppData, "Programs", dirName);
      try {
        if (!existsDir(dir)) continue;
        if (underDir(dir, currentExeDir) || underDir(currentExeDir, dir)) continue;
        const uninstallers = listUninstallers(dir) || [];
        const key = `dir:${normalizeDir(dir)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          kind: "directory",
          displayName: dirName,
          installLocation: dir,
          uninstall: uninstallers[0] ? `"${uninstallers[0]}"` : "",
          quiet: false,
        });
      } catch {
        // Best effort per directory.
      }
    }
  }

  return found;
}

/** Stable signature so the consent prompt never nags about the same finding. */
function legacyInstallSignature(installs = []) {
  return installs
    .map((item) => `${item.kind}:${(item.installLocation || item.uninstall || "").toLowerCase()}`)
    .sort()
    .join("|");
}

/** Build the silent-uninstall command for a finding ("" = manual cleanup only). */
function silentUninstallCommand(install) {
  const raw = String(install?.uninstall || "").trim();
  if (!raw) return "";
  if (install.quiet) return raw;
  return /\/S(\s|$)/i.test(raw) ? raw : `${raw} /S`;
}

/** Async `reg.exe query` (never sync — the startup path must not block). */
function execRegQueryAsync(keyPath) {
  return new Promise((resolve) => {
    const { execFile } = require("node:child_process");
    execFile("reg", ["query", keyPath], { encoding: "utf8", timeout: 8_000, windowsHide: true },
      (err, stdout) => resolve(err ? "" : String(stdout || "")));
  });
}

function runSilentUninstall(command) {
  return new Promise((resolve) => {
    const { exec } = require("node:child_process");
    const child = exec(command, { timeout: 180_000, windowsHide: true }, (err) => {
      resolve({ ok: !err, error: err ? String(err.message || err) : "" });
    });
    child.on("error", () => resolve({ ok: false, error: "SPAWN_FAILED" }));
  });
}

/**
 * Startup healer: detect legacy installs, ask the user ONCE per finding-set,
 * and run the legacy products' own uninstallers quietly on consent. Dismissal
 * is remembered per signature so the same findings never nag again, while a
 * NEW legacy install re-prompts. Windows only; everything fails open.
 */
async function maybeHealLegacyInstallsWindows({ mainWindow } = {}) {
  try {
    if (process.platform !== "win32") return { checked: false, reason: "not-windows" };
    if (process.env.LILY_LEGACY_INSTALL_HEAL === "0") return { checked: false, reason: "disabled" };
    const fs = require("node:fs");
    const { dialog } = require("electron");
    const { userDataPath } = require("./config");

    const currentExeDir = path.dirname(process.execPath);

    // Registry queries resolve asynchronously first (the pure detector is
    // sync-shaped), then the detector runs with real fs deps.
    const regResults = new Map();
    for (const appId of LEGACY_UNINSTALL_APP_IDS) {
      for (const root of REGISTRY_ROOTS) {
        const key = `${root}\\${appId}`;
        regResults.set(key, await execRegQueryAsync(key));
      }
    }
    const found = detectLegacyInstalls({
      execRegQuery: (key) => regResults.get(key) || "",
      existsDir: (dir) => {
        try { return fs.statSync(dir).isDirectory(); } catch { return false; }
      },
      listUninstallers: (dir) => {
        try {
          return fs.readdirSync(dir)
            .filter((name) => /^uninstall.*\.exe$/i.test(name))
            .map((name) => path.win32.join(dir, name));
        } catch { return []; }
      },
      currentExeDir,
      localAppData: process.env.LOCALAPPDATA || "",
    });
    if (!found.length) return { checked: true, found: 0 };

    const statePath = userDataPath("legacy-installs-state.json");
    const signature = legacyInstallSignature(found);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { state = {}; }
    if (state.handledSignature === signature) return { checked: true, found: found.length, skipped: "handled" };

    let locale = "en";
    try { locale = require("./locale-settings").getLocale() || "en"; } catch { locale = "en"; }
    const zh = String(locale).startsWith("zh");
    const names = found.map((item) => `• ${item.displayName}${item.installLocation ? `（${item.installLocation}）` : ""}`).join("\n");
    const choice = await dialog.showMessageBox(mainWindow || null, {
      type: "warning",
      buttons: zh ? ["卸载旧版本（推荐）", "暂不处理"] : ["Uninstall legacy versions (recommended)", "Not now"],
      defaultId: 0,
      cancelId: 1,
      message: zh
        ? "检测到本机安装了旧版本（产品改名前的安装包）"
        : "Legacy installations from before the product rename were detected",
      detail: zh
        ? `${names}\n\n旧版本无法连接当前服务，容易被误打开导致“授权正常但无法使用”。建议现在卸载（不影响你的数据和当前版本）。`
        : `${names}\n\nLegacy versions cannot reach the current service and cause the "licensed but never works" symptom when launched by stale shortcuts. Uninstalling them does not touch your data or this installation.`,
    });
    if (choice.response !== 0) {
      try { fs.writeFileSync(statePath, JSON.stringify({ handledSignature: signature, dismissedAt: new Date().toISOString() })); } catch {}
      return { checked: true, found: found.length, action: "dismissed" };
    }

    const results = [];
    for (const install of found) {
      const command = silentUninstallCommand(install);
      if (!command) {
        results.push({ install, ok: false, error: "NO_UNINSTALLER" });
        continue;
      }
      results.push({ install, ...(await runSilentUninstall(command)) });
    }
    const failed = results.filter((r) => !r.ok);
    // Only mark the signature handled when EVERY uninstall reported success —
    // otherwise the next launch must re-offer cleanup instead of leaving the
    // user stuck with a half-removed legacy install we never mention again.
    // (NSIS uninstallers also delete asynchronously after exiting, so a
    // reported success can still leave residue; that residue keeps matching
    // the SAME signature only if files remain, which re-scans will catch.)
    if (!failed.length) {
      try { fs.writeFileSync(statePath, JSON.stringify({ handledSignature: signature, healedAt: new Date().toISOString(), results: results.map((r) => ({ name: r.install.displayName, ok: r.ok })) })); } catch {}
    }
    await dialog.showMessageBox(mainWindow || null, {
      type: failed.length ? "warning" : "info",
      buttons: [zh ? "好的" : "OK"],
      message: failed.length
        ? (zh ? `已卸载 ${results.length - failed.length} 个，${failed.length} 个需要手动处理` : `Uninstalled ${results.length - failed.length}; ${failed.length} need manual removal`)
        : (zh ? "旧版本已全部卸载" : "All legacy versions were uninstalled"),
      detail: failed.length
        ? failed.map((r) => `• ${r.install.displayName}: ${r.install.installLocation || r.error}`).join("\n")
        : undefined,
    });
    return { checked: true, found: found.length, action: "healed", failed: failed.length };
  } catch (err) {
    try { require("./logger").getLogger("legacy-installs").warn(`legacy install heal failed open: ${err?.message || err}`); } catch {}
    return { checked: false, error: err?.message || String(err) };
  }
}

module.exports = {
  LEGACY_UNINSTALL_APP_IDS,
  LEGACY_PRODUCT_DIR_NAMES,
  REGISTRY_ROOTS,
  parseRegQueryOutput,
  detectLegacyInstalls,
  legacyInstallSignature,
  silentUninstallCommand,
  maybeHealLegacyInstallsWindows,
};
