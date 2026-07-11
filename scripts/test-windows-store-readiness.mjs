import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guide = await readFile(
  path.join(root, "docs", "windows-store-release-readiness.md"),
  "utf8",
);
const releaseSop = await readFile(
  path.join(root, "docs", "release-and-deploy-sop.md"),
  "utf8",
);
const launcher = await readFile(
  path.join(root, "scripts", "start-windows-store-sandbox.ps1"),
  "utf8",
);
const runnerBytes = await readFile(path.join(root, "scripts", "smoke-windows-store-installer.ps1"));

assert.deepEqual([...runnerBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

const runner = runnerBytes.subarray(3).toString("utf8");

for (const requiredGuideText of [
  "-RequireSignature",
  "-AllowUserDataRemnants",
  "/S /currentuser",
  "readiness-report.json",
  "readiness-summary.md",
  "Windows App Certification Kit",
  "不适用",
  "真实 Windows",
  "标准用户",
  "不会卸载预存安装",
]) {
  assert.ok(
    guide.includes(requiredGuideText),
    `Windows Store readiness guide must include ${requiredGuideText}`,
  );
}

for (const officialUrl of [
  "https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements",
  "https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/manual-package-validation",
  "https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-certification-process",
]) {
  assert.ok(guide.includes(officialUrl), `Windows Store readiness guide must cite ${officialUrl}`);
}

assert.ok(
  releaseSop.includes("[windows-store-release-readiness.md](windows-store-release-readiness.md)"),
  "release SOP must link the Windows Store EXE readiness guide",
);

assert.match(runner, /Set-StrictMode -Version Latest/);
assert.match(runner, /\$Installer\b/);
assert.match(runner, /\$OutputDirectory\b/);
assert.match(runner, /\$ExpectedPublisher\b/);
assert.match(runner, /\$ExpectedVersion\b/);
assert.match(runner, /\$RequireSignature\b/);
assert.match(runner, /\$AllowUserDataRemnants\b/);
assert.match(runner, /\$InstallTimeoutSeconds\b/);
assert.match(runner, /\$LaunchTimeoutSeconds\b/);
assert.match(runner, /\$UninstallTimeoutSeconds\b/);
assert.match(runner, /\$script:InstallAttemptStarted\s*=\s*\$false/);
assert.match(runner, /["']\/S["']/, "silent install must use the quoted, uppercase /S switch");
assert.match(runner, /["']\/currentuser["']/, "silent install must target the current user");
assert.match(runner, /@\(\s*["']\/S["']\s*,\s*["']\/currentuser["']\s*\)/);
assert.match(runner, /\bpass\b/);
assert.match(runner, /\bwarning\b/);
assert.match(runner, /\bfail\b/);
assert.match(runner, /\bnot_applicable\b/);

const addCheckMatch = runner.match(/function Add-Check \{([\s\S]*?)\n\}\n\nfunction /);
assert.ok(addCheckMatch, "Add-Check must remain a standalone helper.");
assert.match(addCheckMatch[1], /\[Parameter\(Mandatory = \$true\)\]\s*\[string\]\$Id/);
assert.match(addCheckMatch[1], /\[ValidateSet\("pass", "warning", "fail", "not_applicable"\)\]/);
assert.match(addCheckMatch[1], /\[Parameter\(Mandatory = \$true\)\][\s\S]{0,80}\[string\]\$Detail/);
assert.match(addCheckMatch[1], /\$Evidence/);
assert.doesNotMatch(addCheckMatch[1], /\$Title\b/);
assert.match(addCheckMatch[1], /id\s*=\s*\$Id/);
assert.match(addCheckMatch[1], /status\s*=\s*\$Status/);
assert.match(addCheckMatch[1], /detail\s*=\s*\$Detail/);
assert.match(addCheckMatch[1], /evidence\s*=\s*\$Evidence/);

const requireCheckMatch = runner.match(/function Require-Check \{([\s\S]*?)\n\}\n\nfunction /);
assert.ok(requireCheckMatch, "Require-Check must remain a standalone helper.");
assert.match(requireCheckMatch[1], /\[string\]\$Id/);
assert.match(requireCheckMatch[1], /\[bool\]\$Condition/);
assert.match(requireCheckMatch[1], /\[string\]\$PassDetail/);
assert.match(requireCheckMatch[1], /\[string\]\$FailDetail/);
assert.match(requireCheckMatch[1], /\$Evidence/);
assert.doesNotMatch(requireCheckMatch[1], /\$Title\b/);
const requireCheckSuccessBranch = requireCheckMatch[1].match(/if \(\$Condition\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
assert.match(requireCheckSuccessBranch, /Add-Check[^\r\n]*-Status "pass"/);
assert.match(requireCheckSuccessBranch, /-Detail \$PassDetail/);
assert.match(requireCheckSuccessBranch, /-Evidence \$Evidence/);
assert.match(requireCheckSuccessBranch, /\breturn\b/);
assert.match(requireCheckMatch[1], /Add-Check[^\r\n]*-Status "fail"[^\r\n]*-Detail \$FailDetail/);
assert.match(requireCheckMatch[1], /throw \$FailDetail/);

assert.match(runner, /function Get-LilyUninstallEntries\b/);
assert.match(runner, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
assert.match(runner, /HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
assert.match(runner, /HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
assert.match(runner, /QuietUninstallString/);
assert.match(runner, /DisplayName/);
assert.match(runner, /Publisher/);
assert.match(runner, /DisplayVersion/);
assert.match(runner, /InstallLocation/);
assert.match(runner, /DisplayIcon/);
assert.match(runner, /UninstallString/);

const legacyEntriesMatch = runner.match(
  /function Get-LilyLegacyUninstallEntries \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(legacyEntriesMatch, "Get-LilyLegacyUninstallEntries must be a standalone helper.");
const legacyEntriesBody = legacyEntriesMatch[1];
assert.match(legacyEntriesBody, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
assert.match(legacyEntriesBody, /HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
assert.match(
  legacyEntriesBody,
  /HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall/,
);
assert.match(
  legacyEntriesBody,
  /com\.company\.ai-super-terminal/,
  "legacy detection must address the exact former appId registry key",
);
assert.doesNotMatch(
  legacyEntriesBody,
  /Get-ChildItem|Where-Object/,
  "legacy detection must not depend on display-name discovery",
);
for (const property of [
  "RegistryPath",
  "DisplayName",
  "DisplayVersion",
  "InstallLocation",
  "UninstallString",
  "QuietUninstallString",
]) {
  assert.match(legacyEntriesBody, new RegExp(`${property}\\s*=`));
}

const initializeNativeMatch = runner.match(
  /function Initialize-NativeCommandLine \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(initializeNativeMatch, "Initialize-NativeCommandLine must be a standalone helper.");
const initializeNativeBody = initializeNativeMatch[1];
assert.match(
  initializeNativeBody,
  /if \(\$null -eq \(["']Lily\.NativeCommandLine\.[A-Za-z]+["'] -as \[type\]\)\) \{\s*Add-Type/,
  "the native parser type must only be compiled when it is not already loaded",
);
assert.doesNotMatch(
  runner.replace(initializeNativeMatch[0], ""),
  /\bAdd-Type\b/,
  "Add-Type must not execute at top level outside the report-protected main try",
);
const nativeCommandLineSource = runner.match(/Add-Type\s+-TypeDefinition\s+@'([\s\S]*?)'@/)?.[1] ?? "";
assert.ok(nativeCommandLineSource, "the runner must compile a native Windows command-line parser");
assert.match(nativeCommandLineSource, /namespace Lily\.NativeCommandLine/);
assert.match(nativeCommandLineSource, /DllImport\(["']shell32\.dll["']/i);
assert.match(nativeCommandLineSource, /CommandLineToArgvW/);
assert.match(nativeCommandLineSource, /DllImport\(["']kernel32\.dll["']/i);
assert.match(nativeCommandLineSource, /LocalFree/);
assert.match(nativeCommandLineSource, /public static string\[\] Split\s*\(/);
assert.match(nativeCommandLineSource, /try\s*\{/);
assert.match(nativeCommandLineSource, /finally\s*\{[\s\S]*LocalFree\s*\(/);
assert.match(nativeCommandLineSource, /DllImport\(["']user32\.dll["'][\s\S]*EnumWindows/i);
assert.match(nativeCommandLineSource, /IsWindowVisible/);
assert.match(nativeCommandLineSource, /GetWindowThreadProcessId/);
assert.match(nativeCommandLineSource, /GetWindowTextLength/);
assert.match(nativeCommandLineSource, /GetWindowText/);

const visibleWindowsMatch = runner.match(
  /function Get-VisibleTopLevelWindows \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(visibleWindowsMatch, "Get-VisibleTopLevelWindows must be a standalone helper.");
const visibleWindowsBody = visibleWindowsMatch[1];
assert.match(visibleWindowsBody, /\[int\[\]\]\$ProcessIds/);
assert.match(visibleWindowsBody, /Lily\.NativeCommandLine\.[A-Za-z]+\]::GetVisibleWindows/);
for (const property of ["processId", "windowHandle", "windowTitle", "label"]) {
  assert.match(visibleWindowsBody, new RegExp(`${property}\\s*=`));
}

const packagedRendererUrlMatch = runner.match(
  /function Test-LilyPackagedRendererUrl \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(packagedRendererUrlMatch, "Test-LilyPackagedRendererUrl must be a standalone helper.");
const packagedRendererUrlBody = packagedRendererUrlMatch[1];
assert.match(packagedRendererUrlBody, /\[System\.Uri\]::TryCreate/);
assert.match(packagedRendererUrlBody, /\[System\.UriKind\]::Absolute/);
assert.match(packagedRendererUrlBody, /\.Scheme/);
assert.match(packagedRendererUrlBody, /["']file["']/);
assert.match(packagedRendererUrlBody, /OrdinalIgnoreCase/);
assert.match(packagedRendererUrlBody, /UnescapeDataString/);
assert.match(packagedRendererUrlBody, /\.Replace\(["']\\["'],\s*["']\/["']\)/);
assert.ok(
  packagedRendererUrlBody.includes("/resources/app\\.asar/src/renderer/index\\.html$"),
  "the packaged renderer path must be anchored at app.asar/src/renderer/index.html",
);
assert.match(packagedRendererUrlBody, /\.Query/);
assert.match(packagedRendererUrlBody, /\.Fragment/);

const resolveUninstallMatch = runner.match(
  /function Resolve-UninstallCommand \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(resolveUninstallMatch, "Resolve-UninstallCommand must be a standalone helper.");
const resolveUninstallBody = resolveUninstallMatch[1];
assert.match(resolveUninstallBody, /\[object\]\$Entry/);
assert.match(resolveUninstallBody, /\[string\]\$InstallDirectory/);
assert.match(resolveUninstallBody, /QuietUninstallString/);
assert.doesNotMatch(resolveUninstallBody, /\.UninstallString\b|-Name\s+["']UninstallString["']/);
assert.match(resolveUninstallBody, /ExpandEnvironmentVariables\s*\(/);
assert.match(resolveUninstallBody, /\[Lily\.NativeCommandLine\.[A-Za-z]+\]::Split\s*\(/);
assert.doesNotMatch(resolveUninstallBody, /\s-split\s|\.Split\(\s*["']\s+["']/);
assert.match(resolveUninstallBody, /\.Count\s+-lt\s+1/);
assert.match(resolveUninstallBody, /\[System\.IO\.Path\]::GetFullPath\s*\(/);
assert.match(resolveUninstallBody, /DirectorySeparatorChar/);
assert.match(resolveUninstallBody, /\.StartsWith\([\s\S]{0,180}OrdinalIgnoreCase/);
assert.match(resolveUninstallBody, /Test-Path\s+-LiteralPath[\s\S]{0,100}-PathType\s+Leaf/);
assert.match(resolveUninstallBody, /-ccontains\s+["']\/S["']/);
assert.match(resolveUninstallBody, /filePath\s*=/);
assert.match(resolveUninstallBody, /arguments\s*=/);
assert.match(resolveUninstallBody, /declaresSilent\s*=/);
assert.match(resolveUninstallBody, /originalCommand\s*=/);

const quietContractMatch = runner.match(
  /function Record-UninstallQuietContract \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(quietContractMatch, "the uppercase /S contract must be recorded independently of cleanup");
assert.match(quietContractMatch[1], /uninstall\.quiet_contract/);
assert.match(quietContractMatch[1], /\.declaresSilent/);
assert.match(quietContractMatch[1], /-Status\s+["']pass["']/);
assert.match(quietContractMatch[1], /-Status\s+["']fail["']/);

const silentUninstallMatch = runner.match(
  /function Invoke-SilentUninstall \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(silentUninstallMatch, "Invoke-SilentUninstall must be a standalone helper.");
const silentUninstallBody = silentUninstallMatch[1];
assert.match(silentUninstallBody, /Resolve-UninstallCommand/);
assert.match(silentUninstallBody, /if \(-not \$command\.declaresSilent\)/);
assert.match(silentUninstallBody, /\+=\s*["']\/S["']/);
assert.match(silentUninstallBody, /Invoke-MonitoredProcess/);
assert.match(silentUninstallBody, /-Label\s+["']uninstaller["']/);
assert.match(silentUninstallBody, /Get-LilyUninstallEntries/);
assert.doesNotMatch(
  silentUninstallBody,
  /RegistryPath|Where-Object/,
  "uninstall success must require every Lily Workbench ARP entry to disappear",
);
assert.match(silentUninstallBody, /\$remainingProductEntries\s*=\s*@\(Get-LilyUninstallEntries\)/);
assert.match(
  silentUninstallBody,
  /\$productEntryRemoved\s*=\s*\$remainingProductEntries\.Count\s+-eq\s+0/,
);
assert.match(silentUninstallBody, /Test-Path\s+-LiteralPath\s+\$InstallDirectory/);
assert.match(silentUninstallBody, /\[Math\]::Min\(\s*30\s*,/);
assert.doesNotMatch(silentUninstallBody, /\$TimeoutSeconds\s*\*\s*2/);
assert.match(silentUninstallBody, /Start-Sleep\s+-Milliseconds\s+500/);
for (const property of [
  "command",
  "process",
  "productEntryRemoved",
  "remainingProductEntries",
  "installDirectoryRemoved",
]) {
  assert.match(silentUninstallBody, new RegExp(`${property}\\s*=`));
}

const userResidueMatch = runner.match(
  /function Get-LilyUserDataResidues \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(userResidueMatch, "Get-LilyUserDataResidues must be a standalone helper.");
const userResidueBody = userResidueMatch[1];
assert.match(userResidueBody, /\$env:APPDATA/);
assert.match(userResidueBody, /\$env:LOCALAPPDATA/);
for (const expectedPathPart of ["lily-workbench", "lily-workbench-updater", "Lily Workbench", "Lily Apps"]) {
  assert.ok(userResidueBody.includes(`"${expectedPathPart}"`), `user residue inventory must include ${expectedPathPart}`);
}
assert.match(userResidueBody, /MyDocuments/);
assert.match(userResidueBody, /Test-Path\s+-LiteralPath/);
assert.match(userResidueBody, /path\s*=/);
assert.match(userResidueBody, /kind\s*=/);
assert.doesNotMatch(userResidueBody, /Remove-Item/);

const installResidueMatch = runner.match(
  /function Get-LilyInstallResidues \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(installResidueMatch, "Get-LilyInstallResidues must be a standalone helper.");
const installResidueBody = installResidueMatch[1];
assert.match(installResidueBody, /\$env:LOCALAPPDATA/);
assert.match(installResidueBody, /\$env:ProgramFiles/);
assert.match(installResidueBody, /\$\{env:ProgramFiles\(x86\)\}/);
assert.match(installResidueBody, /\$script:InstallDirectory/);
for (const expectedPathPart of ["Programs", "LilyWorkbench", "Lily Workbench"]) {
  assert.ok(installResidueBody.includes(`"${expectedPathPart}"`), `install residue inventory must include ${expectedPathPart}`);
}
assert.match(installResidueBody, /OrdinalIgnoreCase/);
assert.match(installResidueBody, /Test-Path\s+-LiteralPath/);
assert.doesNotMatch(installResidueBody, /Remove-Item/);

const normalCleanupMatch = runner.match(
  /function Try-NormalUninstallCleanup \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(normalCleanupMatch, "Try-NormalUninstallCleanup must be a standalone helper.");
const normalCleanupBody = normalCleanupMatch[1];
assert.match(normalCleanupBody, /try\s*\{/);
assert.match(normalCleanupBody, /Get-LilyUninstallEntries/);
assert.match(normalCleanupBody, /\.Count\s+-eq\s+0/);
assert.match(normalCleanupBody, /\.Count\s+-gt\s+1/);
assert.match(normalCleanupBody, /Resolve-UninstallCommand/);
assert.match(normalCleanupBody, /Record-UninstallQuietContract/);
assert.match(normalCleanupBody, /Invoke-SilentUninstall/);
assert.match(normalCleanupBody, /cleanup\.normal_uninstaller/);
assert.match(normalCleanupBody, /-Status\s+["']pass["']/);
assert.match(normalCleanupBody, /-Status\s+["']fail["']/);
assert.match(normalCleanupBody, /catch\s*\{/);
assert.doesNotMatch(normalCleanupBody, /\.UninstallString\b|-Name\s+["']UninstallString["']/);
assert.doesNotMatch(normalCleanupBody, /Remove-Item|full-uninstall-lily-workbench/i);
assert.doesNotMatch(
  normalCleanupBody,
  /Get-LilyLegacyUninstallEntries|com\.company\.ai-super-terminal/,
  "normal cleanup must never acquire ownership of a legacy installation",
);
assert.match(runner, /function Get-LilyProcesses\b/);
assert.match(runner, /LilyWorkbench/);
assert.match(runner, /Lily Workbench/);
assert.match(runner, /lily-workbench/);
assert.match(runner, /智能工作台/);

assert.match(runner, /function Get-ProcessTreeIds\b/);
assert.match(runner, /Get-CimInstance\s+-ClassName\s+Win32_Process/);
assert.match(runner, /ParentProcessId/);
const captureDescendantsMatch = runner.match(
  /function Add-OwnedDescendantProcesses \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(
  captureDescendantsMatch,
  "Add-OwnedDescendantProcesses must capture descendants from discovery-only anchors.",
);
const captureDescendantsBody = captureDescendantsMatch[1];
for (const parameter of ["AnchorIds", "DepthById", "OwnedStartTicks", "Errors"]) {
  assert.match(captureDescendantsBody, new RegExp(`\\$${parameter}\\b`));
}
assert.match(
  captureDescendantsBody,
  /Get-CimInstance\s+-ClassName\s+Win32_Process\s+-ErrorAction\s+Stop/,
);
assert.match(captureDescendantsBody, /ParentProcessId/);
assert.match(captureDescendantsBody, /Get-ProcessStartTicks\s+-Process/);
assert.match(captureDescendantsBody, /\$OwnedStartTicks\[\$processKey\]\s*=\s*\[long\]/);
assert.match(captureDescendantsBody, /\$Errors\.Add\(["']Unable to enumerate/);
assert.match(captureDescendantsBody, /\$Errors\.Add\(["']Unable to verify start time/);
assert.doesNotMatch(
  captureDescendantsBody,
  /\$OwnedStartTicks\[[^\r\n]*\$anchorId/,
  "a discovery-only root anchor must never become PID-owned without a start time",
);

const stopOwnedTreeMatch = runner.match(
  /function Stop-OwnedProcessTree \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(stopOwnedTreeMatch, "Stop-OwnedProcessTree must be a standalone bounded cleanup helper.");
const stopOwnedTreeBody = stopOwnedTreeMatch[1];
for (const parameter of ["RootProcess", "RootId", "RootStartTicks", "KnownStartTicks"]) {
  assert.match(stopOwnedTreeBody, new RegExp(`\\$${parameter}\\b`));
}
assert.match(stopOwnedTreeBody, /Add-OwnedDescendantProcesses/);
assert.match(stopOwnedTreeBody, /Sort-Object[\s\S]{0,180}Descending/);
const knownIdentityImport = stopOwnedTreeBody.match(
  /foreach \(\$knownIdText in @\(\$KnownStartTicks\.Keys\)\) \{([\s\S]*?)\n  \}/,
)?.[1] ?? "";
assert.ok(knownIdentityImport, "known process identities must be imported before cleanup");
assert.doesNotMatch(
  knownIdentityImport,
  /\$depthById/,
  "known descendants must not all be assigned root depth",
);
assert.match(captureDescendantsBody, /\$foundDepth\s*=\s*\$true[\s\S]*while \(\$foundDepth\)/);
assert.match(stopOwnedTreeBody, /Stop-Process[\s\S]{0,100}-ErrorAction\s+Stop/);
assert.match(stopOwnedTreeBody, /\.Kill\(\)/, "an unreadable root start time still needs object-bound cleanup");
assert.match(stopOwnedTreeBody, /\.WaitForExit\([\s\S]{0,80}5000/);
assert.match(stopOwnedTreeBody, /Elapsed\.TotalSeconds\s+-lt\s+5/);
for (const property of ["stoppedIds", "remainingOwnedProcessIds", "errors"]) {
  assert.match(stopOwnedTreeBody, new RegExp(`${property}\\s*=`));
}
assert.doesNotMatch(
  stopOwnedTreeBody,
  /Stop-Process[^\r\n]*SilentlyContinue/,
  "owned cleanup must not hide Stop-Process failures",
);
const fallbackCondition = "if ($null -ne $RootProcess -and $null -eq $RootStartTicks)";
const fallbackStart = stopOwnedTreeBody.indexOf(fallbackCondition);
const fallbackKill = stopOwnedTreeBody.indexOf("$RootProcess.Kill()", fallbackStart);
const preKillCapture = stopOwnedTreeBody.indexOf("Add-OwnedDescendantProcesses", fallbackStart);
assert.ok(fallbackStart >= 0 && fallbackKill > fallbackStart, "the object-bound fallback must remain explicit");
assert.ok(
  preKillCapture > fallbackStart && preKillCapture < fallbackKill,
  "descendants must be captured from RootId before the object-bound root Kill()",
);
const fallbackBeforeKill = stopOwnedTreeBody.slice(fallbackStart, fallbackKill);
assert.match(fallbackBeforeKill, /-AnchorIds\s+@\(\[int\]\$RootId\)/);
assert.doesNotMatch(fallbackBeforeKill, /Stop-Process\s+-Id/);
const postKillCapture = stopOwnedTreeBody.indexOf("Add-OwnedDescendantProcesses", fallbackKill);
assert.ok(postKillCapture > fallbackKill, "the fallback must capture descendants again after Kill()");
assert.match(
  stopOwnedTreeBody,
  /if \(\$null -eq \$RootStartTicks[\s\S]{0,180}\$ownedProcessId\s+-eq\s+\[int\]\$RootId\) \{\s*continue/,
  "an unverified root PID must never be passed to Stop-Process",
);
const boundedCleanupLoop = stopOwnedTreeBody.slice(
  stopOwnedTreeBody.indexOf("$cleanupStopwatch ="),
  stopOwnedTreeBody.indexOf("$cleanupStopwatch.Stop()"),
);
assert.match(boundedCleanupLoop, /Add-OwnedDescendantProcesses/);
assert.match(boundedCleanupLoop, /-AnchorIds\s+@\(\[int\]\$RootId\)/);
assert.match(boundedCleanupLoop, /Stop-Process\s+-Id/);
assert.match(boundedCleanupLoop, /Get-ProcessStartTicks\s+-Process/);

const monitoredProcessMatch = runner.match(
  /function Invoke-MonitoredProcess \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(monitoredProcessMatch, "Invoke-MonitoredProcess must remain a standalone helper.");
const monitoredProcessBody = monitoredProcessMatch[1];
assert.match(monitoredProcessBody, /try\s*\{[\s\S]*Start-Process[\s\S]*-PassThru/);
assert.match(monitoredProcessBody, /catch\s*\{/);
assert.match(monitoredProcessBody, /Stop-OwnedProcessTree/);
assert.match(monitoredProcessBody, /\$Label\s*\+\s*["']\.monitor_exception_cleanup["']/);
assert.match(monitoredProcessBody, /Add-Check[\s\S]{0,500}-Status\s+\$cleanupStatus/);
assert.match(monitoredProcessBody, /remainingOwnedProcessIds/);
assert.match(monitoredProcessBody, /throw\s+\$originalException/);
const monitorExceptionPath = monitoredProcessBody.match(
  /catch \{\s*\$originalException\s*=\s*\$_\.Exception([\s\S]*?)throw\s+\$originalException/,
)?.[1] ?? "";
assert.ok(monitorExceptionPath, "the monitor exception path must be extractable");
assert.match(
  monitorExceptionPath,
  /try\s*\{[\s\S]*Stop-OwnedProcessTree[\s\S]*\}\s*catch\s*\{[\s\S]*cleanup helper/i,
  "cleanup-helper failure must become evidence without replacing the original monitor exception",
);
assert.match(
  monitoredProcessBody.slice(monitoredProcessBody.indexOf("if ($timedOut)")),
  /Stop-OwnedProcessTree/,
  "timeout cleanup must reuse the verified bounded tree cleanup",
);
assert.doesNotMatch(
  monitoredProcessBody,
  /Start-Process[\s\S]{0,300}throw\s+\(["']Unable to read the start time/,
  "a post-start failure must not use a naked throw before exception cleanup",
);
assert.match(monitoredProcessBody, /visibleWindows/);
assert.match(monitoredProcessBody, /150/);
assert.match(monitoredProcessBody, /Get-VisibleTopLevelWindows\s+-ProcessIds\s+\$lastActiveIds/);
assert.doesNotMatch(
  monitoredProcessBody,
  /\.MainWindowHandle\b/,
  "Process.MainWindowHandle must not be the only silent-UI evidence",
);

assert.match(
  runner,
  /["']--remote-debugging-address=127\.0\.0\.1["']/,
  "the launch probe must keep Chromium debugging on loopback",
);
assert.match(runner, /--remote-debugging-port=/);
assert.match(runner, /["']--enable-logging=file["']/);
assert.match(runner, /--log-file=/);
assert.match(runner, /chromium\.log/);

const freePortMatch = runner.match(/function Get-FreeLoopbackPort \{([\s\S]*?)\n\}\n\nfunction /);
assert.ok(freePortMatch, "Get-FreeLoopbackPort must remain a standalone helper.");
assert.match(freePortMatch[1], /System\.Net\.Sockets\.TcpListener/);
assert.match(freePortMatch[1], /System\.Net\.IPAddress\]::Loopback/);
assert.match(freePortMatch[1], /,\s*0\s*\)/);
assert.match(freePortMatch[1], /\.Start\(\)/);
assert.match(freePortMatch[1], /finally\s*\{/);
assert.match(freePortMatch[1], /\.Stop\(\)/);
assert.match(freePortMatch[1], /\.LocalEndpoint\.Port/);

const waitRendererMatch = runner.match(/function Wait-LilyRenderer \{([\s\S]*?)\n\}\n\nfunction /);
assert.ok(waitRendererMatch, "Wait-LilyRenderer must remain a standalone helper.");
const waitRendererBody = waitRendererMatch[1];
assert.match(waitRendererBody, /\[int\]\$Port/);
assert.match(waitRendererBody, /\[int\]\$ProcessId/);
assert.match(waitRendererBody, /\[int\]\$TimeoutSeconds/);
for (const title of ["Lily Workbench", "智能工作台", "Smart Workbench", "منصة العمل الذكية"]) {
  assert.ok(waitRendererBody.includes(`"${title}"`), `known renderer titles must include ${title}`);
}
assert.match(waitRendererBody, /Get-Process\s+-Id\s+\$ProcessId/);
assert.match(waitRendererBody, /Get-ProcessTreeIds\s+-RootId\s+\$ProcessId/);
assert.match(waitRendererBody, /Get-VisibleTopLevelWindows\s+-ProcessIds\s+\$lastProcessIds/);
assert.doesNotMatch(waitRendererBody, /\.MainWindowHandle\b/);
assert.match(
  waitRendererBody,
  /\$targetResponse\s*=\s*Invoke-RestMethod/,
  "PowerShell 5.1 CDP responses must be captured before their root array is expanded",
);
assert.match(waitRendererBody, /\$targets\s*=\s*@\(\s*\$targetResponse\s*\|\s*Write-Output\s*\)/);
assert.match(waitRendererBody, /Invoke-RestMethod/);
assert.match(waitRendererBody, /http:\/\/127\.0\.0\.1/);
assert.match(waitRendererBody, /\/json\/list/);
assert.match(waitRendererBody, /-TimeoutSec\s+2/);
assert.match(waitRendererBody, /["']type["'][\s\S]{0,120}["']page["']/);
assert.match(waitRendererBody, /Test-LilyPackagedRendererUrl\s+-Url\s+\$targetUrl/);
assert.doesNotMatch(
  waitRendererBody,
  /\$targetUrl\s+-match\s+["'][^"']*renderer[^"']*index\\?\.html/i,
  "renderer readiness must not accept an unanchored URL substring",
);
assert.match(
  waitRendererBody,
  /\$null\s+-ne\s+\$rendererTarget\s+-and\s+\$null\s+-ne\s+\$visibleWindow/,
);
assert.match(waitRendererBody, /Start-Sleep\s+-Milliseconds\s+250/);
assert.match(waitRendererBody, /target\s*=\s*\$rendererTarget/);
assert.match(waitRendererBody, /visibleWindow\s*=\s*\$visibleWindow/);
assert.equal(
  waitRendererBody.match(/\$visibleWindow\s*=\s*\$null/g)?.length ?? 0,
  1,
  "the first observed visible window must survive later polling iterations",
);
assert.match(
  waitRendererBody,
  /\$null\s+-eq\s+\$visibleWindow[\s\S]{0,180}\$visibleTopLevelWindows\.Count\s+-gt\s+0/,
  "later windows must not replace the first visible-window evidence",
);

const crashEventsMatch = runner.match(/function Get-LilyCrashEvents \{([\s\S]*?)\n\}\n\nfunction /);
assert.ok(crashEventsMatch, "Get-LilyCrashEvents must remain a standalone helper.");
const crashEventsBody = crashEventsMatch[1];
assert.match(crashEventsBody, /\[datetime\]\$StartTime/);
assert.match(crashEventsBody, /Get-WinEvent/);
assert.match(crashEventsBody, /LogName\s*=\s*["']Application["']/);
assert.match(crashEventsBody, /StartTime\s*=\s*\$StartTime/);
assert.match(crashEventsBody, /-ErrorAction\s+Stop/);
assert.match(crashEventsBody, /Application Error/);
assert.match(crashEventsBody, /Windows Error Reporting/);
assert.match(crashEventsBody, /LilyWorkbench\\\.exe/);
assert.match(crashEventsBody, /Lily Workbench\\\.exe/);
assert.doesNotMatch(crashEventsBody, /Get-WinEvent[^\r\n]*SilentlyContinue/);
assert.match(crashEventsBody, /Write-JsonEvidence[\s\S]*startup-event-log\.json/);

const launchProbeMatch = runner.match(/function Invoke-LilyLaunchProbe \{([\s\S]*?)\n\}\n\nfunction /);
assert.ok(launchProbeMatch, "Invoke-LilyLaunchProbe must remain a standalone helper.");
const launchProbeBody = launchProbeMatch[1];
assert.match(launchProbeBody, /\[string\]\$MainExe/);
assert.match(launchProbeBody, /\[int\]\$TimeoutSeconds/);
assert.match(launchProbeBody, /Get-FreeLoopbackPort/);
assert.match(launchProbeBody, /Join-Path[\s\S]{0,120}chromium\.log/);
assert.match(launchProbeBody, /\$startedAt\s*=\s*Get-Date/);
assert.match(launchProbeBody, /Start-Process\s+-FilePath\s+\$MainExe[\s\S]*-PassThru/);
assert.match(launchProbeBody, /Wait-LilyRenderer[\s\S]*-Port\s+\$port[\s\S]*-ProcessId/);
assert.match(launchProbeBody, /\$rendererProbe\s*=\s*\[pscustomobject\]/);
assert.match(launchProbeBody, /\.CloseMainWindow\(\)/);
assert.match(launchProbeBody, /Wait-Process[\s\S]{0,160}-Timeout\s+15/);
assert.match(launchProbeBody, /finally\s*\{[\s\S]*Get-LilyCrashEvents\s+-StartTime\s+\$startedAt/);
assert.match(launchProbeBody, /Get-ProcessStartTicks/);
assert.match(launchProbeBody, /Get-ProcessTreeIds/);
assert.match(launchProbeBody, /Stop-Process[\s\S]{0,120}-Force/);
const forcedCleanupBody = launchProbeBody.slice(launchProbeBody.indexOf("Stop-Process"));
assert.match(forcedCleanupBody, /\$cleanupStopwatch\s*=\s*\[System\.Diagnostics\.Stopwatch\]::StartNew\(\)/);
assert.match(forcedCleanupBody, /\$cleanupStopwatch\.Elapsed\.TotalSeconds\s+-lt\s+5/);
assert.match(forcedCleanupBody, /Get-Process\s+-Id\s+\$cleanupId/);
assert.match(forcedCleanupBody, /Get-ProcessStartTicks\s+-Process\s+\$cleanupProcess/);
assert.match(
  forcedCleanupBody,
  /\[long\]\$cleanupTicks\s+-eq\s+\[long\]\$cleanupStartTicks\[\$cleanupIdText\]/,
);
assert.match(forcedCleanupBody, /\$remainingOwnedProcessIds/);
assert.doesNotMatch(
  forcedCleanupBody,
  /\$remainingOwnedProcessIds\s*=\s*@\(\$ownedStartTicks\.Keys/,
  "a cleanup exception must not report an unverified or PID-reused process as still owned",
);
for (const property of [
  "processId",
  "remainedAlive",
  "visibleWindow",
  "rendererTarget",
  "closedNormally",
  "crashEvents",
  "chromiumLog",
  "remainingOwnedProcessIds",
]) {
  assert.match(launchProbeBody, new RegExp(`${property}\\s*=`));
}

const launchMainMatch = runner.match(
  /\$launchResult\s*=\s*Invoke-LilyLaunchProbe([\s\S]*?)\n\} catch \{/,
);
assert.ok(launchMainMatch, "the main readiness flow must invoke the launch probe.");
const launchMainBody = launchMainMatch[0];
assert.match(launchMainBody, /-MainExe\s+\$applicationPath/);
assert.match(launchMainBody, /-TimeoutSeconds\s+\$LaunchTimeoutSeconds/);
assert.match(launchMainBody, /\$launchRemainingOwnedProcessIds\s*=\s*@\(\$launchResult\.remainingOwnedProcessIds\)/);

function getLaunchCheck(id) {
  const escapedId = id.replaceAll(".", "\\.");
  const match = launchMainBody.match(
    new RegExp(
      `Require-Check[\\s\\S]*?-Id "${escapedId}"([\\s\\S]*?)(?=\\n\\s*Require-Check|\\n\\} catch \\{)`,
    ),
  );
  assert.ok(match, `${id} must be enforced with Require-Check in the main flow.`);
  assert.match(match[0], /-Evidence\s+\$launchResult/);
  return match[0];
}

assert.match(getLaunchCheck("launch.visible_window"), /\$launchResult\.visibleWindow/);
assert.match(getLaunchCheck("launch.renderer_ready"), /\$launchResult\.rendererTarget/);
assert.match(getLaunchCheck("launch.probe"), /\$launchResult\.probeError/);
const cleanupCheck = getLaunchCheck("launch.cleanup");
assert.match(cleanupCheck, /\$launchResult\.cleanupError/);
assert.match(cleanupCheck, /\$launchRemainingOwnedProcessIds\.Count\s+-eq\s+0/);
const chromiumLogCheck = getLaunchCheck("launch.chromium_log");
assert.match(
  chromiumLogCheck,
  /Test-Path\s+-LiteralPath\s+\$launchResult\.chromiumLog\s+-PathType\s+Leaf/,
);
assert.match(getLaunchCheck("launch.no_crash_event"), /\$launchCrashEvents\.Count\s+-eq\s+0/);
assert.match(getLaunchCheck("launch.normal_close"), /\$launchResult\.closedNormally/);
assert.match(runner, /evidenceFiles\s*=\s*@\([\s\S]*chromium\.log[\s\S]*startup-event-log\.json/);
assert.match(runner, /\$script:Report\["evidence"\]\["chromium\.log"\]/);

assert.match(runner, /\$script:InstallDirectory\s*=\s*\$installDirectory/);
assert.match(launchMainBody, /\$uninstallCommand\s*=\s*Resolve-UninstallCommand/);
assert.match(launchMainBody, /Record-UninstallQuietContract\s+-Command\s+\$uninstallCommand/);
assert.match(launchMainBody, /\$uninstallResult\s*=\s*Invoke-SilentUninstall/);
for (const checkId of [
  "uninstall.quiet_contract",
  "uninstall.completed_in_time",
  "uninstall.exit_code",
  "uninstall.no_visible_ui",
  "uninstall.product_entry_removed",
  "uninstall.install_directory_removed",
  "uninstall.shortcuts_removed",
]) {
  assert.ok(runner.includes(`-Id "${checkId}"`), `${checkId} must be recorded`);
}
assert.match(launchMainBody, /\$uninstallResult\.process\.timedOut/);
assert.match(launchMainBody, /\$uninstallResult\.process\.exitCode/);
assert.match(launchMainBody, /\$uninstallResult\.process\.visibleWindows/);
assert.match(launchMainBody, /\$uninstallResult\.productEntryRemoved/);
assert.match(launchMainBody, /\$uninstallResult\.installDirectoryRemoved/);
assert.match(launchMainBody, /Get-LilyShortcuts/);
assert.match(launchMainBody, /Get-LilyUserDataResidues/);
assert.match(launchMainBody, /uninstall\.user_data_residue/);
assert.match(launchMainBody, /\$AllowUserDataRemnants/);
assert.match(launchMainBody, /-Status\s+"warning"/);
assert.match(launchMainBody, /-Status\s+"fail"/);

const wackCheck = runner.match(
  /Add-Check[\s\S]{0,180}-Id "certification\.wack"[\s\S]{0,600}/,
)?.[0] ?? "";
assert.ok(wackCheck, "certification.wack must be explicitly recorded");
assert.match(wackCheck, /-Status "not_applicable"/);
assert.match(wackCheck, /unpackaged NSIS EXE/);
assert.match(wackCheck, /packaged AppX\/MSIX/);
assert.doesNotMatch(runner, /-apptype\s+desktop/i);

assert.match(runner, /function Test-PortableExecutable\b/);
assert.match(runner, /\[System\.IO\.FileShare\]::ReadWrite/);
assert.match(runner, /0x4D/);
assert.match(runner, /0x5A/);
assert.match(runner, /\.Dispose\(\)/);
assert.match(runner, /function Get-SignatureRecord\b/);
assert.match(runner, /Get-AuthenticodeSignature\s+-LiteralPath/);
assert.match(runner, /signerSubject/);
assert.match(runner, /signerSimpleName/);
assert.match(runner, /GetNameInfo\(/);
assert.match(runner, /X509NameType\]::SimpleName/);
assert.match(runner, /GetNameInfo\([\s\S]{0,180}\$false\s*\)/);
assert.match(runner, /thumbprint/);
const normalizePublisherMatch = runner.match(
  /function Normalize-PublisherName \{([\s\S]*?)\n\}\n\nfunction /,
);
assert.ok(normalizePublisherMatch, "Normalize-PublisherName must be a standalone helper.");
assert.match(normalizePublisherMatch[1], /\.Trim\(\)/);
assert.match(normalizePublisherMatch[1], /\.Normalize\(/);
assert.match(normalizePublisherMatch[1], /NormalizationForm\]::Form(?:KC|C)/);
assert.match(runner, /function Get-PeSignatureInventory\b/);
assert.match(runner, /function Resolve-InstallDirectory\b/);
assert.match(runner, /function Get-LilyShortcuts\b/);
assert.match(runner, /CommonDesktop/);
assert.match(runner, /CommonStartMenu/);

assert.match(runner, /WindowsPrincipal/);
assert.match(runner, /IsInRole/);
assert.match(runner, /Administrator/);
assert.match(runner, /registry-before\.json/);
assert.match(runner, /registry-installed\.json/);
assert.match(runner, /registry-after\.json/);
assert.match(runner, /user-data-residue\.json/);
assert.match(runner, /signature-inventory\.json/);
assert.match(runner, /\$script:InstalledEntry/);
assert.match(runner, /LilyWorkbench\.exe/);
assert.match(runner, /OrdinalIgnoreCase/);
assert.doesNotMatch(runner, /\[string\]::IndexOf\s*\(/);
assert.match(
  runner,
  /\$signerMatchesExpectedPublisher\s*=\s*\[string\]::Equals\(\s*\$normalizedSignerSimpleName,\s*\$normalizedExpectedPublisher,\s*\[System\.StringComparison\]::OrdinalIgnoreCase\s*\)/,
);
assert.match(
  runner,
  /\$arpPublisherMatches\s*=\s*\[string\]::Equals\(\s*\$normalizedArpPublisher,\s*\$normalizedExpectedPublisher,\s*\[System\.StringComparison\]::OrdinalIgnoreCase\s*\)/,
);
const signerComparisonIndex = runner.indexOf('$signerMatchesExpectedPublisher =');
const arpComparisonIndex = runner.indexOf('$arpPublisherMatches =');
const installerPublisherBlock = runner.slice(
  runner.lastIndexOf('if (-not [string]::IsNullOrWhiteSpace($ExpectedPublisher))', signerComparisonIndex),
  runner.indexOf('$script:InstallAttemptStarted = $true'),
);
const arpPublisherBlock = runner.slice(
  runner.lastIndexOf('if (-not [string]::IsNullOrWhiteSpace($ExpectedPublisher))', arpComparisonIndex),
  runner.indexOf('if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion))'),
);
assert.match(installerPublisherBlock, /installerSignature\.signerSimpleName/);
assert.match(installerPublisherBlock, /Normalize-PublisherName/);
assert.match(arpPublisherBlock, /InstalledEntry\.Publisher/);
assert.match(arpPublisherBlock, /Normalize-PublisherName/);
assert.doesNotMatch(installerPublisherBlock, /\.IndexOf\(|\.Contains\(/);
assert.doesNotMatch(arpPublisherBlock, /\.IndexOf\(|\.Contains\(/);
assert.match(runner, /Get-FileHash[^\r\n]*SHA256/);
assert.doesNotMatch(runner, /\bRemove-Item\b/i);
assert.doesNotMatch(runner, /full-uninstall-lily-workbench/i);

const mainFinallyStart = runner.lastIndexOf("} finally {");
const mainFinallyEnd = runner.lastIndexOf("\n}\n\nexit $exitCode");
assert.ok(mainFinallyStart >= 0 && mainFinallyEnd > mainFinallyStart, "the main flow must have a finalization block");
const mainFinallyBody = runner.slice(mainFinallyStart + "} finally {".length, mainFinallyEnd);
assert.match(
  mainFinallyBody,
  /if \(\$script:InstallAttemptStarted\s+-and\s+\$remainingEntriesBeforeCleanup\.Count\s+-gt\s+0\) \{\s*Try-NormalUninstallCleanup/,
  "finally may use the normal registered uninstaller only after this run attempted installation",
);
assert.doesNotMatch(
  mainFinallyBody,
  /if \(\$remainingEntriesBeforeCleanup\.Count\s+-gt\s+0\) \{\s*Try-NormalUninstallCleanup/,
  "a pre-existing ARP entry must never grant this run cleanup ownership",
);
const cleanupAttemptIndex = mainFinallyBody.indexOf("Try-NormalUninstallCleanup");
const registryAfterIndex = mainFinallyBody.search(
  /Write-JsonEvidence[\s\S]{0,80}-FileName "registry-after\.json"/,
);
assert.ok(cleanupAttemptIndex >= 0 && registryAfterIndex > cleanupAttemptIndex);
assert.match(mainFinallyBody, /\$registryAfter\s*=\s*@\(Get-LilyUninstallEntries\)/);
assert.match(mainFinallyBody, /cleanup\.registry_after/);
assert.equal(
  runner.match(/Write-JsonEvidence[\s\S]{0,80}-FileName "registry-after\.json"/g)?.length ?? 0,
  1,
  "registry-after evidence must be a single real post-cleanup snapshot",
);
assert.match(mainFinallyBody, /Get-LilyInstallResidues/);
assert.match(mainFinallyBody, /cleanup\.install_residue/);
assert.match(mainFinallyBody, /Get-LilyShortcuts/);
assert.match(mainFinallyBody, /cleanup\.shortcut_residue/);
assert.match(mainFinallyBody, /Get-LilyUserDataResidues/);
assert.match(mainFinallyBody, /Write-JsonEvidence[\s\S]{0,80}-FileName "user-data-residue\.json"/);
assert.match(mainFinallyBody, /cleanup\.user_data_residue/);
assert.match(mainFinallyBody, /\$AllowUserDataRemnants/);

const stopTranscriptIndex = mainFinallyBody.indexOf("Stop-Transcript");
const finalExitCalculationIndex = mainFinallyBody.indexOf("$failedChecks =");
const writeReportsIndex = mainFinallyBody.indexOf("Write-Reports");
const writeSentinelIndex = mainFinallyBody.indexOf("Set-Content -LiteralPath $exitCodePath");
assert.ok(stopTranscriptIndex >= 0 && finalExitCalculationIndex > stopTranscriptIndex);
assert.ok(finalExitCalculationIndex > mainFinallyBody.indexOf("cleanup.install_residue"));
assert.ok(finalExitCalculationIndex > mainFinallyBody.indexOf("cleanup.user_data_residue"));
assert.ok(writeReportsIndex > finalExitCalculationIndex);
assert.ok(writeSentinelIndex > writeReportsIndex);
assert.match(mainFinallyBody, /try\s*\{[\s\S]{0,180}Write-Reports[\s\S]{0,180}catch\s*\{[\s\S]{0,120}\$exitCode\s*=\s*1/);
assert.match(mainFinallyBody, /try\s*\{[\s\S]{0,180}Set-Content\s+-LiteralPath\s+\$exitCodePath/);

const mainTryStart = runner.indexOf("\ntry {", runner.indexOf("$exitCode = 1"));
const mainTryEnd = runner.indexOf("\n} catch {", mainTryStart);
assert.ok(mainTryStart >= 0 && mainTryEnd > mainTryStart, "the main readiness try body must be extractable");
const mainTryBody = runner.slice(mainTryStart + "\ntry {".length, mainTryEnd);
const cleanRegistryGateIndex = mainTryBody.indexOf('-Id "preflight.clean_registry"');
const legacyRegistryLookupIndex = mainTryBody.indexOf("Get-LilyLegacyUninstallEntries");
const legacyRegistryGateIndex = mainTryBody.indexOf('-Id "preflight.no_legacy_install"');
const windowsPreflightIndex = mainTryBody.indexOf('-Id "preflight.windows"');
const nativeInitializationIndex = mainTryBody.indexOf("Initialize-NativeCommandLine");
const installOwnershipIndex = mainTryBody.indexOf("$script:InstallAttemptStarted = $true");
const installerInvocationIndex = mainTryBody.indexOf("$installResult = Invoke-MonitoredProcess");
assert.ok(cleanRegistryGateIndex >= 0, "the clean-registry gate must remain in the main flow");
assert.ok(legacyRegistryLookupIndex >= 0, "the main flow must inspect the exact legacy appId key");
assert.ok(legacyRegistryGateIndex >= 0, "the legacy-install preflight gate must be named");
assert.match(
  mainTryBody.slice(legacyRegistryLookupIndex, legacyRegistryGateIndex + 500),
  /\$legacyEntries\.Count\s*-eq\s*0/,
);
assert.ok(
  legacyRegistryLookupIndex < legacyRegistryGateIndex &&
    legacyRegistryGateIndex < cleanRegistryGateIndex &&
    legacyRegistryGateIndex < installOwnershipIndex,
  "legacy installation detection must fail before the current ARP gate and before cleanup ownership",
);
assert.ok(
  nativeInitializationIndex > windowsPreflightIndex && nativeInitializationIndex < installOwnershipIndex,
  "native command-line initialization must run inside main try after Windows preflight and before install ownership",
);
assert.ok(
  installOwnershipIndex > cleanRegistryGateIndex && installerInvocationIndex > installOwnershipIndex,
  "cleanup ownership must be acquired after the clean-registry gate and immediately before invoking this run's installer",
);

assert.match(runner, /readiness-report\.json/);
assert.match(runner, /readiness-summary\.md/);
assert.match(runner, /readiness-transcript\.log/);
assert.match(runner, /readiness-exit-code\.txt/);
assert.match(runner, /ConvertTo-Json -Depth 8/);
assert.match(runner, /exit \$exitCode\s*$/);

const launcherParameters = launcher.match(/param\((?<body>[\s\S]*?)\n\)/)?.groups?.body ?? "";
assert.ok(launcherParameters, "the Sandbox launcher must declare a parameter block");
assert.match(
  launcherParameters,
  /\[Parameter\(Mandatory\s*=\s*\$true\)\]\s*\[string\]\$Installer/,
);
assert.match(launcherParameters, /\[string\]\$ExpectedPublisher\s*=\s*["']{2}/);
assert.match(launcherParameters, /\[string\]\$ExpectedVersion\s*=\s*["']{2}/);
assert.match(launcherParameters, /\[switch\]\$RequireSignature/);
assert.match(launcherParameters, /\[switch\]\$AllowUserDataRemnants/);
assert.match(
  launcherParameters,
  /\[ValidateRange\(60,\s*1800\)\]\s*\[int\]\$SandboxTimeoutSeconds\s*=\s*600/,
);

assert.match(launcher, /Set-StrictMode -Version Latest/);
assert.match(launcher, /\$ErrorActionPreference\s*=\s*["']Stop["']/);
assert.match(launcher, /\$env:OS\s+-ne\s+["']Windows_NT["']/);
assert.match(
  launcher,
  /Join-Path[\s\S]{0,120}\$env:WINDIR[\s\S]{0,120}["']System32[\\/]WindowsSandbox\.exe["']/,
);
assert.match(
  launcher,
  /Test-Path\s+-LiteralPath\s+\$sandboxExecutable\s+-PathType\s+Leaf/,
);
assert.match(launcher, /Containers-DisposableClientVM/);
assert.match(launcher, /restart/i);
assert.doesNotMatch(launcher, /\bEnable-WindowsOptionalFeature\b|\bdism(?:\.exe)?\b/i);

assert.match(
  launcher,
  /\$resolvedInstaller\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\$Installer\s+-ErrorAction\s+Stop\)\.ProviderPath/,
);
assert.match(launcher, /\$repoRoot\s*=[^\r\n]*\$PSScriptRoot/);
assert.match(launcher, /["']\.lily-work["']/);
assert.match(launcher, /["']windows-store-readiness["']/);
assert.match(launcher, /Get-Date\s+-Format\s+["']yyyyMMdd-HHmmssfff["']/);
assert.match(launcher, /\[Guid\]::NewGuid\(\)\.ToString\(["']N["']\)/);
assert.match(launcher, /\$resultsDirectory\s*=\s*Join-Path\s+\$stage\s+["']results["']/);
assert.match(
  launcher,
  /Test-Path\s+-LiteralPath\s+\$smokeRunnerPath\s+-PathType\s+Leaf/,
);
assert.match(
  launcher,
  /Copy-Item\s+-LiteralPath\s+\$smokeRunnerPath\s+-Destination\s+\$stagedSmokeRunner/,
);
assert.match(
  launcher,
  /Copy-Item\s+-LiteralPath\s+\$resolvedInstaller\s+-Destination\s+\$stagedInstaller/,
);

const sandboxOptions = launcher.match(
  /\$sandboxOptions\s*=\s*\[ordered\]@\{(?<body>[\s\S]*?)\n\}/,
)?.groups?.body ?? "";
assert.ok(sandboxOptions, "the launcher must build sandbox-options.json from typed parameters");
assert.match(sandboxOptions, /installerFile\s*=\s*\$installerFile/);
assert.match(sandboxOptions, /expectedPublisher\s*=\s*\$ExpectedPublisher/);
assert.match(sandboxOptions, /expectedVersion\s*=\s*\$ExpectedVersion/);
assert.match(sandboxOptions, /requireSignature\s*=\s*\[bool\]\$RequireSignature/);
assert.match(
  sandboxOptions,
  /allowUserDataRemnants\s*=\s*\[bool\]\$AllowUserDataRemnants/,
);
assert.match(
  launcher,
  /\$sandboxOptions\s*\|\s*ConvertTo-Json\s+-Depth\s+4\s*\|\s*Set-Content[\s\S]{0,160}-Encoding\s+UTF8/,
);
assert.match(launcher, /["']sandbox-options\.json["']/);

const bootstrap = launcher.match(
  /\$bootstrapContent\s*=\s*@'(?<body>[\s\S]*?)'@/,
)?.groups?.body ?? "";
assert.ok(bootstrap, "the sandbox bootstrap must be a fixed literal here-string");
assert.match(bootstrap, /Set-StrictMode -Version Latest/);
assert.match(bootstrap, /\$ErrorActionPreference\s*=\s*"Stop"/);
assert.match(bootstrap, /\$root\s*=\s*"C:\\LilyStoreReadiness"/);
assert.match(
  bootstrap,
  /Get-Content\s+-LiteralPath\s+\$optionsPath\s+-Raw\s+-Encoding\s+UTF8\s*\|\s*ConvertFrom-Json/,
);
assert.match(bootstrap, /"sandbox-options\.json"/);
assert.match(bootstrap, /"smoke-windows-store-installer\.ps1"/);
assert.match(bootstrap, /"results"/);
assert.match(bootstrap, /\$runnerParameters\s*=\s*@\{/);
assert.match(bootstrap, /Installer\s*=\s*Join-Path\s+\$root\s+\(\[string\]\$options\.installerFile\)/);
assert.match(bootstrap, /OutputDirectory\s*=\s*\$outputDirectory/);
for (const optionalProperty of [
  "expectedPublisher",
  "expectedVersion",
  "requireSignature",
  "allowUserDataRemnants",
]) {
  assert.match(bootstrap, new RegExp(`\\$options\\.${optionalProperty}`));
}
for (const optionalParameter of [
  "ExpectedPublisher",
  "ExpectedVersion",
  "RequireSignature",
  "AllowUserDataRemnants",
]) {
  assert.match(bootstrap, new RegExp(`\\$runnerParameters\\["${optionalParameter}"\\]\\s*=`));
}
assert.match(bootstrap, /&\s+\$runnerPath\s+@runnerParameters/);
assert.doesNotMatch(
  bootstrap,
  /\$(?:ExpectedPublisher|ExpectedVersion|RequireSignature|AllowUserDataRemnants)\b/,
  "host dynamic values must not be interpolated into the fixed bootstrap",
);
assert.match(
  launcher,
  /Set-Content\s+-LiteralPath\s+\$bootstrapPath\s+-Value\s+\$bootstrapContent\s+-Encoding\s+ASCII/,
);

const sandboxCommand = launcher.match(
  /\$commandContent\s*=\s*@'(?<body>[\s\S]*?)'@/,
)?.groups?.body ?? "";
assert.ok(sandboxCommand, "the Sandbox logon command must be a fixed literal cmd script");
assert.match(
  sandboxCommand,
  /powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\LilyStoreReadiness\\sandbox-bootstrap\.ps1"/,
);
assert.match(sandboxCommand, /if exist "C:\\LilyStoreReadiness\\results\\readiness-summary\.md"/i);
assert.match(sandboxCommand, /notepad\.exe "C:\\LilyStoreReadiness\\results\\readiness-summary\.md"/i);
assert.match(sandboxCommand, /exit \/b %LILY_READINESS_EXIT_CODE%/i);
const fallbackSentinel = sandboxCommand.match(
  /if not exist "C:\\LilyStoreReadiness\\results\\readiness-exit-code\.txt" \((?<body>[\s\S]*?)\n\)/i,
)?.groups?.body ?? "";
assert.ok(
  fallbackSentinel,
  "cmd must synthesize a sentinel only when the smoke runner did not write one",
);
const fallbackTempWriteIndex = fallbackSentinel.search(
  />\s*"C:\\LilyStoreReadiness\\results\\readiness-exit-code\.tmp"\s+echo %LILY_READINESS_EXIT_CODE%/i,
);
const fallbackAtomicMoveIndex = fallbackSentinel.search(
  /move \/y "C:\\LilyStoreReadiness\\results\\readiness-exit-code\.tmp" "C:\\LilyStoreReadiness\\results\\readiness-exit-code\.txt"/i,
);
assert.ok(fallbackTempWriteIndex >= 0, "cmd must write the captured PowerShell exit code to a temporary sentinel");
assert.ok(
  fallbackAtomicMoveIndex > fallbackTempWriteIndex,
  "cmd must atomically rename the completed temporary sentinel without overwriting a runner sentinel",
);
assert.doesNotMatch(
  sandboxCommand,
  /ExpectedPublisher|ExpectedVersion|RequireSignature|AllowUserDataRemnants/,
);
assert.match(
  launcher,
  /Set-Content\s+-LiteralPath\s+\$commandPath\s+-Value\s+\$commandContent\s+-Encoding\s+ASCII/,
);

assert.match(
  launcher,
  /\[Security\.SecurityElement\]::Escape\(\$stage\)/,
  "the mapped host path must be XML-escaped",
);
const sandboxConfiguration = launcher.match(
  /\$sandboxConfiguration\s*=\s*@"(?<body>[\s\S]*?)"@/,
)?.groups?.body ?? "";
assert.ok(sandboxConfiguration, "the launcher must emit a Windows Sandbox configuration");
assert.match(sandboxConfiguration, /<Networking>Disable<\/Networking>/);
assert.match(sandboxConfiguration, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/);
assert.equal(
  sandboxConfiguration.match(/<MappedFolder>/g)?.length ?? 0,
  1,
  "only the unique readiness stage may be mapped into Sandbox",
);
assert.match(sandboxConfiguration, /<HostFolder>\$escapedStage<\/HostFolder>/);
assert.match(
  sandboxConfiguration,
  /<SandboxFolder>C:\\LilyStoreReadiness<\/SandboxFolder>/,
);
assert.match(sandboxConfiguration, /<ReadOnly>false<\/ReadOnly>/);
assert.match(sandboxConfiguration, /<LogonCommand>/);
assert.match(
  sandboxConfiguration,
  /<Command>cmd\.exe \/c "C:\\LilyStoreReadiness\\run-readiness\.cmd"<\/Command>/,
);
assert.doesNotMatch(
  sandboxConfiguration,
  /ExpectedPublisher|ExpectedVersion|RequireSignature|AllowUserDataRemnants/,
);
assert.match(
  launcher,
  /Set-Content\s+-LiteralPath\s+\$wsbPath\s+-Value\s+\$sandboxConfiguration\s+-Encoding\s+UTF8/,
);

assert.match(
  launcher,
  /Start-Process[\s\S]{0,200}-FilePath\s+\$sandboxExecutable[\s\S]{0,200}-ArgumentList\s+@\(\s*"`"\$wsbPath`""\s*\)/,
);
assert.match(launcher, /["']readiness-exit-code\.txt["']/);
assert.match(launcher, /["']readiness-summary\.md["']/);
const sentinelPollingStart = launcher.indexOf(
  "$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()",
);
const sentinelPollingEnd = launcher.indexOf("$stopwatch.Stop()", sentinelPollingStart);
assert.ok(
  sentinelPollingStart >= 0 && sentinelPollingEnd > sentinelPollingStart,
  "the host sentinel deadline loop must be extractable",
);
const sentinelPolling = launcher.slice(sentinelPollingStart, sentinelPollingEnd);
assert.match(
  sentinelPolling,
  /while \(\$stopwatch\.Elapsed\.TotalSeconds\s+-lt\s+\$SandboxTimeoutSeconds\)/,
);
assert.match(
  sentinelPolling,
  /Test-Path\s+-LiteralPath\s+\$exitCodePath\s+-PathType\s+Leaf/,
);
assert.match(
  sentinelPolling,
  /\$candidateExitCodeText\s*=\s*\(Get-Content\s+-LiteralPath\s+\$exitCodePath\s+-Raw\s+-Encoding\s+ASCII\)\.Trim\(\)/,
);
const parseSuccess = sentinelPolling.match(
  /if \(\[int\]::TryParse\(\$candidateExitCodeText,\s*\[ref\]\$candidateExitCode\)\) \{(?<body>[\s\S]*?)\n\s*\}/,
)?.groups?.body ?? "";
assert.ok(parseSuccess, "the host must validate sentinel contents inside the deadline loop");
assert.match(parseSuccess, /\$innerExitCode\s*=\s*\$candidateExitCode/);
assert.match(parseSuccess, /\$sentinelParsed\s*=\s*\$true/);
assert.match(parseSuccess, /\bbreak\b/);
assert.equal(
  sentinelPolling.match(/\bbreak\b/g)?.length ?? 0,
  1,
  "only a successfully parsed integer sentinel may end polling",
);
const transientReadCatch = sentinelPolling.match(
  /catch\s*\{(?<body>[\s\S]*?)\n\s*\}/,
)?.groups?.body ?? "";
assert.match(transientReadCatch, /\$lastSentinelReadError\s*=\s*\$_\.Exception\.Message/);
assert.doesNotMatch(transientReadCatch, /\bthrow\b/);
assert.match(sentinelPolling, /Start-Sleep\s+-Seconds\s+1/);
assert.doesNotMatch(
  sentinelPolling,
  /\$sandboxProcess\.HasExited/,
  "the readiness sentinel, not the controller process, is authoritative",
);
assert.doesNotMatch(
  sentinelPolling,
  /\bthrow\b/,
  "empty, partial, or temporarily unreadable sentinels must be retried until the deadline",
);

const sentinelDeadlineResult = launcher.slice(
  sentinelPollingEnd,
  launcher.indexOf("if (Test-Path -LiteralPath $summaryPath", sentinelPollingEnd),
);
assert.match(
  sentinelDeadlineResult,
  /if \(-not \$sentinelParsed\) \{/,
);
const invalidSentinelResult = sentinelDeadlineResult.match(
  /if \(Test-Path\s+-LiteralPath\s+\$exitCodePath\s+-PathType\s+Leaf\) \{(?<body>[\s\S]*?)\n\s*\}/,
)?.groups?.body ?? "";
assert.match(invalidSentinelResult, /\bthrow\b/);
assert.match(
  invalidSentinelResult,
  /\$lastExitCodeText/,
  "an invalid-sentinel error must include the last observed text",
);
assert.match(
  sentinelDeadlineResult.slice(sentinelDeadlineResult.indexOf(invalidSentinelResult)),
  /timed out[\s\S]{0,160}\$stage/i,
  "a missing-sentinel timeout must point to the retained evidence stage",
);
assert.match(launcher, /Get-Content[\s\S]{0,160}\$summaryPath[\s\S]{0,160}-Raw/);
assert.match(launcher, /finally\s*\{[\s\S]{0,180}Evidence path:[\s\S]{0,120}\$stage/);
assert.match(launcher, /exit\s+\$innerExitCode\s*$/);
assert.doesNotMatch(launcher, /\bRemove-Item\b/);
assert.doesNotMatch(
  launcher,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|curl(?:\.exe)?|wget(?:\.exe)?)\b/i,
  "the offline Sandbox launcher must not download anything",
);

console.log("windows store readiness contracts ok");
