import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const installerIncludePath = packageJson?.build?.nsis?.include;

assert.equal(installerIncludePath, "build/installer.nsh", "Windows NSIS installer must include the process guard.");

const installerInclude = await readFile(path.join(repoRoot, installerIncludePath), "utf8");
const afterPackHook = await readFile(path.join(repoRoot, "scripts", "electron-after-pack.cjs"), "utf8");

assert.match(installerInclude, /!macro customCheckAppRunning/, "Installer guard must override app-running detection.");
assert.match(installerInclude, /LilyWorkbench\.exe/, "Installer guard must detect the current executable name.");
assert.match(installerInclude, /Lily Workbench\.exe/, "Installer guard must detect legacy executable names.");
assert.match(installerInclude, /taskkill/, "Installer guard must close running app processes before extraction.");
assert.match(installerInclude, /MB_OKCANCEL/, "Installer guard must ask before closing the app.");
assert.match(installerInclude, /MB_RETRYCANCEL/, "Installer guard must let users retry after manual close.");
assert.match(afterPackHook, /"resources",\s*"icon\.ico"/, "Windows exe icon must come from the source icon asset.");
assert.doesNotMatch(afterPackHook, /"dist",\s*"\.icon-ico"/, "Windows exe icon must not come from stale build cache.");

console.log("windows installer guard config ok");
