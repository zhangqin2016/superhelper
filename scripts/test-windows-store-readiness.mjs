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
assert.doesNotMatch(runner, /full-uninstall-lily-workbench/i);

assert.match(runner, /readiness-report\.json/);
assert.match(runner, /readiness-summary\.md/);
assert.match(runner, /readiness-transcript\.log/);
assert.match(runner, /readiness-exit-code\.txt/);
assert.match(runner, /ConvertTo-Json -Depth 8/);
assert.match(runner, /exit \$exitCode\s*$/);

console.log("windows store readiness contracts ok");
