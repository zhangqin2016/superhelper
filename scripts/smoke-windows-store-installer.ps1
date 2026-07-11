[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [string]$OutputDirectory = "",
  [string]$ExpectedPublisher = "",
  [string]$ExpectedVersion = "",
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
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputDirectory = Join-Path ([Environment]::CurrentDirectory) ("windows-store-readiness-" + $stamp)
}

$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$Checks = New-Object System.Collections.Generic.List[object]
$Report = [ordered]@{
  schemaVersion = 1
  product = "Lily Workbench"
  startedAt = (Get-Date).ToString("o")
  completedAt = $null
  installer = [ordered]@{
    path = $Installer
    expectedPublisher = $ExpectedPublisher
    expectedVersion = $ExpectedVersion
    requireSignature = [bool]$RequireSignature
    allowUserDataRemnants = [bool]$AllowUserDataRemnants
    installTimeoutSeconds = $InstallTimeoutSeconds
    launchTimeoutSeconds = $LaunchTimeoutSeconds
    uninstallTimeoutSeconds = $UninstallTimeoutSeconds
  }
  machine = [ordered]@{
    computerName = [Environment]::MachineName
    userName = [Environment]::UserName
    osVersion = [Environment]::OSVersion.VersionString
    powershellVersion = $PSVersionTable.PSVersion.ToString()
  }
  checks = @()
}

function Add-Check {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Id,

    [Parameter(Mandatory = $true)]
    [string]$Title,

    [Parameter(Mandatory = $true)]
    [ValidateSet("pass", "warning", "fail", "not_applicable")]
    [string]$Status,

    [string]$Details = ""
  )

  $check = [ordered]@{
    id = $Id
    title = $Title
    status = $Status
    details = $Details
    recordedAt = (Get-Date).ToString("o")
  }
  $script:Checks.Add($check) | Out-Null
  return $check
}

function Require-Check {
  param(
    [Parameter(Mandatory = $true)]
    [bool]$Condition,

    [Parameter(Mandatory = $true)]
    [string]$Id,

    [Parameter(Mandatory = $true)]
    [string]$Title,

    [string]$FailureMessage = "Required check failed."
  )

  if (-not $Condition) {
    Add-Check -Id $Id -Title $Title -Status "fail" -Details $FailureMessage | Out-Null
    throw $FailureMessage
  }
}

function Write-Reports {
  $script:Report.completedAt = (Get-Date).ToString("o")
  $script:Report.checks = @($script:Checks)

  $jsonPath = Join-Path $script:OutputDirectory "readiness-report.json"
  $summaryPath = Join-Path $script:OutputDirectory "readiness-summary.md"
  $script:Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

  $failedChecks = @($script:Checks | Where-Object { $_.status -eq "fail" })
  $overall = "PASS"
  if ($failedChecks.Count -gt 0) {
    $overall = "FAIL"
  }

  $summaryLines = New-Object System.Collections.Generic.List[string]
  $summaryLines.Add("# Windows Store Readiness") | Out-Null
  $summaryLines.Add("") | Out-Null
  $summaryLines.Add("Overall: " + $overall) | Out-Null
  $summaryLines.Add("") | Out-Null
  $summaryLines.Add("## Checks") | Out-Null
  $summaryLines.Add("") | Out-Null

  foreach ($check in $script:Checks) {
    $summaryLines.Add(("- {0}: {1} - {2}" -f ([string]$check.status).ToUpperInvariant(), $check.id, $check.title)) | Out-Null
    if (-not [string]::IsNullOrWhiteSpace([string]$check.details)) {
      $summaryLines.Add(("  " + $check.details)) | Out-Null
    }
  }

  Set-Content -LiteralPath $summaryPath -Value $summaryLines -Encoding UTF8
}

$transcriptPath = Join-Path $OutputDirectory "readiness-transcript.log"
$exitCodePath = Join-Path $OutputDirectory "readiness-exit-code.txt"
$transcriptStarted = $false
$exitCode = 1

try {
  Start-Transcript -Path $transcriptPath -Force | Out-Null
  $transcriptStarted = $true

  Add-Check `
    -Id "runner.scaffold" `
    -Title "Installer lifecycle" `
    -Status "fail" `
    -Details "The install, launch, and uninstall lifecycle has not been implemented yet." | Out-Null
} catch {
  Add-Check `
    -Id "runner.exception" `
    -Title "Runner exception" `
    -Status "fail" `
    -Details $_.Exception.Message | Out-Null
} finally {
  $failedChecks = @($Checks | Where-Object { $_.status -eq "fail" })
  if ($failedChecks.Count -eq 0) {
    $exitCode = 0
  } else {
    $exitCode = 1
  }

  if ($transcriptStarted) {
    try {
      Stop-Transcript | Out-Null
    } catch {
      Write-Warning ("Unable to stop transcript: " + $_.Exception.Message)
    }
  }

  try {
    Write-Reports
  } catch {
    $exitCode = 1
    Write-Warning ("Unable to write readiness reports: " + $_.Exception.Message)
  }

  Set-Content -LiteralPath $exitCodePath -Value $exitCode -Encoding ASCII
}

exit $exitCode
