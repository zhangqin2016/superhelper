import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const installerIncludePath = packageJson?.build?.nsis?.include;

assert.equal(packageJson?.build?.appId, "cn.lilywb.workbench", "Packaged app identity must use the Lily Workbench appId.");
assert.notEqual(packageJson?.build?.appId, "com.company.ai-super-terminal", "Packaged app identity must not use the old placeholder appId.");
assert.equal(installerIncludePath, "build/installer.nsh", "Windows NSIS installer must include the process guard.");

const installerInclude = await readFile(path.join(repoRoot, installerIncludePath), "utf8");
const afterPackHook = await readFile(path.join(repoRoot, "scripts", "electron-after-pack.cjs"), "utf8");
const distWinScript = await readFile(path.join(repoRoot, "scripts", "dist-win.sh"), "utf8");

assert.match(installerInclude, /!macro customCheckAppRunning/, "Installer guard must override app-running detection.");
assert.match(installerInclude, /LilyWorkbench\.exe/, "Installer guard must detect the current executable name.");
assert.match(installerInclude, /Lily Workbench\.exe/, "Installer guard must detect legacy executable names.");
assert.match(installerInclude, /taskkill/, "Installer guard must close running app processes before extraction.");
// SELF-KILL GUARD: taskkill must NOT use /T on the app image name. In-app
// updates launch setup as a descendant of Lily Workbench.exe, so /T (kill the
// whole descendant tree) would take the installer down with it.
assert.doesNotMatch(
  installerInclude,
  /taskkill[^\n]*\/IM[^\n]*\/T\b/i,
  "Installer must NOT taskkill the app image with /T — /T kills the descendant tree, which includes an in-app-update setup process (self-kill).",
);
// The install-dir/engine sweep must exclude THIS installer and its whole
// ancestor chain, so setup never kills itself or the process that launched it.
assert.match(installerInclude, /GetCurrentProcessId/, "Force-kill must resolve the installer's own PID to protect it.");
assert.match(installerInclude, /ParentProcessId/, "Force-kill must walk the installer's ancestor chain to protect it.");
assert.match(installerInclude, /ContainsKey/, "Force-kill must exclude the protected (self + ancestors) set before Stop-Process.");
assert.match(installerInclude, /MB_OKCANCEL/, "Installer guard must ask before closing the app.");
assert.match(installerInclude, /MB_RETRYCANCEL/, "Installer guard must let users retry after manual close.");
assert.equal(packageJson?.build?.nsis?.installerIcon, "icon.ico", "Windows installer icon must use the Lily icon asset.");
assert.equal(packageJson?.build?.nsis?.uninstallerIcon, "icon.ico", "Windows uninstaller icon must use the Lily icon asset.");
assert.equal(packageJson?.build?.nsis?.installerHeaderIcon, "icon.ico", "Windows installer header icon must use the Lily icon asset.");
assert.match(afterPackHook, /"resources",\s*"icon\.ico"/, "Windows exe icon must come from the source icon asset.");
assert.doesNotMatch(afterPackHook, /"dist",\s*"\.icon-ico"/, "Windows exe icon must not come from stale build cache.");
assert.doesNotMatch(distWinScript, /signAndEditExecutable=false/, "Windows cross-build must not disable executable resource editing; that drops the app icon on unsigned builds.");

const mainProcess = await readFile(path.join(repoRoot, "src", "main.js"), "utf8");
assert.match(mainProcess, /setAppUserModelId\("cn\.lilywb\.workbench"\)/, "Windows runtime AppUserModelId must match the packaged app identity.");

console.log("windows installer guard config ok");
