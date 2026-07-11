import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerBytes = await readFile(path.join(root, "scripts", "smoke-windows-store-installer.ps1"));

assert.deepEqual([...runnerBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

const runner = runnerBytes.subarray(3).toString("utf8");

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

const nativeCommandLineSource = runner.match(/Add-Type\s+-TypeDefinition\s+@'([\s\S]*?)'@/)?.[1] ?? "";
assert.ok(nativeCommandLineSource, "the runner must compile a native Windows command-line parser");
assert.match(
  runner,
  /if \(\$null -eq \(["']Lily\.NativeCommandLine\.[A-Za-z]+["'] -as \[type\]\)\) \{\s*Add-Type/,
  "the native parser type must only be compiled when it is not already loaded",
);
assert.match(nativeCommandLineSource, /namespace Lily\.NativeCommandLine/);
assert.match(nativeCommandLineSource, /DllImport\(["']shell32\.dll["']/i);
assert.match(nativeCommandLineSource, /CommandLineToArgvW/);
assert.match(nativeCommandLineSource, /DllImport\(["']kernel32\.dll["']/i);
assert.match(nativeCommandLineSource, /LocalFree/);
assert.match(nativeCommandLineSource, /public static string\[\] Split\s*\(/);
assert.match(nativeCommandLineSource, /try\s*\{/);
assert.match(nativeCommandLineSource, /finally\s*\{[\s\S]*LocalFree\s*\(/);

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
assert.match(silentUninstallBody, /Test-Path\s+-LiteralPath\s+\$InstallDirectory/);
assert.match(silentUninstallBody, /\[Math\]::Min\(\s*30\s*,/);
assert.doesNotMatch(silentUninstallBody, /\$TimeoutSeconds\s*\*\s*2/);
assert.match(silentUninstallBody, /Start-Sleep\s+-Milliseconds\s+500/);
for (const property of ["command", "process", "productEntryRemoved", "installDirectoryRemoved"]) {
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
assert.match(runner, /function Get-LilyProcesses\b/);
assert.match(runner, /LilyWorkbench/);
assert.match(runner, /Lily Workbench/);
assert.match(runner, /lily-workbench/);
assert.match(runner, /智能工作台/);

assert.match(runner, /function Get-ProcessTreeIds\b/);
assert.match(runner, /Get-CimInstance\s+-ClassName\s+Win32_Process/);
assert.match(runner, /ParentProcessId/);
assert.match(runner, /function Invoke-MonitoredProcess\b/);
assert.match(runner, /Start-Process[\s\S]*-PassThru/);
assert.match(runner, /MainWindowHandle/);
assert.match(runner, /visibleWindows/);
assert.match(runner, /150/);

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
assert.match(waitRendererBody, /MainWindowHandle/);
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
assert.ok(
  waitRendererBody.includes("renderer[/\\\\]index\\.html"),
  "renderer readiness must require the packaged renderer/index.html URL",
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
  /\$null\s+-eq\s+\$visibleWindow\s+-and\s+\$mainWindowHandle\s+-ne\s+0/,
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
assert.match(runner, /thumbprint/);
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
  /\(\[string\]\$installerSignature\.signerSubject\)\.IndexOf\(\s*\$ExpectedPublisher,\s*\[System\.StringComparison\]::OrdinalIgnoreCase\s*\)/,
);
assert.match(
  runner,
  /\(\[string\]\$script:InstalledEntry\.Publisher\)\.IndexOf\(\s*\$ExpectedPublisher,\s*\[System\.StringComparison\]::OrdinalIgnoreCase\s*\)/,
);
assert.match(runner, /Get-FileHash[^\r\n]*SHA256/);
assert.doesNotMatch(runner, /\bRemove-Item\b/i);
assert.doesNotMatch(runner, /full-uninstall-lily-workbench/i);

const mainFinallyStart = runner.lastIndexOf("} finally {");
const mainFinallyEnd = runner.lastIndexOf("\n}\n\nexit $exitCode");
assert.ok(mainFinallyStart >= 0 && mainFinallyEnd > mainFinallyStart, "the main flow must have a finalization block");
const mainFinallyBody = runner.slice(mainFinallyStart + "} finally {".length, mainFinallyEnd);
assert.match(
  mainFinallyBody,
  /Get-LilyUninstallEntries[\s\S]{0,300}Try-NormalUninstallCleanup/,
  "finally must use the normal registered uninstaller whenever an ARP entry remains",
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

assert.match(runner, /readiness-report\.json/);
assert.match(runner, /readiness-summary\.md/);
assert.match(runner, /readiness-transcript\.log/);
assert.match(runner, /readiness-exit-code\.txt/);
assert.match(runner, /ConvertTo-Json -Depth 8/);
assert.match(runner, /exit \$exitCode\s*$/);

console.log("windows store readiness contracts ok");
