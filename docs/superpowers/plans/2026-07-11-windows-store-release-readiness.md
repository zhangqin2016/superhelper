# Windows Store EXE Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a non-destructive Windows pre-submission harness that proves Lily Workbench's signed NSIS EXE can install silently, launch on a clean offline Windows desktop, uninstall silently, and produce auditable Microsoft Store readiness evidence.

**Architecture:** Keep the mutating lifecycle in one Windows PowerShell 5.1-compatible runner, with a second host-side script that stages and launches the runner in Windows Sandbox. Lock safety and required checks with an auto-discovered Node contract test, then document the exact rehearsal and final Store-gate commands without changing packaging, signing, publishing, or CI.

**Tech Stack:** Windows PowerShell 5.1, NSIS/electron-builder installer conventions, Windows registry/CIM/Event Log/CDP, Windows Sandbox `.wsb` XML, Node.js `assert` contract tests, Markdown release documentation.

---

## File map

- Create `scripts/smoke-windows-store-installer.ps1`: lifecycle runner, evidence writer, and exit-code gate.
- Create `scripts/start-windows-store-sandbox.ps1`: clean offline Sandbox staging and host result relay.
- Create `scripts/test-windows-store-readiness.mjs`: auto-discovered static safety/coverage contract.
- Create `docs/windows-store-release-readiness.md`: Chinese operator runbook and Microsoft requirement mapping.
- Modify `docs/release-and-deploy-sop.md:143`: link the Windows-specific pre-submission gate before generic post-publish verification.

Before Task 1, use `superpowers:using-git-worktrees` to create an isolated worktree. The shared source checkout currently contains unrelated `.superpowers/` state; do not stage, delete, or rewrite it.

### Task 1: Establish the report and fail-loud runner contract

**Files:**
- Create: `scripts/test-windows-store-readiness.mjs`
- Create: `scripts/smoke-windows-store-installer.ps1`

- [ ] **Step 1: Write the failing runner-contract test**

Create `scripts/test-windows-store-readiness.mjs` with:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = path.join(root, "scripts", "smoke-windows-store-installer.ps1");
const runnerBytes = await readFile(runnerPath);
assert.deepEqual(
  [...runnerBytes.subarray(0, 3)],
  [0xef, 0xbb, 0xbf],
  "Windows PowerShell 5.1 runner must be UTF-8 BOM because it contains localized titles",
);
const runner = runnerBytes.toString("utf8").replace(/^\uFEFF/, "");

assert.match(runner, /Set-StrictMode\s+-Version\s+Latest/, "runner must use strict PowerShell semantics");
for (const name of [
  "Installer",
  "OutputDirectory",
  "ExpectedPublisher",
  "ExpectedVersion",
  "RequireSignature",
  "AllowUserDataRemnants",
  "InstallTimeoutSeconds",
  "LaunchTimeoutSeconds",
  "UninstallTimeoutSeconds",
]) {
  assert.match(runner, new RegExp(`\\$${name}\\b`), `runner must expose -${name}`);
}
for (const status of ["pass", "warning", "fail", "not_applicable"]) {
  assert.match(runner, new RegExp(`\\b${status}\\b`), `report schema must retain ${status}`);
}
assert.match(runner, /readiness-report\.json/, "runner must write structured evidence");
assert.match(runner, /readiness-summary\.md/, "runner must write a human summary");
assert.match(runner, /readiness-transcript\.log/, "runner must keep a transcript");
assert.match(runner, /readiness-exit-code\.txt/, "runner must expose a Sandbox-readable result sentinel");
assert.match(runner, /ConvertTo-Json\s+-Depth\s+8/, "nested evidence must not be truncated");
assert.match(runner, /exit\s+\$exitCode/, "required failures must reach the process exit code");

console.log("windows store readiness contracts ok");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: FAIL with `ENOENT` for `scripts/smoke-windows-store-installer.ps1`.

- [ ] **Step 3: Add the minimal PowerShell 5.1-compatible report shell**

Create `scripts/smoke-windows-store-installer.ps1` with a UTF-8 BOM followed by this foundation. The BOM is required because Windows PowerShell 5.1 otherwise reads the Chinese and Arabic title literals through the active ANSI code page.

```powershell
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [string]$OutputDirectory = '',
  [string]$ExpectedPublisher = '',
  [string]$ExpectedVersion = '',
  [switch]$RequireSignature,
  [switch]$AllowUserDataRemnants,
  [ValidateRange(10, 900)]
  [int]$InstallTimeoutSeconds = 180,
  [ValidateRange(10, 600)]
  [int]$LaunchTimeoutSeconds = 90,
  [ValidateRange(10, 900)]
  [int]$UninstallTimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $OutputDirectory) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $OutputDirectory = Join-Path (Get-Location) ("windows-store-readiness-" + $stamp)
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

$script:Checks = New-Object 'System.Collections.Generic.List[object]'
$script:Report = [ordered]@{
  schemaVersion = 1
  product = 'Lily Workbench'
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  completedAt = $null
  installer = $null
  machine = $null
  checks = @()
}

function Add-Check {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)]
    [ValidateSet('pass', 'warning', 'fail', 'not_applicable')]
    [string]$Status,
    [Parameter(Mandatory = $true)][string]$Detail,
    [object]$Evidence = $null
  )
  $script:Checks.Add([pscustomobject]@{
    id = $Id
    status = $Status
    detail = $Detail
    evidence = $Evidence
  })
}

function Require-Check {
  param(
    [string]$Id,
    [bool]$Condition,
    [string]$PassDetail,
    [string]$FailDetail,
    [object]$Evidence = $null
  )
  if ($Condition) {
    Add-Check -Id $Id -Status 'pass' -Detail $PassDetail -Evidence $Evidence
    return
  }
  Add-Check -Id $Id -Status 'fail' -Detail $FailDetail -Evidence $Evidence
  throw ($Id + ': ' + $FailDetail)
}

function Write-Reports {
  $script:Report.completedAt = (Get-Date).ToUniversalTime().ToString('o')
  $script:Report.checks = @($script:Checks)
  $jsonPath = Join-Path $OutputDirectory 'readiness-report.json'
  $summaryPath = Join-Path $OutputDirectory 'readiness-summary.md'
  $script:Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

  $failed = @($script:Checks | Where-Object { $_.status -eq 'fail' })
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $lines.Add('# Lily Workbench Windows Store readiness')
  $lines.Add('')
  $lines.Add(('Overall: ' + $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' })))
  $lines.Add('')
  foreach ($check in $script:Checks) {
    $lines.Add(('- [{0}] `{1}` — {2}' -f $check.status.ToUpperInvariant(), $check.id, $check.detail))
  }
  $lines | Set-Content -LiteralPath $summaryPath -Encoding UTF8
}

$transcriptPath = Join-Path $OutputDirectory 'readiness-transcript.log'
$transcriptStarted = $false
$exitCode = 1
try {
  Start-Transcript -LiteralPath $transcriptPath -Force | Out-Null
  $transcriptStarted = $true
  Add-Check -Id 'runner.scaffold' -Status 'fail' -Detail 'Lifecycle checks have not run.'
} catch {
  Add-Check -Id 'runner.exception' -Status 'fail' -Detail $_.Exception.Message
} finally {
  $exitCode = $(if (@($script:Checks | Where-Object { $_.status -eq 'fail' }).Count -eq 0) { 0 } else { 1 })
  if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
  }
  Write-Reports
  [IO.File]::WriteAllText((Join-Path $OutputDirectory 'readiness-exit-code.txt'), [string]$exitCode)
}

exit $exitCode
```

- [ ] **Step 4: Run the contract test and verify GREEN**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: PASS and print `windows store readiness contracts ok`.

- [ ] **Step 5: Commit the report shell**

```bash
git add scripts/test-windows-store-readiness.mjs scripts/smoke-windows-store-installer.ps1
git commit -m "feat: scaffold Windows Store readiness runner"
```

### Task 2: Add silent install, registry metadata, and PE signatures

**Files:**
- Modify: `scripts/test-windows-store-readiness.mjs`
- Modify: `scripts/smoke-windows-store-installer.ps1`

- [ ] **Step 1: Add failing install and signature assertions**

Insert before the test's final `console.log`:

```js
for (const [pattern, message] of [
  [/['"]\/S['"]/, "installer must use uppercase NSIS /S"],
  [/['"]\/currentuser['"]/, "installer scope must be explicit"],
  [/Get-CimInstance\s+Win32_Process/, "visible-window monitor must include descendants"],
  [/MainWindowHandle/, "installer-owned windows must be detected"],
  [/HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/, "current-user uninstall entry must be queried"],
  [/HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/, "machine uninstall entry must be queried"],
  [/QuietUninstallString/, "uninstall command must come from registry metadata"],
  [/DisplayName/, "Add\/Remove Programs name must be checked"],
  [/Publisher/, "Add\/Remove Programs publisher must be checked"],
  [/DisplayVersion/, "Add\/Remove Programs version must be checked"],
  [/Get-AuthenticodeSignature/, "Authenticode must be inspected"],
  [/0x4D.*0x5A|77.*90/s, "PE discovery must inspect the MZ header"],
  [/signature-inventory\.json/, "PE signature evidence must be retained"],
  [/registry-before\.json/, "clean-state registry evidence must be retained"],
  [/registry-installed\.json/, "installed registry evidence must be retained"],
  [/registry-after\.json/, "post-uninstall registry evidence must be retained"],
  [/WindowsPrincipal[\s\S]*IsInRole/, "account privilege level must be recorded"],
]) {
  assert.match(runner, pattern, message);
}
assert.doesNotMatch(runner, /full-uninstall-lily-workbench/i, "readiness runner must never call destructive cleanup");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: FAIL at the first missing `/S` lifecycle assertion.

- [ ] **Step 3: Add deterministic discovery and monitoring helpers**

Add these functions above the runner's execution block:

```powershell
function Get-LilyUninstallEntries {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entries = foreach ($root in $roots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
      Where-Object { [string]$_.DisplayName -match '^Lily Workbench$|^智能工作台$' } |
      ForEach-Object {
        [pscustomobject]@{
          RegistryPath = [string]$_.PSPath
          DisplayName = [string]$_.DisplayName
          Publisher = [string]$_.Publisher
          DisplayVersion = [string]$_.DisplayVersion
          InstallLocation = [string]$_.InstallLocation
          DisplayIcon = [string]$_.DisplayIcon
          UninstallString = [string]$_.UninstallString
          QuietUninstallString = [string]$_.QuietUninstallString
        }
      }
  }
  return @($entries)
}

function Get-LilyProcesses {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -in @('LilyWorkbench', 'Lily Workbench', 'lily-workbench', '智能工作台')
  })
}

function Get-ProcessTreeIds {
  param([int]$RootId)
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$ids.Add($RootId)
  do {
    $added = $false
    foreach ($row in $rows) {
      if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) {
        $added = $true
      }
    }
  } while ($added)
  return @($ids)
}

function Invoke-MonitoredProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [int]$TimeoutSeconds,
    [string]$Label
  )
  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $visible = New-Object 'System.Collections.Generic.List[object]'
  $timedOut = $false
  while ($true) {
    $process.Refresh()
    $treeIds = @(Get-ProcessTreeIds -RootId $process.Id)
    $activeTree = @($treeIds | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    foreach ($candidate in $activeTree) {
      if ($candidate -and $candidate.MainWindowHandle -ne 0) {
        $visible.Add([pscustomobject]@{
          processId = $candidate.Id
          processName = $candidate.ProcessName
          windowTitle = $candidate.MainWindowTitle
          label = $Label
        })
      }
    }
    $activeDescendants = @($activeTree | Where-Object { $_.Id -ne $process.Id })
    if ($process.HasExited -and $activeDescendants.Count -eq 0) { break }
    if ((Get-Date) -ge $deadline) {
      $timedOut = $true
      foreach ($processId in $treeIds) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
      }
      break
    }
    Start-Sleep -Milliseconds 150
  }
  $process.Refresh()
  return [pscustomobject]@{
    processId = $process.Id
    exitCode = $(if ($process.HasExited) { $process.ExitCode } else { $null })
    timedOut = $timedOut
    visibleWindows = @($visible | Sort-Object processId, windowTitle -Unique)
  }
}

function Test-PortableExecutable {
  param([string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    return ($stream.ReadByte() -eq 0x4D -and $stream.ReadByte() -eq 0x5A)
  } finally {
    $stream.Dispose()
  }
}

function Get-SignatureRecord {
  param([string]$Path)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  return [pscustomobject]@{
    path = $Path
    status = [string]$signature.Status
    statusMessage = [string]$signature.StatusMessage
    signerSubject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' })
    thumbprint = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { '' })
  }
}

function Get-PeSignatureInventory {
  param([string]$InstallDirectory)
  $records = New-Object 'System.Collections.Generic.List[object]'
  foreach ($file in @(Get-ChildItem -LiteralPath $InstallDirectory -File -Recurse -ErrorAction Stop)) {
    if (Test-PortableExecutable -Path $file.FullName) {
      $records.Add((Get-SignatureRecord -Path $file.FullName))
    }
  }
  return @($records)
}

function Resolve-InstallDirectory {
  param([object]$Entry)
  if ($Entry.InstallLocation -and (Test-Path -LiteralPath $Entry.InstallLocation)) {
    return [IO.Path]::GetFullPath($Entry.InstallLocation)
  }
  if ($Entry.DisplayIcon) {
    $iconPath = $Entry.DisplayIcon.Split(',')[0].Trim().Trim('"')
    if ($iconPath -and (Test-Path -LiteralPath $iconPath)) {
      return Split-Path -Parent ([IO.Path]::GetFullPath($iconPath))
    }
  }
  throw 'Installed Lily Workbench entry has no usable InstallLocation or DisplayIcon.'
}

function Get-LilyShortcuts {
  $roots = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonStartMenu')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  return @($roots | ForEach-Object {
    Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.BaseName -eq 'Lily Workbench' -or $_.BaseName -eq '智能工作台' } |
      Select-Object -ExpandProperty FullName
  } | Sort-Object -Unique)
}
```

- [ ] **Step 4: Replace the scaffold marker with install preflight and evidence capture**

Inside the main `try`, replace the `runner.scaffold` line with:

```powershell
Require-Check -Id 'preflight.windows' -Condition ($env:OS -eq 'Windows_NT') `
  -PassDetail 'Running on Windows.' -FailDetail 'This lifecycle runner must run on Windows.'
$installerPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Installer).Path)
Require-Check -Id 'preflight.exe' -Condition ([IO.Path]::GetExtension($installerPath) -ieq '.exe') `
  -PassDetail 'Installer is an EXE.' -FailDetail 'Partner Center direct submission requires the selected EXE installer.'
$registryBefore = @(Get-LilyUninstallEntries)
$registryBefore | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'registry-before.json') -Encoding UTF8
Require-Check -Id 'preflight.clean_install_state' -Condition ($registryBefore.Count -eq 0) `
  -PassDetail 'No Lily Workbench uninstall entry exists.' -FailDetail 'Use a clean Windows user or Sandbox; Lily Workbench is already installed.' -Evidence $registryBefore
Require-Check -Id 'preflight.no_running_app' -Condition ((Get-LilyProcesses).Count -eq 0) `
  -PassDetail 'No Lily process is running.' -FailDetail 'Close Lily Workbench before testing.'

$installerItem = Get-Item -LiteralPath $installerPath
$installerSignature = Get-SignatureRecord -Path $installerPath
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $identity
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$script:Report.installer = [ordered]@{
  path = $installerPath
  sizeBytes = $installerItem.Length
  sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
  signature = $installerSignature
}
$script:Report.machine = [ordered]@{
  computerName = $env:COMPUTERNAME
  userName = [Environment]::UserName
  osVersion = [Environment]::OSVersion.VersionString
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  isAdministrator = $isAdministrator
}
Add-Check -Id 'environment.standard_user' `
  -Status $(if ($isAdministrator) { 'warning' } else { 'pass' }) `
  -Detail $(if ($isAdministrator) { 'This run uses an administrator account; retain a second direct run from a standard-user VM.' } else { 'This run uses a standard Windows account.' })

if ($RequireSignature) {
  Require-Check -Id 'signature.installer' -Condition ($installerSignature.status -eq 'Valid') `
    -PassDetail 'Installer Authenticode signature is valid.' `
    -FailDetail ('Installer signature status is ' + $installerSignature.status + '.') `
    -Evidence $installerSignature
} elseif ($installerSignature.status -eq 'Valid') {
  Add-Check -Id 'signature.installer' -Status 'pass' -Detail 'Installer Authenticode signature is valid.' -Evidence $installerSignature
} else {
  Add-Check -Id 'signature.installer' -Status 'warning' -Detail ('Unsigned rehearsal: installer signature status is ' + $installerSignature.status + '.') -Evidence $installerSignature
}
if ($ExpectedPublisher) {
  Require-Check -Id 'signature.publisher' `
    -Condition ($installerSignature.signerSubject.IndexOf($ExpectedPublisher, [StringComparison]::OrdinalIgnoreCase) -ge 0) `
    -PassDetail 'Installer signer matches the expected publisher.' `
    -FailDetail ('Installer signer subject is ' + $installerSignature.signerSubject + '.') `
    -Evidence $installerSignature
}

$installResult = Invoke-MonitoredProcess -FilePath $installerPath -ArgumentList @('/S', '/currentuser') `
  -TimeoutSeconds $InstallTimeoutSeconds -Label 'installer'
Require-Check -Id 'install.timeout' -Condition (-not $installResult.timedOut) `
  -PassDetail 'Silent install completed within the timeout.' -FailDetail 'Silent install timed out.' -Evidence $installResult
Require-Check -Id 'install.exit_code' -Condition ($installResult.exitCode -eq 0) `
  -PassDetail 'Silent install returned exit code 0.' -FailDetail ('Silent install exit code was ' + $installResult.exitCode + '.') -Evidence $installResult
Require-Check -Id 'install.no_visible_ui' -Condition ($installResult.visibleWindows.Count -eq 0) `
  -PassDetail 'No installer-owned UI was observed.' -FailDetail 'Installer-owned visible UI was observed.' -Evidence $installResult.visibleWindows

$entries = @(Get-LilyUninstallEntries)
$entries | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'registry-installed.json') -Encoding UTF8
Require-Check -Id 'install.single_product_entry' -Condition ($entries.Count -eq 1) `
  -PassDetail 'Exactly one Lily Workbench product entry exists.' -FailDetail ('Expected one product entry, found ' + $entries.Count + '.') -Evidence $entries
$script:InstalledEntry = $entries[0]
$missingFields = @('DisplayName', 'Publisher', 'DisplayVersion', 'InstallLocation', 'UninstallString', 'QuietUninstallString') |
  Where-Object { [string]::IsNullOrWhiteSpace([string]$script:InstalledEntry.$_) }
Require-Check -Id 'install.product_metadata' -Condition ($missingFields.Count -eq 0) `
  -PassDetail 'Add/Remove Programs metadata is complete.' -FailDetail ('Missing metadata fields: ' + ($missingFields -join ', ')) -Evidence $script:InstalledEntry
if ($ExpectedPublisher) {
  Require-Check -Id 'install.publisher' `
    -Condition ($script:InstalledEntry.Publisher.IndexOf($ExpectedPublisher, [StringComparison]::OrdinalIgnoreCase) -ge 0) `
    -PassDetail 'Installed publisher matches the expected publisher.' `
    -FailDetail ('Installed publisher is ' + $script:InstalledEntry.Publisher + '.')
}
if ($ExpectedVersion) {
  Require-Check -Id 'install.version' -Condition ($script:InstalledEntry.DisplayVersion -eq $ExpectedVersion) `
    -PassDetail 'Installed version matches the selected artifact.' `
    -FailDetail ('Expected ' + $ExpectedVersion + ', found ' + $script:InstalledEntry.DisplayVersion + '.')
}

$script:InstallDirectory = Resolve-InstallDirectory -Entry $script:InstalledEntry
$mainExe = Join-Path $script:InstallDirectory 'LilyWorkbench.exe'
Require-Check -Id 'install.main_exe' -Condition (Test-Path -LiteralPath $mainExe -PathType Leaf) `
  -PassDetail 'Installed LilyWorkbench.exe exists.' -FailDetail ('Missing ' + $mainExe + '.')
$shortcuts = @(Get-LilyShortcuts)
Require-Check -Id 'install.shortcuts' -Condition ($shortcuts.Count -ge 2) `
  -PassDetail 'Desktop and Start menu shortcuts were discovered.' -FailDetail 'Expected desktop and Start menu shortcuts.' -Evidence $shortcuts

$signatureInventory = @(Get-PeSignatureInventory -InstallDirectory $script:InstallDirectory)
$signatureInventory | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'signature-inventory.json') -Encoding UTF8
$invalidPe = @($signatureInventory | Where-Object { $_.status -ne 'Valid' })
if ($RequireSignature) {
  Require-Check -Id 'signature.installed_pe' -Condition ($invalidPe.Count -eq 0) `
    -PassDetail ('All ' + $signatureInventory.Count + ' installed PE files have valid signatures.') `
    -FailDetail ($invalidPe.Count.ToString() + ' installed PE files do not have valid signatures.') -Evidence $invalidPe
} elseif ($invalidPe.Count -gt 0) {
  Add-Check -Id 'signature.installed_pe' -Status 'warning' `
    -Detail ($invalidPe.Count.ToString() + ' installed PE files are unsigned or invalid in rehearsal mode.') -Evidence $invalidPe
} else {
  Add-Check -Id 'signature.installed_pe' -Status 'pass' -Detail 'All installed PE files have valid signatures.'
}
```

Do not execute the lifecycle script on Windows yet; Tasks 3 and 4 add launch and guaranteed normal-uninstaller cleanup. Run only the static contract here.

- [ ] **Step 5: Run the contract and commit**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: PASS.

```bash
git add scripts/test-windows-store-readiness.mjs scripts/smoke-windows-store-installer.ps1
git commit -m "feat: verify silent install and Windows signatures"
```

### Task 3: Prove renderer readiness and capture crashes

**Files:**
- Modify: `scripts/test-windows-store-readiness.mjs`
- Modify: `scripts/smoke-windows-store-installer.ps1`

- [ ] **Step 1: Add failing launch assertions**

Insert before `console.log`:

```js
for (const [pattern, message] of [
  [/--remote-debugging-address=127\.0\.0\.1/, "CDP must bind only to loopback"],
  [/--remote-debugging-port=/, "launch must expose a temporary CDP endpoint"],
  [/--enable-logging=file/, "Chromium diagnostics must be enabled"],
  [/Lily Workbench/, "renderer title must be asserted"],
  [/renderer.*index\.html/s, "renderer URL must be asserted"],
  [/MainWindowHandle/, "a visible app window must be required"],
  [/Get-WinEvent/, "Windows crash events must be inspected"],
  [/Application Error|Windows Error Reporting/, "crash providers must be explicit"],
  [/CloseMainWindow\(\)/, "normal app shutdown must be attempted"],
  [/chromium\.log/, "Chromium startup evidence must be retained"],
]) {
  assert.match(runner, pattern, message);
}
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: FAIL on the missing remote-debugging address.

- [ ] **Step 3: Add bounded CDP, visible-window, and crash-event helpers**

Add above the execution block:

```powershell
function Get-FreeLoopbackPort {
  $listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Wait-LilyRenderer {
  param([int]$Port, [int]$ProcessId, [int]$TimeoutSeconds)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $target = $null
  $visible = $false
  $knownTitles = @('Lily Workbench', '智能工作台', 'Smart Workbench', 'منصة العمل الذكية')
  while ((Get-Date) -lt $deadline) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { break }
    foreach ($treeId in @(Get-ProcessTreeIds -RootId $ProcessId)) {
      $treeProcess = Get-Process -Id $treeId -ErrorAction SilentlyContinue
      if ($treeProcess -and $treeProcess.MainWindowHandle -ne 0) { $visible = $true }
    }
    try {
      $targets = @(Invoke-RestMethod -Uri ("http://127.0.0.1:" + $Port + '/json/list') -TimeoutSec 2)
      $target = $targets | Where-Object {
        $_.type -eq 'page' -and $_.title -in $knownTitles -and [string]$_.url -match 'renderer[/\\]index\.html'
      } | Select-Object -First 1
      if ($target -and $visible) { break }
    } catch { }
    Start-Sleep -Milliseconds 250
  }
  return [pscustomobject]@{ target = $target; visibleWindow = $visible }
}

function Get-LilyCrashEvents {
  param([datetime]$StartTime)
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $StartTime } -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProviderName -in @('Application Error', 'Windows Error Reporting') -and
      [string]$_.Message -match 'LilyWorkbench\.exe|Lily Workbench\.exe'
    } |
    Select-Object TimeCreated, ProviderName, Id, LevelDisplayName, Message)
  $events | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'startup-event-log.json') -Encoding UTF8
  return $events
}

function Invoke-LilyLaunchProbe {
  param([string]$MainExe, [int]$TimeoutSeconds)
  $port = Get-FreeLoopbackPort
  $chromiumLog = Join-Path $OutputDirectory 'chromium.log'
  $startedAt = Get-Date
  $arguments = @(
    '--remote-debugging-address=127.0.0.1',
    ('--remote-debugging-port=' + $port),
    '--enable-logging=file',
    ('--log-file="' + $chromiumLog + '"')
  )
  $process = Start-Process -FilePath $MainExe -ArgumentList $arguments -PassThru
  $probe = $null
  $closedNormally = $false
  try {
    $probe = Wait-LilyRenderer -Port $port -ProcessId $process.Id -TimeoutSeconds $TimeoutSeconds
    $process.Refresh()
    if (-not $process.HasExited) {
      [void]$process.CloseMainWindow()
      try { Wait-Process -Id $process.Id -Timeout 15 -ErrorAction Stop; $closedNormally = $true } catch { }
    }
  } finally {
    foreach ($treeId in @(Get-ProcessTreeIds -RootId $process.Id)) {
      Stop-Process -Id $treeId -Force -ErrorAction SilentlyContinue
    }
  }
  return [pscustomobject]@{
    processId = $process.Id
    remainedAlive = $(if ($process) { -not $process.HasExited -or $closedNormally } else { $false })
    visibleWindow = [bool]$probe.visibleWindow
    rendererTarget = $probe.target
    closedNormally = $closedNormally
    crashEvents = @(Get-LilyCrashEvents -StartTime $startedAt)
  }
}
```

- [ ] **Step 4: Invoke the probe after installed signatures**

Append after Task 2's signature checks:

```powershell
$launchResult = Invoke-LilyLaunchProbe -MainExe $mainExe -TimeoutSeconds $LaunchTimeoutSeconds
Require-Check -Id 'launch.visible_window' -Condition $launchResult.visibleWindow `
  -PassDetail 'Lily Workbench created a visible main window.' -FailDetail 'No visible Lily Workbench window appeared.' -Evidence $launchResult
Require-Check -Id 'launch.renderer_ready' -Condition ($null -ne $launchResult.rendererTarget) `
  -PassDetail 'Packaged renderer reached the Lily Workbench page.' -FailDetail 'CDP did not observe the packaged Lily Workbench renderer.' -Evidence $launchResult
Require-Check -Id 'launch.no_crash_event' -Condition ($launchResult.crashEvents.Count -eq 0) `
  -PassDetail 'No matching Windows crash event was recorded.' -FailDetail 'Windows recorded a Lily Workbench crash.' -Evidence $launchResult.crashEvents
Require-Check -Id 'launch.normal_close' -Condition $launchResult.closedNormally `
  -PassDetail 'Lily Workbench closed through its main window.' -FailDetail 'Lily Workbench required forced test cleanup.'
```

- [ ] **Step 5: Run the contract and commit**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: PASS.

```bash
git add scripts/test-windows-store-readiness.mjs scripts/smoke-windows-store-installer.ps1
git commit -m "feat: verify clean Windows application launch"
```

### Task 4: Add registry-driven uninstall, residue policy, and guaranteed reports

**Files:**
- Modify: `scripts/test-windows-store-readiness.mjs`
- Modify: `scripts/smoke-windows-store-installer.ps1`

- [ ] **Step 1: Add failing uninstall-safety assertions**

Insert before `console.log`:

```js
for (const [pattern, message] of [
  [/CommandLineToArgvW/, "quoted QuietUninstallString must use native Windows parsing"],
  [/QuietUninstallString[\s\S]*Invoke-SilentUninstall/, "registered quiet command must drive uninstall"],
  [/uninstall\.no_visible_ui/, "uninstaller UI must be a named gate"],
  [/uninstall\.product_entry_removed/, "registry removal must be polled"],
  [/uninstall\.install_directory_removed/, "NSIS asynchronous deletion must be polled"],
  [/APPDATA[\s\S]*lily-workbench/i, "pinned userData residue must be inventoried"],
  [/Documents[\s\S]*Lily Workbench/i, "workspace residue must be inventoried"],
  [/AllowUserDataRemnants/, "internal rehearsal policy must remain explicit"],
  [/cleanup\.install_residue/, "partial installs without registry entries must remain visible"],
  [/finally\s*\{[\s\S]*Try-NormalUninstallCleanup/, "normal cleanup must run after partial failures"],
  [/wack[\s\S]*not_applicable/i, "raw NSIS EXE must not fabricate a WACK result"],
]) {
  assert.match(runner, pattern, message);
}
assert.doesNotMatch(runner, /Remove-Item[\s\S]*(APPDATA|Documents|lily-workbench)/i, "runner must never delete Lily user data");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: FAIL on `CommandLineToArgvW`.

- [ ] **Step 3: Add native command parsing and normal-uninstaller helpers**

Add above the execution block:

```powershell
if (-not ('Lily.NativeCommandLine' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Lily {
  public static class NativeCommandLine {
    [DllImport("shell32.dll", SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
      out int argc
    );
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Split(string commandLine) {
      int argc;
      IntPtr argv = CommandLineToArgvW(commandLine, out argc);
      if (argv == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
      try {
        string[] result = new string[argc];
        for (int i = 0; i < argc; i++) {
          IntPtr item = Marshal.ReadIntPtr(argv, i * IntPtr.Size);
          result[i] = Marshal.PtrToStringUni(item);
        }
        return result;
      } finally {
        LocalFree(argv);
      }
    }
  }
}
'@
}

function Resolve-UninstallCommand {
  param([object]$Entry, [string]$InstallDirectory)
  if ([string]::IsNullOrWhiteSpace($Entry.QuietUninstallString)) {
    throw 'QuietUninstallString is missing.'
  }
  $tokens = [Lily.NativeCommandLine]::Split($Entry.QuietUninstallString)
  if ($tokens.Count -lt 1) { throw 'QuietUninstallString is empty after native parsing.' }
  $filePath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($tokens[0]))
  $installRoot = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\') + '\'
  if (-not $filePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw ('Refusing uninstaller outside install directory: ' + $filePath)
  }
  if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
    throw ('Registered uninstaller does not exist: ' + $filePath)
  }
  $arguments = @()
  if ($tokens.Count -gt 1) { $arguments = @($tokens[1..($tokens.Count - 1)]) }
  return [pscustomobject]@{
    filePath = $filePath
    arguments = $arguments
    declaresSilent = (@($arguments | Where-Object { $_ -ceq '/S' }).Count -gt 0)
  }
}

function Invoke-SilentUninstall {
  param([object]$Entry, [string]$InstallDirectory, [int]$TimeoutSeconds)
  $command = Resolve-UninstallCommand -Entry $Entry -InstallDirectory $InstallDirectory
  $arguments = @($command.arguments)
  if (-not $command.declaresSilent) { $arguments += '/S' }
  $processResult = Invoke-MonitoredProcess -FilePath $command.filePath -ArgumentList $arguments `
    -TimeoutSeconds $TimeoutSeconds -Label 'uninstaller'
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $entryGone = @(Get-LilyUninstallEntries).Count -eq 0
    $directoryGone = -not (Test-Path -LiteralPath $InstallDirectory)
    if ($entryGone -and $directoryGone) { break }
    Start-Sleep -Milliseconds 500
  }
  return [pscustomobject]@{
    command = $command
    process = $processResult
    productEntryRemoved = (@(Get-LilyUninstallEntries).Count -eq 0)
    installDirectoryRemoved = (-not (Test-Path -LiteralPath $InstallDirectory))
  }
}

function Get-LilyUserDataResidues {
  $documents = [Environment]::GetFolderPath('MyDocuments')
  $paths = @(
    $(if ($env:APPDATA) { Join-Path $env:APPDATA 'lily-workbench' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'lily-workbench' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'lily-workbench-updater' }),
    $(if ($documents) { Join-Path $documents 'Lily Workbench' }),
    $(if ($documents) { Join-Path $documents 'Lily Apps' })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  return @($paths | ForEach-Object {
    $item = Get-Item -LiteralPath $_ -Force
    [pscustomobject]@{ path = $item.FullName; kind = $(if ($item.PSIsContainer) { 'directory' } else { 'file' }) }
  })
}

function Get-LilyInstallResidues {
  $paths = @(
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\LilyWorkbench' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Lily Workbench' }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'LilyWorkbench' }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Lily Workbench' }),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'LilyWorkbench' }),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Lily Workbench' })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  return @($paths | Sort-Object -Unique)
}

function Try-NormalUninstallCleanup {
  try {
    $entries = @(Get-LilyUninstallEntries)
    if ($entries.Count -eq 1) {
      $directory = Resolve-InstallDirectory -Entry $entries[0]
      $cleanup = Invoke-SilentUninstall -Entry $entries[0] -InstallDirectory $directory -TimeoutSeconds $UninstallTimeoutSeconds
      Add-Check -Id 'cleanup.normal_uninstaller' `
        -Status $(if ($cleanup.productEntryRemoved -and $cleanup.installDirectoryRemoved) { 'pass' } else { 'fail' }) `
        -Detail $(if ($cleanup.productEntryRemoved -and $cleanup.installDirectoryRemoved) { 'Normal uninstaller cleanup completed.' } else { 'Normal uninstaller cleanup left installation state behind.' }) `
        -Evidence $cleanup
    } elseif ($entries.Count -gt 1) {
      Add-Check -Id 'cleanup.normal_uninstaller' -Status 'fail' -Detail 'Multiple product entries remain; cleanup was not guessed.' -Evidence $entries
    }
  } catch {
    Add-Check -Id 'cleanup.normal_uninstaller' -Status 'fail' -Detail $_.Exception.Message
  }
}
```

- [ ] **Step 4: Replace the temporary execution block with complete orchestration**

Keep the Task 1 report setup and all functions. Replace the runner's `try/catch/finally` block with the following complete orchestration:

```powershell
$script:InstalledEntry = $null
$script:InstallDirectory = ''
$transcriptStarted = $false
$transcriptPath = Join-Path $OutputDirectory 'readiness-transcript.log'
$exitCode = 1

try {
  Start-Transcript -LiteralPath $transcriptPath -Force | Out-Null
  $transcriptStarted = $true

  Require-Check -Id 'preflight.windows' -Condition ($env:OS -eq 'Windows_NT') `
    -PassDetail 'Running on Windows.' -FailDetail 'This lifecycle runner must run on Windows.'
  $installerPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Installer).Path)
  Require-Check -Id 'preflight.exe' -Condition ([IO.Path]::GetExtension($installerPath) -ieq '.exe') `
    -PassDetail 'Installer is an EXE.' -FailDetail 'Partner Center direct submission requires the selected EXE installer.'
  $registryBefore = @(Get-LilyUninstallEntries)
  $registryBefore | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'registry-before.json') -Encoding UTF8
  Require-Check -Id 'preflight.clean_install_state' -Condition ($registryBefore.Count -eq 0) `
    -PassDetail 'No Lily Workbench uninstall entry exists.' -FailDetail 'Use a clean Windows user or Sandbox; Lily Workbench is already installed.' -Evidence $registryBefore
  Require-Check -Id 'preflight.no_running_app' -Condition ((Get-LilyProcesses).Count -eq 0) `
    -PassDetail 'No Lily process is running.' -FailDetail 'Close Lily Workbench before testing.'

  $installerItem = Get-Item -LiteralPath $installerPath
  $installerSignature = Get-SignatureRecord -Path $installerPath
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $identity
  $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $script:Report.installer = [ordered]@{
    path = $installerPath
    sizeBytes = $installerItem.Length
    sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
    signature = $installerSignature
  }
  $script:Report.machine = [ordered]@{
    computerName = $env:COMPUTERNAME
    userName = [Environment]::UserName
    osVersion = [Environment]::OSVersion.VersionString
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    isAdministrator = $isAdministrator
  }
  Add-Check -Id 'environment.standard_user' `
    -Status $(if ($isAdministrator) { 'warning' } else { 'pass' }) `
    -Detail $(if ($isAdministrator) { 'This run uses an administrator account; retain a second direct run from a standard-user VM.' } else { 'This run uses a standard Windows account.' })

  if ($RequireSignature) {
    Require-Check -Id 'signature.installer' -Condition ($installerSignature.status -eq 'Valid') `
      -PassDetail 'Installer Authenticode signature is valid.' `
      -FailDetail ('Installer signature status is ' + $installerSignature.status + '.') `
      -Evidence $installerSignature
  } elseif ($installerSignature.status -eq 'Valid') {
    Add-Check -Id 'signature.installer' -Status 'pass' -Detail 'Installer Authenticode signature is valid.' -Evidence $installerSignature
  } else {
    Add-Check -Id 'signature.installer' -Status 'warning' -Detail ('Unsigned rehearsal: installer signature status is ' + $installerSignature.status + '.') -Evidence $installerSignature
  }
  if ($ExpectedPublisher) {
    Require-Check -Id 'signature.publisher' `
      -Condition ($installerSignature.signerSubject.IndexOf($ExpectedPublisher, [StringComparison]::OrdinalIgnoreCase) -ge 0) `
      -PassDetail 'Installer signer matches the expected publisher.' `
      -FailDetail ('Installer signer subject is ' + $installerSignature.signerSubject + '.') `
      -Evidence $installerSignature
  }

  $installResult = Invoke-MonitoredProcess -FilePath $installerPath -ArgumentList @('/S', '/currentuser') `
    -TimeoutSeconds $InstallTimeoutSeconds -Label 'installer'
  Require-Check -Id 'install.timeout' -Condition (-not $installResult.timedOut) `
    -PassDetail 'Silent install completed within the timeout.' -FailDetail 'Silent install timed out.' -Evidence $installResult
  Require-Check -Id 'install.exit_code' -Condition ($installResult.exitCode -eq 0) `
    -PassDetail 'Silent install returned exit code 0.' -FailDetail ('Silent install exit code was ' + $installResult.exitCode + '.') -Evidence $installResult
  Require-Check -Id 'install.no_visible_ui' -Condition ($installResult.visibleWindows.Count -eq 0) `
    -PassDetail 'No installer-owned UI was observed.' -FailDetail 'Installer-owned visible UI was observed.' -Evidence $installResult.visibleWindows

  $entries = @(Get-LilyUninstallEntries)
  $entries | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'registry-installed.json') -Encoding UTF8
  Require-Check -Id 'install.single_product_entry' -Condition ($entries.Count -eq 1) `
    -PassDetail 'Exactly one Lily Workbench product entry exists.' -FailDetail ('Expected one product entry, found ' + $entries.Count + '.') -Evidence $entries
  $script:InstalledEntry = $entries[0]
  $missingFields = @('DisplayName', 'Publisher', 'DisplayVersion', 'InstallLocation', 'UninstallString', 'QuietUninstallString') |
    Where-Object { [string]::IsNullOrWhiteSpace([string]$script:InstalledEntry.$_) }
  Require-Check -Id 'install.product_metadata' -Condition ($missingFields.Count -eq 0) `
    -PassDetail 'Add/Remove Programs metadata is complete.' -FailDetail ('Missing metadata fields: ' + ($missingFields -join ', ')) -Evidence $script:InstalledEntry
  if ($ExpectedPublisher) {
    Require-Check -Id 'install.publisher' `
      -Condition ($script:InstalledEntry.Publisher.IndexOf($ExpectedPublisher, [StringComparison]::OrdinalIgnoreCase) -ge 0) `
      -PassDetail 'Installed publisher matches the expected publisher.' `
      -FailDetail ('Installed publisher is ' + $script:InstalledEntry.Publisher + '.')
  }
  if ($ExpectedVersion) {
    Require-Check -Id 'install.version' -Condition ($script:InstalledEntry.DisplayVersion -eq $ExpectedVersion) `
      -PassDetail 'Installed version matches the selected artifact.' `
      -FailDetail ('Expected ' + $ExpectedVersion + ', found ' + $script:InstalledEntry.DisplayVersion + '.')
  }

  $script:InstallDirectory = Resolve-InstallDirectory -Entry $script:InstalledEntry
  $mainExe = Join-Path $script:InstallDirectory 'LilyWorkbench.exe'
  Require-Check -Id 'install.main_exe' -Condition (Test-Path -LiteralPath $mainExe -PathType Leaf) `
    -PassDetail 'Installed LilyWorkbench.exe exists.' -FailDetail ('Missing ' + $mainExe + '.')
  $shortcuts = @(Get-LilyShortcuts)
  Require-Check -Id 'install.shortcuts' -Condition ($shortcuts.Count -ge 2) `
    -PassDetail 'Desktop and Start menu shortcuts were discovered.' -FailDetail 'Expected desktop and Start menu shortcuts.' -Evidence $shortcuts

  $signatureInventory = @(Get-PeSignatureInventory -InstallDirectory $script:InstallDirectory)
  $signatureInventory | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'signature-inventory.json') -Encoding UTF8
  $invalidPe = @($signatureInventory | Where-Object { $_.status -ne 'Valid' })
  if ($RequireSignature) {
    Require-Check -Id 'signature.installed_pe' -Condition ($invalidPe.Count -eq 0) `
      -PassDetail ('All ' + $signatureInventory.Count + ' installed PE files have valid signatures.') `
      -FailDetail ($invalidPe.Count.ToString() + ' installed PE files do not have valid signatures.') -Evidence $invalidPe
  } elseif ($invalidPe.Count -gt 0) {
    Add-Check -Id 'signature.installed_pe' -Status 'warning' `
      -Detail ($invalidPe.Count.ToString() + ' installed PE files are unsigned or invalid in rehearsal mode.') -Evidence $invalidPe
  } else {
    Add-Check -Id 'signature.installed_pe' -Status 'pass' -Detail 'All installed PE files have valid signatures.'
  }

  $launchResult = Invoke-LilyLaunchProbe -MainExe $mainExe -TimeoutSeconds $LaunchTimeoutSeconds
  Require-Check -Id 'launch.visible_window' -Condition $launchResult.visibleWindow `
    -PassDetail 'Lily Workbench created a visible main window.' -FailDetail 'No visible Lily Workbench window appeared.' -Evidence $launchResult
  Require-Check -Id 'launch.renderer_ready' -Condition ($null -ne $launchResult.rendererTarget) `
    -PassDetail 'Packaged renderer reached a recognized Lily Workbench page.' -FailDetail 'CDP did not observe the packaged Lily Workbench renderer.' -Evidence $launchResult
  Require-Check -Id 'launch.no_crash_event' -Condition ($launchResult.crashEvents.Count -eq 0) `
    -PassDetail 'No matching Windows crash event was recorded.' -FailDetail 'Windows recorded a Lily Workbench crash.' -Evidence $launchResult.crashEvents
  Require-Check -Id 'launch.normal_close' -Condition $launchResult.closedNormally `
    -PassDetail 'Lily Workbench closed through its main window.' -FailDetail 'Lily Workbench required forced test cleanup.'

  $uninstallCommand = Resolve-UninstallCommand -Entry $script:InstalledEntry -InstallDirectory $script:InstallDirectory
  Add-Check -Id 'uninstall.quiet_contract' `
    -Status $(if ($uninstallCommand.declaresSilent) { 'pass' } else { 'fail' }) `
    -Detail $(if ($uninstallCommand.declaresSilent) { 'QuietUninstallString explicitly contains uppercase /S.' } else { 'QuietUninstallString does not declare uppercase /S; /S was appended only for test cleanup.' }) `
    -Evidence $uninstallCommand

  $uninstallResult = Invoke-SilentUninstall -Entry $script:InstalledEntry `
    -InstallDirectory $script:InstallDirectory -TimeoutSeconds $UninstallTimeoutSeconds
  $registryAfter = @(Get-LilyUninstallEntries)
  $registryAfter | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'registry-after.json') -Encoding UTF8
  Require-Check -Id 'uninstall.timeout' -Condition (-not $uninstallResult.process.timedOut) `
    -PassDetail 'Silent uninstall process completed within the timeout.' -FailDetail 'Silent uninstall process timed out.' -Evidence $uninstallResult
  Require-Check -Id 'uninstall.exit_code' -Condition ($uninstallResult.process.exitCode -eq 0) `
    -PassDetail 'Silent uninstaller returned exit code 0.' -FailDetail ('Silent uninstaller exit code was ' + $uninstallResult.process.exitCode + '.') -Evidence $uninstallResult
  Require-Check -Id 'uninstall.no_visible_ui' -Condition ($uninstallResult.process.visibleWindows.Count -eq 0) `
    -PassDetail 'No uninstaller-owned UI was observed.' -FailDetail 'Uninstaller-owned visible UI was observed.' -Evidence $uninstallResult.process.visibleWindows
  Require-Check -Id 'uninstall.product_entry_removed' -Condition $uninstallResult.productEntryRemoved `
    -PassDetail 'Lily Workbench uninstall entry was removed.' -FailDetail 'Lily Workbench uninstall entry remains.'
  Require-Check -Id 'uninstall.install_directory_removed' -Condition $uninstallResult.installDirectoryRemoved `
    -PassDetail 'Install directory was removed after NSIS cleanup.' -FailDetail 'Install directory remains after NSIS cleanup.'
  Require-Check -Id 'uninstall.shortcuts_removed' -Condition ((Get-LilyShortcuts).Count -eq 0) `
    -PassDetail 'Lily Workbench shortcuts were removed.' -FailDetail 'Lily Workbench shortcuts remain.' -Evidence (Get-LilyShortcuts)

  $residues = @(Get-LilyUserDataResidues)
  if ($residues.Count -eq 0) {
    Add-Check -Id 'uninstall.user_data_residue' -Status 'pass' -Detail 'No known Lily user-data paths remain.'
  } elseif ($AllowUserDataRemnants) {
    Add-Check -Id 'uninstall.user_data_residue' -Status 'warning' `
      -Detail 'Known Lily user-data paths remain under the explicit rehearsal allowance.' -Evidence $residues
  } else {
    Add-Check -Id 'uninstall.user_data_residue' -Status 'fail' `
      -Detail 'Known Lily user-data paths remain; the final Microsoft clean-uninstall gate is not satisfied.' -Evidence $residues
  }

  Add-Check -Id 'certification.wack' -Status 'not_applicable' `
    -Detail 'Current WACK CLI supports packaged AppX/MSIX inputs; Lily is submitted as an unpackaged NSIS EXE.'
} catch {
  Add-Check -Id 'runner.exception' -Status 'fail' -Detail $_.Exception.Message
} finally {
  if (@(Get-LilyUninstallEntries).Count -gt 0) {
    Try-NormalUninstallCleanup
  }
  $finalInstallResidues = @(Get-LilyInstallResidues)
  if ($finalInstallResidues.Count -gt 0) {
    Add-Check -Id 'cleanup.install_residue' -Status 'fail' `
      -Detail 'Known Lily installation directories remain after normal cleanup.' -Evidence $finalInstallResidues
  }
  $finalUserDataResidues = @(Get-LilyUserDataResidues)
  $finalUserDataResidues | ConvertTo-Json -Depth 8 | Set-Content `
    -LiteralPath (Join-Path $OutputDirectory 'user-data-residue.json') -Encoding UTF8
  if (@($script:Checks | Where-Object { $_.id -eq 'uninstall.user_data_residue' }).Count -eq 0) {
    if ($finalUserDataResidues.Count -eq 0) {
      Add-Check -Id 'cleanup.user_data_residue' -Status 'pass' -Detail 'No known Lily user-data paths remain after cleanup.'
    } elseif ($AllowUserDataRemnants) {
      Add-Check -Id 'cleanup.user_data_residue' -Status 'warning' `
        -Detail 'Known Lily user-data paths remain after partial-failure cleanup under the rehearsal allowance.' -Evidence $finalUserDataResidues
    } else {
      Add-Check -Id 'cleanup.user_data_residue' -Status 'fail' `
        -Detail 'Known Lily user-data paths remain after partial-failure cleanup.' -Evidence $finalUserDataResidues
    }
  }
  if ($transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch { }
  }
  $exitCode = $(if (@($script:Checks | Where-Object { $_.status -eq 'fail' }).Count -eq 0) { 0 } else { 1 })
  try {
    Write-Reports
  } catch {
    Write-Error ('Could not write readiness reports: ' + $_.Exception.Message)
    $exitCode = 1
  }
  [IO.File]::WriteAllText((Join-Path $OutputDirectory 'readiness-exit-code.txt'), [string]$exitCode)
}

exit $exitCode
```

- [ ] **Step 5: Run the contract and commit**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: PASS.

Run: `rg -n 'runner\.scaffold|Lifecycle checks have not run' scripts/smoke-windows-store-installer.ps1`

Expected: no output.

```bash
git add scripts/test-windows-store-readiness.mjs scripts/smoke-windows-store-installer.ps1
git commit -m "feat: verify silent uninstall and residue policy"
```

### Task 5: Add the offline Windows Sandbox launcher

**Files:**
- Modify: `scripts/test-windows-store-readiness.mjs`
- Create: `scripts/start-windows-store-sandbox.ps1`

- [ ] **Step 1: Add failing Sandbox assertions**

Add after reading `runner`:

```js
const sandboxPath = path.join(root, "scripts", "start-windows-store-sandbox.ps1");
const sandbox = await readFile(sandboxPath, "utf8");
```

Insert before `console.log`:

```js
for (const [pattern, message] of [
  [/WindowsSandbox\.exe/, "launcher must require Windows Sandbox"],
  [/\.lily-work[\\/]windows-store-readiness/, "staging must stay in ignored scratch space"],
  [/<Networking>Disable<\/Networking>/, "offline install and launch must be tested"],
  [/<MappedFolders>/, "evidence directory must be mapped"],
  [/<ReadOnly>false<\/ReadOnly>/, "Sandbox must be able to return evidence"],
  [/<LogonCommand>/, "lifecycle runner must start automatically"],
  [/sandbox-options\.json/, "dynamic inputs must travel as JSON instead of command interpolation"],
  [/readiness-exit-code\.txt/, "host must wait for the inner result"],
  [/SandboxTimeoutSeconds/, "Sandbox wait must be bounded"],
  [/readiness-summary\.md/, "human report must be surfaced on host"],
]) {
  assert.match(sandbox, pattern, message);
}
assert.doesNotMatch(sandbox, /Enable-WindowsOptionalFeature|dism\.exe/i, "launcher must not mutate Windows optional features");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: FAIL with `ENOENT` for `scripts/start-windows-store-sandbox.ps1`.

- [ ] **Step 3: Implement the host-side launcher**

Create `scripts/start-windows-store-sandbox.ps1`:

```powershell
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$ExpectedPublisher = '',
  [string]$ExpectedVersion = '',
  [switch]$RequireSignature,
  [switch]$AllowUserDataRemnants,
  [ValidateRange(60, 1800)][int]$SandboxTimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'Windows Sandbox launcher must run on Windows.' }
$sandboxExe = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
if (-not (Test-Path -LiteralPath $sandboxExe -PathType Leaf)) {
  throw 'Windows Sandbox is unavailable. Enable Containers-DisposableClientVM, reboot, and retry.'
}

$installerPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Installer).Path)
$repoRoot = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $repoRoot ('.lily-work\windows-store-readiness\' + $stamp)
[IO.Directory]::CreateDirectory($stage) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $stage 'results')) | Out-Null

$runnerSource = Join-Path $PSScriptRoot 'smoke-windows-store-installer.ps1'
$runnerTarget = Join-Path $stage 'smoke-windows-store-installer.ps1'
$installerTarget = Join-Path $stage ([IO.Path]::GetFileName($installerPath))
Copy-Item -LiteralPath $runnerSource -Destination $runnerTarget
Copy-Item -LiteralPath $installerPath -Destination $installerTarget

$options = [ordered]@{
  installerFile = [IO.Path]::GetFileName($installerTarget)
  expectedPublisher = $ExpectedPublisher
  expectedVersion = $ExpectedVersion
  requireSignature = [bool]$RequireSignature
  allowUserDataRemnants = [bool]$AllowUserDataRemnants
}
$options | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage 'sandbox-options.json') -Encoding UTF8

$sandboxBootstrap = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = 'C:\LilyStoreReadiness'
$options = Get-Content -LiteralPath (Join-Path $root 'sandbox-options.json') -Raw | ConvertFrom-Json
$params = @{
  Installer = Join-Path $root $options.installerFile
  OutputDirectory = Join-Path $root 'results'
}
if ($options.expectedPublisher) { $params.ExpectedPublisher = [string]$options.expectedPublisher }
if ($options.expectedVersion) { $params.ExpectedVersion = [string]$options.expectedVersion }
if ([bool]$options.requireSignature) { $params.RequireSignature = $true }
if ([bool]$options.allowUserDataRemnants) { $params.AllowUserDataRemnants = $true }
& (Join-Path $root 'smoke-windows-store-installer.ps1') @params
'@
$sandboxBootstrap | Set-Content -LiteralPath (Join-Path $stage 'run-sandbox.ps1') -Encoding UTF8

$sandboxCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\LilyStoreReadiness\run-sandbox.ps1
if exist C:\LilyStoreReadiness\results\readiness-summary.md start "" notepad.exe C:\LilyStoreReadiness\results\readiness-summary.md
'@
$sandboxCmd | Set-Content -LiteralPath (Join-Path $stage 'run-sandbox.cmd') -Encoding ASCII

$escapedStage = [Security.SecurityElement]::Escape($stage)
$wsb = @"
<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$escapedStage</HostFolder>
      <SandboxFolder>C:\LilyStoreReadiness</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>cmd.exe /d /s /c C:\LilyStoreReadiness\run-sandbox.cmd</Command>
  </LogonCommand>
</Configuration>
"@
$wsbPath = Join-Path $stage 'LilyStoreReadiness.wsb'
$wsb | Set-Content -LiteralPath $wsbPath -Encoding UTF8

Start-Process -FilePath $sandboxExe -ArgumentList ('"' + $wsbPath + '"') | Out-Null
$sentinel = Join-Path $stage 'results\readiness-exit-code.txt'
$deadline = (Get-Date).AddSeconds($SandboxTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $sentinel) { break }
  Start-Sleep -Seconds 1
}
if (-not (Test-Path -LiteralPath $sentinel)) {
  throw ('Windows Sandbox readiness run timed out. Inspect: ' + $stage)
}

$exitCodeText = (Get-Content -LiteralPath $sentinel -Raw).Trim()
$parsedExitCode = 1
if (-not [int]::TryParse($exitCodeText, [ref]$parsedExitCode)) {
  throw ('Invalid readiness exit sentinel: ' + $exitCodeText)
}
$summary = Join-Path $stage 'results\readiness-summary.md'
if (Test-Path -LiteralPath $summary) { Get-Content -LiteralPath $summary }
Write-Host ('Evidence: ' + (Join-Path $stage 'results'))
exit $parsedExitCode
```

- [ ] **Step 4: Run the contract and commit**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: PASS.

```bash
git add scripts/test-windows-store-readiness.mjs scripts/start-windows-store-sandbox.ps1
git commit -m "feat: run Windows Store checks in offline Sandbox"
```

### Task 6: Add the operator runbook and release-SOP link

**Files:**
- Modify: `scripts/test-windows-store-readiness.mjs`
- Create: `docs/windows-store-release-readiness.md`
- Modify: `docs/release-and-deploy-sop.md:143`

- [ ] **Step 1: Add failing documentation assertions**

Add after the existing reads:

```js
const guidePath = path.join(root, "docs", "windows-store-release-readiness.md");
const sopPath = path.join(root, "docs", "release-and-deploy-sop.md");
const guide = await readFile(guidePath, "utf8");
const sop = await readFile(sopPath, "utf8");
```

Insert before `console.log`:

```js
for (const phrase of [
  "-RequireSignature",
  "-AllowUserDataRemnants",
  "/S /currentuser",
  "readiness-report.json",
  "readiness-summary.md",
  "Windows App Certification Kit",
  "不适用",
  "真实 Windows",
  "标准用户",
]) {
  assert.ok(guide.includes(phrase), `operator guide must explain ${phrase}`);
}
for (const url of [
  "https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements",
  "https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/manual-package-validation",
  "https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-certification-process",
]) {
  assert.ok(guide.includes(url), `operator guide must cite ${url}`);
}
assert.ok(sop.includes("windows-store-release-readiness.md"), "release SOP must link the Windows Store gate");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: FAIL with `ENOENT` for `docs/windows-store-release-readiness.md`.

- [ ] **Step 3: Create the exact Chinese operator guide**

Create `docs/windows-store-release-readiness.md` with:

```markdown
# Windows Store EXE 发布前自测

本流程用于 Lily Workbench 直接提交 EXE/MSI 通道的最终 x64 NSIS 安装器。它不会签名、上传或发布安装包，也不会删除聊天和工作区数据。

## 微软对应要求

- 安装器必须是版本化 HTTPS 地址上的离线 `.exe`，提交后同一 URL 的二进制不可替换。
- 安装器及其中全部 PE 文件必须具有受信 CA 链的有效 Authenticode 签名。
- Partner Center 的 Installer parameters 填写：`/S /currentuser`。
- 安装必须无安装器界面；微软允许 UAC，但当前用户安装通常不需要 UAC。
- 控制面板必须只有一条产品记录，并具有正确名称、发布者和版本。
- 应用必须在无网络环境下正常打开或明确降级，不能崩溃。
- 卸载必须静默，并检查安装目录、快捷方式、注册表与用户数据残留。

微软资料：

- <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements>
- <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/manual-package-validation>
- <https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-certification-process>

## 环境

推荐 Windows 11 Pro、Enterprise 或 Education，启用 Windows Sandbox。Sandbox 提供干净、离线环境，但默认账号具有管理员权限；微软还会验证标准用户安装，因此最终证据必须再包含一份干净标准用户 VM 上的直接运行报告。Windows Home 可直接使用该标准用户 VM 流程。

测试前准备最终版本化安装器，例如：

```powershell
$installer = 'C:\Release\Lily Workbench-0.1.119-x64.exe'
```

不要在已经安装 Lily Workbench 的账号上运行；脚本会拒绝覆盖现有安装。

## 证书到位前的演练

直接在干净 Windows 标准用户账号运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-store-installer.ps1 `
  -Installer $installer `
  -AllowUserDataRemnants
```

该命令验证 `/S /currentuser`、控制面板信息、启动、崩溃事件、静默卸载和残留。未签名 PE 会记为 warning；用户数据残留也仅在本次显式允许下记为 warning。

## Windows Sandbox 离线演练

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-windows-store-sandbox.ps1 `
  -Installer $installer `
  -AllowUserDataRemnants
```

启动器只把 `.lily-work\windows-store-readiness\时间戳` 映射为可写目录，关闭 Sandbox 后其他系统变化全部丢弃。Sandbox 网络被禁用，因此安装成功可证明 EXE 不是下载 stub，启动成功可证明断网不会导致崩溃。

## 最终签名 Store 门禁

```powershell
$installer = (Resolve-Path $installer).Path
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
  throw ('Installer signature is not valid: ' + $signature.Status)
}
if ([IO.Path]::GetFileName($installer) -notmatch '^Lily Workbench-(?<version>\d+\.\d+\.\d+)-x64\.exe$') {
  throw 'Installer filename is not versioned as expected.'
}
$publisher = $signature.SignerCertificate.GetNameInfo(
  [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
  $false
)
if ([string]::IsNullOrWhiteSpace($publisher)) {
  throw 'Could not derive the certificate publisher name.'
}
$version = $Matches.version

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-windows-store-sandbox.ps1 `
  -Installer $installer `
  -ExpectedPublisher $publisher `
  -ExpectedVersion $version `
  -RequireSignature

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\smoke-windows-store-installer.ps1 `
  -Installer $installer `
  -OutputDirectory C:\ReleaseEvidence\standard-user `
  -ExpectedPublisher $publisher `
  -ExpectedVersion $version `
  -RequireSignature
```

最终命令故意不传 `-AllowUserDataRemnants`。若 `%APPDATA%\lily-workbench`、更新器目录或 Documents 下 Lily 工作区仍存在，报告会失败但不会删除它们。是否改变卸载数据策略必须另行评审，不能为了过测试直接清空用户资料。

## 报告

每次运行至少保留：

- `readiness-report.json`：机器、安装器 SHA-256、签名和所有检查状态；
- `readiness-summary.md`：提交负责人可读的 PASS/FAIL 摘要；
- `readiness-transcript.log`：运行过程；
- `signature-inventory.json`：安装目录内所有 PE 签名；
- `registry-before.json`、`registry-installed.json`、`registry-after.json`：安装生命周期注册表快照；
- `user-data-residue.json`：任何已知 AppData、更新器或 Documents 残留；
- `startup-event-log.json` 与 `chromium.log`：首次启动证据；
- `readiness-exit-code.txt`：`0` 表示所有必需项通过，`1` 表示至少一项失败。

`warning` 和 `not_applicable` 永远保留在报告中，不会伪装成 `pass`。

## Windows App Certification Kit

当前 Windows App Certification Kit 命令行正式接受 package full name 或 AppX/MSIX 包路径。Lily 当前提交的是未封装 NSIS EXE，因此 WACK 对本产物不适用；旧版 `-apptype desktop -setuppath` 属于 Windows 8.1 历史文档，不能当作 2026 年认证结论。

本流程实现微软当前对直接 EXE/MSI 的官方自测项目。若将来新增 MSIX，再为 MSIX 单独接入当时版本的 WACK。

## 完成标准

只有对准备提交的同一个签名、版本化 EXE 完成两次严格运行——离线 Windows Sandbox 与干净标准用户 VM——并且两次退出码均为 `0`，才能说发布前 Windows 自测通过。macOS 上的 Node 契约测试只能证明工具结构已准备，不能证明安装、启动、卸载或微软认证通过。
```

- [ ] **Step 4: Link the guide from the existing desktop release flow**

Insert immediately before `### Desktop Release Verification` in `docs/release-and-deploy-sop.md`:

```markdown
### Windows Store EXE Pre-Submission Gate

Before publishing or submitting a Windows EXE to Partner Center, run the clean
Windows lifecycle and signature gate in
[`windows-store-release-readiness.md`](windows-store-release-readiness.md).
Keep the generated report directory with the release evidence. A macOS package
content check does not replace the real Windows install/launch/uninstall run.

```

- [ ] **Step 5: Run the contract and commit**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: PASS.

```bash
git add scripts/test-windows-store-readiness.mjs docs/windows-store-release-readiness.md docs/release-and-deploy-sop.md
git commit -m "docs: add Windows Store EXE readiness runbook"
```

### Task 7: Verify the prepared tooling without overstating Windows results

**Files:**
- Verify: `scripts/smoke-windows-store-installer.ps1`
- Verify: `scripts/start-windows-store-sandbox.ps1`
- Verify: `scripts/test-windows-store-readiness.mjs`
- Verify: `docs/windows-store-release-readiness.md`
- Verify: `docs/release-and-deploy-sop.md`

- [ ] **Step 1: Run the focused contract freshly**

Run: `node scripts/test-windows-store-readiness.mjs`

Expected: PASS and print `windows store readiness contracts ok`.

- [ ] **Step 2: Run the existing Windows installer guard**

Run: `node scripts/test-windows-installer-guard.mjs`

Expected: PASS and print `windows installer guard config ok`.

- [ ] **Step 3: Run repository whitespace and completeness gates**

Run: `git diff --check`

Expected: exit 0 with no output.

Run: `rg -n 'runner\.scaffold|Lifecycle checks have not run' scripts/smoke-windows-store-installer.ps1`

Expected: no output.

- [ ] **Step 4: Run the auto-discovered unit suite**

Run: `npm run test:unit`

Expected: all discovered tests pass, including `test-windows-store-readiness.mjs` and `test-windows-installer-guard.mjs`.

- [ ] **Step 5: Parse both scripts with Windows PowerShell 5.1 when Windows is available**

Run on Windows:

```powershell
$tokens = $null
$errors = $null
foreach ($file in @(
  '.\scripts\smoke-windows-store-installer.ps1',
  '.\scripts\start-windows-store-sandbox.ps1'
)) {
  [Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $file),
    [ref]$tokens,
    [ref]$errors
  ) | Out-Null
  if ($errors.Count -gt 0) {
    $errors | Format-List -Force
    exit 1
  }
}
```

Expected: exit 0 with no parser errors. On macOS, mark this check not run; Node static coverage is not a PowerShell parser.

- [ ] **Step 6: Record the platform limitation honestly**

If execution is on macOS, record in the handoff:

```text
Automated repository contracts passed on macOS. The NSIS installer lifecycle was not run because it requires a real Windows desktop. Tooling is prepared; Windows Store readiness is not yet certified.
```

If a clean Windows machine and final installer are available, run both strict commands from `docs/windows-store-release-readiness.md`: the offline Sandbox run and the direct clean standard-user VM run. Attach both report directories. Expected: both exit codes are `0`; otherwise report the exact failed check IDs and do not claim readiness.
