const fs = require("node:fs");
const path = require("node:path");

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
