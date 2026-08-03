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
const bashWrapper = await readFile(path.join(repoRoot, "scripts", "run-bash-script.mjs"), "utf8");

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
assert.equal(packageJson?.build?.win?.signAndEditExecutable, true, "Windows packaging must use electron-builder's host-native resource editor so cross-builds retain icon and version metadata.");
assert.ok(packageJson?.build?.win?.signExts?.includes("!opencode.exe"), "Windows packaging must not code-sign the bundled OpenCode engine.");
assert.doesNotMatch(afterPackHook, /rcedit/i, "Windows afterPack must not invoke a target-host-only rcedit binary during cross-builds.");
assert.match(
  distWinScript,
  /toolsets\.winCodeSign=1\.1\.0/,
  "Windows packaging must use the split winCodeSign toolset so unrelated macOS symlinks cannot block Windows releases.",
);
assert.match(distWinScript, /SIGNTOOL_PATH/, "Windows packaging must reuse cached signtool when available.");
assert.match(distWinScript, /ELECTRON_BUILDER_RCEDIT_PATH/, "Windows packaging must reuse cached rcedit when available.");
assert.match(distWinScript, /resolve_win_codesign_cache_env/, "Windows packaging must resolve cached signing tools without depending on a specific bash flavor.");
assert.match(distWinScript, /process\.env\.LOCALAPPDATA/, "Windows packaging must resolve the electron-builder cache from the native Windows LOCALAPPDATA path.");
assert.match(packageJson?.scripts?.["dist:win"], /run-bash-script\.mjs/, "Windows packaging must use the Git Bash wrapper instead of whichever bash appears first on PATH.");
assert.match(bashWrapper, /Git", "bin", "bash\.exe"/, "Windows bash wrapper must prefer Git Bash over WSL bash.");
assert.ok(
  distWinScript.indexOf("CSC_IDENTITY_AUTO_DISCOVERY") < distWinScript.indexOf("exec npx electron-builder"),
  "Unsigned Windows packaging must disable automatic certificate discovery before electron-builder starts.",
);

const mainProcess = await readFile(path.join(repoRoot, "src", "main.js"), "utf8");
assert.match(mainProcess, /setAppUserModelId\("cn\.lilywb\.workbench"\)/, "Windows runtime AppUserModelId must match the packaged app identity.");

console.log("windows installer guard config ok");
