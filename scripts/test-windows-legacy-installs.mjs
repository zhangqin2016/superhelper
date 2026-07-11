#!/usr/bin/env node
//
// windows-legacy-installs holds the pure detection logic behind the legacy
// install healer (改名遗留: com.company.ai-super-terminal era installs pass
// their local license check but speak a dead protocol). Detection feeds a
// consent dialog that runs the OLD product's own uninstaller — so a false
// positive here risks uninstalling the wrong thing. Runs in plain node.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wli = require(path.join(ROOT, "src/main/windows-legacy-installs.js"));

// --- parseRegQueryOutput: real `reg query` output shape (name / type / data
// separated by runs of spaces; data itself contains spaces and CJK).
const REG_FIXTURE = [
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.company.ai-super-terminal",
  "    DisplayName    REG_SZ    智能工作台",
  "    DisplayVersion    REG_SZ    0.0.48",
  "    InstallLocation    REG_SZ    C:\\Users\\u\\AppData\\Local\\Programs\\智能工作台",
  '    UninstallString    REG_SZ    "C:\\Users\\u\\AppData\\Local\\Programs\\智能工作台\\Uninstall 智能工作台.exe" /currentuser',
  "    NoModify    REG_DWORD    0x1",
  "",
].join("\r\n");
const values = wli.parseRegQueryOutput(REG_FIXTURE);
assert(values.DisplayName === "智能工作台", "parses CJK display name");
assert(values.InstallLocation.endsWith("智能工作台"), "parses install location with spaces in path root");
assert(values.UninstallString.includes("Uninstall 智能工作台.exe"), "parses uninstall string containing spaces");
assert(!("NoModify" in values), "ignores non-SZ value types");
const expandSz = wli.parseRegQueryOutput("    UninstallString    REG_EXPAND_SZ    %LOCALAPPDATA%\\X\\un.exe");
assert(expandSz.UninstallString === "%LOCALAPPDATA%\\X\\un.exe", "accepts REG_EXPAND_SZ");
assert(Object.keys(wli.parseRegQueryOutput("")).length === 0, "empty output → no values");

// --- detectLegacyInstalls: registry finding.
const regByKey = new Map([
  [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.company.ai-super-terminal",
    REG_FIXTURE,
  ],
]);
const deps = {
  execRegQuery: (key) => {
    const out = regByKey.get(key);
    if (!out) throw new Error("not found");
    return out;
  },
  existsDir: () => false,
  listUninstallers: () => [],
  currentExeDir: "C:\\Users\\u\\AppData\\Local\\Programs\\LilyWorkbench",
  localAppData: "C:\\Users\\u\\AppData\\Local",
};
const found = wli.detectLegacyInstalls(deps);
assert(found.length === 1, "one registry finding");
assert(found[0].kind === "registry" && found[0].appId === "com.company.ai-super-terminal", "registry finding identity");
assert(found[0].displayName === "智能工作台", "finding carries display name");
assert(found[0].quiet === false, "no QuietUninstallString → quiet false");

// Current install dir is ALWAYS excluded, even if the legacy key points at it
// (e.g. an old key left behind after an in-place upgrade re-used the folder).
const foundSelf = wli.detectLegacyInstalls({
  ...deps,
  currentExeDir: "C:\\Users\\u\\AppData\\Local\\Programs\\智能工作台",
});
assert(foundSelf.length === 0, "legacy key pointing at the RUNNING install dir is excluded");

// Registry key present but no UninstallString → not actionable, skipped.
const noUninstall = wli.detectLegacyInstalls({
  ...deps,
  execRegQuery: () => "    DisplayName    REG_SZ    智能助手",
});
assert(noUninstall.length === 0, "registry entry without UninstallString is skipped");

// Throwing reg query (key absent) is "nothing found", not an error.
assert(wli.detectLegacyInstalls({ ...deps, execRegQuery: () => { throw new Error("x"); } }).length === 0,
  "missing registry keys fail open to empty");

// --- directory findings under %LOCALAPPDATA%\Programs.
const dirDeps = {
  execRegQuery: () => { throw new Error("none"); },
  existsDir: (dir) => dir === "C:\\Users\\u\\AppData\\Local\\Programs\\AI Super Terminal",
  listUninstallers: (dir) => [path.win32.join(dir, "Uninstall AI Super Terminal.exe")],
  currentExeDir: "C:\\Users\\u\\AppData\\Local\\Programs\\LilyWorkbench",
  localAppData: "C:\\Users\\u\\AppData\\Local",
};
const dirFound = wli.detectLegacyInstalls(dirDeps);
assert(dirFound.length === 1 && dirFound[0].kind === "directory", "directory finding");
assert(dirFound[0].uninstall.startsWith('"') && dirFound[0].uninstall.includes("Uninstall AI Super Terminal.exe"),
  "directory uninstaller path is quoted");
// Same dir but it IS the current install → excluded.
assert(wli.detectLegacyInstalls({
  ...dirDeps,
  currentExeDir: "C:\\Users\\u\\AppData\\Local\\Programs\\AI Super Terminal",
}).length === 0, "directory equal to current install dir is excluded");
// No localAppData → dir scan skipped entirely.
assert(wli.detectLegacyInstalls({ ...dirDeps, localAppData: "" }).length === 0,
  "missing LOCALAPPDATA skips the directory scan");
// Directory without an uninstaller still surfaces (manual cleanup path).
const bareDir = wli.detectLegacyInstalls({ ...dirDeps, listUninstallers: () => [] });
assert(bareDir.length === 1 && bareDir[0].uninstall === "", "uninstaller-less directory still reported");

// --- dedupe: same registry entry visible via HKCU and HKLM collapses to one.
const dupDeps = {
  ...deps,
  execRegQuery: () => REG_FIXTURE,
};
assert(wli.detectLegacyInstalls(dupDeps).length === 1, "identical entries across roots dedupe");

// --- legacyInstallSignature: stable across ordering and casing.
const sigA = wli.legacyInstallSignature([
  { kind: "registry", installLocation: "C:\\A", uninstall: "" },
  { kind: "directory", installLocation: "C:\\B", uninstall: "" },
]);
const sigB = wli.legacyInstallSignature([
  { kind: "directory", installLocation: "c:\\b", uninstall: "" },
  { kind: "registry", installLocation: "c:\\a", uninstall: "" },
]);
assert(sigA === sigB && sigA.length > 0, "signature is order- and case-insensitive");
assert(wli.legacyInstallSignature([]) === "", "empty findings → empty signature");

// --- silentUninstallCommand.
assert(
  wli.silentUninstallCommand({ uninstall: '"C:\\X\\Uninstall App.exe" /currentuser', quiet: false })
    === '"C:\\X\\Uninstall App.exe" /currentuser /S',
  "appends /S for non-quiet uninstall strings",
);
assert(
  wli.silentUninstallCommand({ uninstall: '"C:\\X\\un.exe" /S', quiet: false }) === '"C:\\X\\un.exe" /S',
  "does not double /S",
);
assert(
  wli.silentUninstallCommand({ uninstall: '"C:\\X\\un.exe" /qn', quiet: true }) === '"C:\\X\\un.exe" /qn',
  "quiet strings pass through untouched",
);
assert(wli.silentUninstallCommand({ uninstall: "" }) === "", "empty uninstall → empty command");
assert(wli.silentUninstallCommand(null) === "", "null install → empty command");

// --- runtime healer is a no-op off Windows (fail-open, no electron needed).
const healed = await wli.maybeHealLegacyInstallsWindows({});
if (process.platform !== "win32") {
  assert(healed.checked === false && healed.reason === "not-windows", "healer no-ops off win32");
}

console.log("windows-legacy-installs: ok");
