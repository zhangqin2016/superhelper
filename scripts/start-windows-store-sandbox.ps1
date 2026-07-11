[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [string]$ExpectedPublisher = "",
  [string]$ExpectedVersion = "",
  [switch]$RequireSignature,
  [switch]$AllowUserDataRemnants,

  [ValidateRange(60, 1800)]
  [int]$SandboxTimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "This launcher can only run on Windows."
}

$sandboxExecutable = Join-Path $env:WINDIR "System32\WindowsSandbox.exe"
if (-not (Test-Path -LiteralPath $sandboxExecutable -PathType Leaf)) {
  throw "Windows Sandbox is unavailable. Enable the Containers-DisposableClientVM optional feature, restart Windows, and retry."
}

$resolvedInstaller = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).ProviderPath
if (-not (Test-Path -LiteralPath $resolvedInstaller -PathType Leaf)) {
  throw ("The installer must be a file: " + $resolvedInstaller)
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$smokeRunnerPath = Join-Path $repoRoot "scripts\smoke-windows-store-installer.ps1"
if (-not (Test-Path -LiteralPath $smokeRunnerPath -PathType Leaf)) {
  throw ("The Windows Store smoke runner is missing: " + $smokeRunnerPath)
}

$stageRoot = Join-Path (Join-Path $repoRoot ".lily-work") "windows-store-readiness"
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

$stageStamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
$stageSuffix = [Guid]::NewGuid().ToString("N")
$stage = Join-Path $stageRoot ("sandbox-" + $stageStamp + "-" + $stageSuffix)
$resultsDirectory = Join-Path $stage "results"
New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path $resultsDirectory | Out-Null

$installerFile = [System.IO.Path]::GetFileName($resolvedInstaller)
$stagedInstaller = Join-Path $stage $installerFile
$stagedSmokeRunner = Join-Path $stage "smoke-windows-store-installer.ps1"
Copy-Item -LiteralPath $smokeRunnerPath -Destination $stagedSmokeRunner
Copy-Item -LiteralPath $resolvedInstaller -Destination $stagedInstaller

$optionsPath = Join-Path $stage "sandbox-options.json"
$sandboxOptions = [ordered]@{
  installerFile = $installerFile
  expectedPublisher = $ExpectedPublisher
  expectedVersion = $ExpectedVersion
  requireSignature = [bool]$RequireSignature
  allowUserDataRemnants = [bool]$AllowUserDataRemnants
}
$sandboxOptions | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $optionsPath -Encoding UTF8

$bootstrapPath = Join-Path $stage "sandbox-bootstrap.ps1"
$bootstrapContent = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = "C:\LilyStoreReadiness"
$optionsPath = Join-Path $root "sandbox-options.json"
$options = Get-Content -LiteralPath $optionsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runnerPath = Join-Path $root "smoke-windows-store-installer.ps1"
$outputDirectory = Join-Path $root "results"

$runnerParameters = @{
  Installer = Join-Path $root ([string]$options.installerFile)
  OutputDirectory = $outputDirectory
}
if (-not [string]::IsNullOrWhiteSpace([string]$options.expectedPublisher)) {
  $runnerParameters["ExpectedPublisher"] = [string]$options.expectedPublisher
}
if (-not [string]::IsNullOrWhiteSpace([string]$options.expectedVersion)) {
  $runnerParameters["ExpectedVersion"] = [string]$options.expectedVersion
}
if ([bool]$options.requireSignature) {
  $runnerParameters["RequireSignature"] = $true
}
if ([bool]$options.allowUserDataRemnants) {
  $runnerParameters["AllowUserDataRemnants"] = $true
}

& $runnerPath @runnerParameters
'@
Set-Content -LiteralPath $bootstrapPath -Value $bootstrapContent -Encoding ASCII

$commandPath = Join-Path $stage "run-readiness.cmd"
$commandContent = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\LilyStoreReadiness\sandbox-bootstrap.ps1"
set "LILY_READINESS_EXIT_CODE=%ERRORLEVEL%"
if exist "C:\LilyStoreReadiness\results\readiness-summary.md" start "" notepad.exe "C:\LilyStoreReadiness\results\readiness-summary.md"
exit /b %LILY_READINESS_EXIT_CODE%
'@
Set-Content -LiteralPath $commandPath -Value $commandContent -Encoding ASCII

$escapedStage = [Security.SecurityElement]::Escape($stage)
$sandboxConfiguration = @"
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
    <Command>cmd.exe /c "C:\LilyStoreReadiness\run-readiness.cmd"</Command>
  </LogonCommand>
</Configuration>
"@
$wsbPath = Join-Path $stage "windows-store-readiness.wsb"
Set-Content -LiteralPath $wsbPath -Value $sandboxConfiguration -Encoding UTF8

$exitCodePath = Join-Path $resultsDirectory "readiness-exit-code.txt"
$summaryPath = Join-Path $resultsDirectory "readiness-summary.md"
[int]$innerExitCode = 1

try {
  $sandboxProcess = Start-Process `
    -FilePath $sandboxExecutable `
    -ArgumentList @("`"$wsbPath`"") `
    -PassThru
  Write-Verbose ("Windows Sandbox process id: " + $sandboxProcess.Id)

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath $exitCodePath -PathType Leaf)) {
    if ($stopwatch.Elapsed.TotalSeconds -ge $SandboxTimeoutSeconds) {
      throw ("Windows Sandbox readiness timed out. Evidence remains at: " + $stage)
    }
    Start-Sleep -Seconds 1
  }
  $stopwatch.Stop()

  $exitCodeText = (Get-Content -LiteralPath $exitCodePath -Raw -Encoding ASCII).Trim()
  if (-not [int]::TryParse($exitCodeText, [ref]$innerExitCode)) {
    throw ("The Sandbox readiness exit-code sentinel is invalid: " + $exitCodeText)
  }

  if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
    Write-Output (Get-Content -LiteralPath $summaryPath -Raw -Encoding UTF8)
  }
} finally {
  Write-Host ("Evidence path: " + $stage)
}

exit $innerExitCode
