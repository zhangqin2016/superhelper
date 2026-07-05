const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function resourcesDir(appOutDir, platformName) {
  if (platformName === "darwin") {
    const app = fs.readdirSync(appOutDir).find((name) => name.endsWith(".app"));
    return app ? path.join(appOutDir, app, "Contents", "Resources") : null;
  }
  return path.join(appOutDir, "resources");
}

function archName(arch) {
  if (arch === "arm64" || arch === 3) return "arm64";
  if (arch === "x64" || arch === 1) return "x64";
  return String(arch || "");
}

function findWindowsRcedit() {
  if (process.platform !== "win32") return null;
  const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
  if (!fs.existsSync(cacheRoot)) return null;
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(cacheRoot, entry.name, "rcedit-x64.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function applyWindowsIcon(context) {
  if (context.electronPlatformName !== "win32") return;
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(context.packager.projectDir, "dist", ".icon-ico", "icon.ico");
  const rcedit = findWindowsRcedit();
  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath) || !rcedit) return;
  execFileSync(rcedit, [exePath, "--set-icon", iconPath], { stdio: "inherit" });
}

function pruneMacRuntimeBundles(resources, arch) {
  const currentArch = archName(arch);
  if (currentArch !== "arm64" && currentArch !== "x64") return;
  const keep = currentArch === "arm64" ? "darwin-arm64" : "darwin-x64";
  const bundlesRoot = path.join(resources, "bundles");
  for (const name of ["darwin-arm64", "darwin-x64"]) {
    if (name !== keep) removeDir(path.join(bundlesRoot, name));
  }
}

exports.default = async function afterPack(context) {
  const platformName = context.electronPlatformName;
  const resources = resourcesDir(context.appOutDir, platformName);
  if (!resources) return;

  applyWindowsIcon(context);

  if (platformName === "darwin") {
    pruneMacRuntimeBundles(resources, context.arch);
  }

  const imgRoot = path.join(resources, "app.asar.unpacked", "node_modules", "@img");
  if (!fs.existsSync(imgRoot)) return;

  const platformPrefix = platformName === "win32" ? "win32" : platformName;
  for (const entry of fs.readdirSync(imgRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!name.startsWith("sharp-") && !name.startsWith("sharp-libvips-")) continue;
    if (name.includes(`-${platformPrefix}-`)) continue;
    removeDir(path.join(imgRoot, name));
  }
};
