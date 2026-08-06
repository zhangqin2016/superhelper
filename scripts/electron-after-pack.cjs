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
  const overrideDir = process.env.ELECTRON_BUILDER_RCEDIT_PATH;
  if (overrideDir) {
    const candidate = path.join(overrideDir, "rcedit-x64.exe");
    if (fs.existsSync(candidate)) return candidate;
  }

  const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
  if (!fs.existsSync(cacheRoot)) return null;
  const candidates = fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(cacheRoot, entry.name))
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });
  for (const dir of candidates) {
    const candidate = path.join(dir, "rcedit-x64.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function applyNativeWindowsResources(context) {
  if (
    context.electronPlatformName !== "win32" ||
    process.platform !== "win32" ||
    process.env.LILY_NATIVE_WINDOWS_RESOURCE_EDIT !== "1"
  ) {
    return;
  }

  const appInfo = context.packager.appInfo;
  const exeName = `${appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(context.packager.projectDir, "resources", "icon.ico");
  const rcedit = findWindowsRcedit();
  if (!fs.existsSync(exePath)) throw new Error(`Windows executable missing: ${exePath}`);
  if (!fs.existsSync(iconPath)) throw new Error(`Windows icon missing: ${iconPath}`);
  if (!rcedit) throw new Error("Windows rcedit not found; cannot apply Lily executable resources.");

  const args = [
    exePath,
    "--set-version-string", "FileDescription", appInfo.productName,
    "--set-version-string", "ProductName", appInfo.productName,
    "--set-version-string", "LegalCopyright", appInfo.copyright,
    "--set-file-version", appInfo.shortVersion || appInfo.buildVersion,
    "--set-product-version", appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm(),
    "--set-version-string", "InternalName", path.basename(exeName, ".exe"),
    "--set-version-string", "OriginalFilename", "",
    "--set-icon", iconPath,
  ];
  if (appInfo.companyName) {
    args.push("--set-version-string", "CompanyName", appInfo.companyName);
  }
  execFileSync(rcedit, args, { stdio: "inherit" });
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

  applyNativeWindowsResources(context);

  if (platformName === "darwin") {
    pruneMacRuntimeBundles(resources, context.arch);
  }

  // Prune foreign-platform native binary subpackages that npm pulled in on the
  // BUILD host (e.g. @img/sharp-darwin-*, @napi-rs/canvas-darwin-*). They select
  // by process.platform at runtime, so the wrong-OS copy is dead weight — but in
  // a Windows build it is genuine Mac pollution and bloats the package. Keep only
  // the variant whose name carries the TARGET platform's OS token.
  const unpackedNm = path.join(resources, "app.asar.unpacked", "node_modules");
  const platformPrefix = platformName === "win32" ? "win32" : platformName;
  const pruneForeignVariants = (nsDir, families) => {
    if (!fs.existsSync(nsDir)) return;
    for (const entry of fs.readdirSync(nsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!families.some((f) => name.startsWith(f))) continue;
      // Only touch dirs that clearly name an OS, so the base package is never hit.
      if (!/-(darwin|linux|win32)(-|$)/.test(name)) continue;
      if (name.includes(`-${platformPrefix}-`) || name.endsWith(`-${platformPrefix}`)) continue;
      removeDir(path.join(nsDir, name));
    }
  };
  pruneForeignVariants(path.join(unpackedNm, "@img"), ["sharp-", "sharp-libvips-"]);
  pruneForeignVariants(path.join(unpackedNm, "@napi-rs"), ["canvas-"]);
};
