"use strict";

/**
 * macOS legacy-install healing (改名遗留) — the mac counterpart of
 * windows-legacy-installs.js.
 *
 * The product renames (AI Super Terminal / 智能助手 / 智能工作台 → Lily
 * Workbench) leave old .app bundles in /Applications or ~/Applications. A
 * user launching the old icon from Spotlight/Dock gets the Windows-documented
 * symptom: the stale binary passes its local license check but speaks a dead
 * protocol — "授权正常但永远不能用". Windows heals this via the old
 * uninstaller; macOS apps have no uninstaller, so the heal is: detect, ask
 * ONCE per finding-set, and (with consent) move the stale bundles to the
 * Trash — reversible by the user, never a silent delete.
 *
 * FAIL-SAFE: every step is best-effort; the RUNNING app's own bundle is
 * always excluded; dismissal is remembered per signature.
 */

const path = require("node:path");

/** Old product bundle names scanned for in the two Applications dirs. */
const LEGACY_MAC_BUNDLE_NAMES = Object.freeze([
  "AI Super Terminal.app",
  "智能助手.app",
  "智能工作台.app",
  "ai-super-terminal.app",
]);

/**
 * Detect legacy bundles. Pure given injected deps:
 *  - listDir(dirPath) -> array of entry names (throw/[] = missing)
 *  - currentBundlePath: the RUNNING app's .app path (always excluded)
 *  - applicationsDirs: dirs to scan
 */
function detectLegacyMacInstalls({ listDir, currentBundlePath = "", applicationsDirs = [] } = {}) {
  const found = [];
  const seen = new Set();
  const current = String(currentBundlePath || "").replace(/\/+$/, "");
  for (const dir of applicationsDirs) {
    let entries = [];
    try {
      entries = listDir(dir) || [];
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!LEGACY_MAC_BUNDLE_NAMES.includes(name)) continue;
      const bundlePath = path.join(dir, name);
      if (current && (bundlePath === current || current.startsWith(`${bundlePath}/`))) continue;
      if (seen.has(bundlePath)) continue;
      seen.add(bundlePath);
      found.push({ kind: "bundle", displayName: name.replace(/\.app$/, ""), bundlePath });
    }
  }
  return found;
}

/** Stable signature so the consent prompt never nags about the same finding. */
function legacyMacSignature(installs = []) {
  return installs
    .map((item) => item.bundlePath.toLowerCase())
    .sort()
    .join("|");
}

async function maybeHealLegacyInstallsMac({ mainWindow } = {}) {
  try {
    if (process.platform !== "darwin") return { checked: false, reason: "not-macos" };
    if (process.env.LILY_LEGACY_INSTALL_HEAL === "0") return { checked: false, reason: "disabled" };
    const fs = require("node:fs");
    const os = require("node:os");
    const { app, dialog, shell } = require("electron");
    const { userDataPath } = require("./config");

    let currentBundlePath = "";
    try {
      const appPath = app.getAppPath().replace(/\\/g, "/");
      const match = appPath.match(/^(.*?\.app)(\/|$)/);
      currentBundlePath = match ? match[1] : "";
    } catch {
      currentBundlePath = "";
    }

    const found = detectLegacyMacInstalls({
      listDir: (dir) => fs.readdirSync(dir),
      currentBundlePath,
      applicationsDirs: ["/Applications", path.join(os.homedir(), "Applications")],
    });
    if (!found.length) return { checked: true, found: 0 };

    const statePath = userDataPath("legacy-installs-state.json");
    const signature = legacyMacSignature(found);
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { state = {}; }
    if (state.handledSignature === signature) return { checked: true, found: found.length, skipped: "handled" };

    let locale = "en";
    try { locale = require("./locale-settings").getLocale() || "en"; } catch { locale = "en"; }
    const zh = String(locale).startsWith("zh");
    const names = found.map((item) => `• ${item.displayName}（${item.bundlePath}）`).join("\n");
    const choice = await dialog.showMessageBox(mainWindow || null, {
      type: "warning",
      buttons: zh ? ["移到废纸篓（推荐）", "暂不处理"] : ["Move to Trash (recommended)", "Not now"],
      defaultId: 0,
      cancelId: 1,
      message: zh
        ? "检测到本机安装了旧版本（产品改名前的应用）"
        : "Legacy apps from before the product rename were detected",
      detail: zh
        ? `${names}\n\n旧版本无法连接当前服务，误打开会表现为“授权正常但无法使用”。建议移到废纸篓（不影响你的数据和当前版本，可随时从废纸篓恢复）。`
        : `${names}\n\nLegacy apps cannot reach the current service and cause the "licensed but never works" symptom when launched by mistake. Moving them to the Trash does not touch your data or this installation, and you can restore them from the Trash anytime.`,
    });
    if (choice.response !== 0) {
      try { fs.writeFileSync(statePath, JSON.stringify({ handledSignature: signature, dismissedAt: new Date().toISOString() })); } catch {}
      return { checked: true, found: found.length, action: "dismissed" };
    }

    const results = [];
    for (const install of found) {
      try {
        await shell.trashItem(install.bundlePath);
        results.push({ install, ok: true });
      } catch (err) {
        results.push({ install, ok: false, error: err?.message || String(err) });
      }
    }
    try { fs.writeFileSync(statePath, JSON.stringify({ handledSignature: signature, healedAt: new Date().toISOString(), results: results.map((r) => ({ name: r.install.displayName, ok: r.ok })) })); } catch {}

    const failed = results.filter((r) => !r.ok);
    await dialog.showMessageBox(mainWindow || null, {
      type: failed.length ? "warning" : "info",
      buttons: [zh ? "好的" : "OK"],
      message: failed.length
        ? (zh ? `已移除 ${results.length - failed.length} 个，${failed.length} 个需要手动删除` : `Removed ${results.length - failed.length}; ${failed.length} need manual removal`)
        : (zh ? "旧版本已全部移到废纸篓" : "All legacy apps were moved to the Trash"),
      detail: failed.length
        ? failed.map((r) => `• ${r.install.bundlePath}: ${r.error}`).join("\n")
        : undefined,
    });
    return { checked: true, found: found.length, action: "healed", failed: failed.length };
  } catch (err) {
    try { require("./logger").getLogger("legacy-installs").warn(`mac legacy install heal failed open: ${err?.message || err}`); } catch {}
    return { checked: false, error: err?.message || String(err) };
  }
}

module.exports = {
  LEGACY_MAC_BUNDLE_NAMES,
  detectLegacyMacInstalls,
  legacyMacSignature,
  maybeHealLegacyInstallsMac,
};
