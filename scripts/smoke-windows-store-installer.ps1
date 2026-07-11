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
$script:InstalledEntry = $null
$Report = [ordered]@{
  schemaVersion = 1
  product = "Lily Workbench"
  startedAt = (Get-Date).ToString("o")
  completedAt = $null
  evidenceFiles = @(
    "signature-inventory.json"
    "registry-before.json"
    "registry-installed.json"
    "registry-after.json"
    "chromium.log"
    "startup-event-log.json"
  )
  evidence = [ordered]@{}
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
    [ValidateSet("pass", "warning", "fail", "not_applicable")]
    [string]$Status,

    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Detail,

    [AllowNull()]
    [object]$Evidence = $null
  )

  $check = [ordered]@{
    id = $Id
    status = $Status
    detail = $Detail
    evidence = $Evidence
    recordedAt = (Get-Date).ToString("o")
  }
  $script:Checks.Add($check) | Out-Null
  return $check
}

function Require-Check {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Id,

    [Parameter(Mandatory = $true)]
    [bool]$Condition,

    [Parameter(Mandatory = $true)]
    [string]$PassDetail,

    [Parameter(Mandatory = $true)]
    [string]$FailDetail,

    [AllowNull()]
    [object]$Evidence = $null
  )

  if ($Condition) {
    Add-Check -Id $Id -Status "pass" -Detail $PassDetail -Evidence $Evidence | Out-Null
    return
  }

  Add-Check -Id $Id -Status "fail" -Detail $FailDetail -Evidence $Evidence | Out-Null
  throw $FailDetail
}

function Get-ObjectPropertyValue {
  param(
    [Parameter(Mandatory = $true)]
    [object]$InputObject,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return ""
  }

  return [string]$property.Value
}

function Write-JsonEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FileName,

    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [object[]]$Value
  )

  $evidencePath = Join-Path $script:OutputDirectory $FileName
  ConvertTo-Json -InputObject $Value -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
  $script:Report["evidence"][$FileName] = $evidencePath
  return $evidencePath
}

function Get-LilyUninstallEntries {
  $registryRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )

  foreach ($registryRoot in $registryRoots) {
    if (-not (Test-Path -LiteralPath $registryRoot)) {
      continue
    }

    foreach ($registryKey in @(Get-ChildItem -LiteralPath $registryRoot -ErrorAction Stop)) {
      $properties = Get-ItemProperty -LiteralPath $registryKey.PSPath -ErrorAction Stop
      $displayName = Get-ObjectPropertyValue -InputObject $properties -Name "DisplayName"
      if ($displayName -ne "Lily Workbench" -and $displayName -ne "智能工作台") {
        continue
      }

      [pscustomobject][ordered]@{
        RegistryPath = [string]$registryKey.PSPath
        DisplayName = $displayName
        Publisher = Get-ObjectPropertyValue -InputObject $properties -Name "Publisher"
        DisplayVersion = Get-ObjectPropertyValue -InputObject $properties -Name "DisplayVersion"
        InstallLocation = Get-ObjectPropertyValue -InputObject $properties -Name "InstallLocation"
        DisplayIcon = Get-ObjectPropertyValue -InputObject $properties -Name "DisplayIcon"
        UninstallString = Get-ObjectPropertyValue -InputObject $properties -Name "UninstallString"
        QuietUninstallString = Get-ObjectPropertyValue -InputObject $properties -Name "QuietUninstallString"
      }
    }
  }
}

function Get-LilyProcesses {
  $processNames = @(
    "LilyWorkbench"
    "Lily Workbench"
    "lily-workbench"
    "智能工作台"
  )

  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $processNames -contains $_.ProcessName
  })
}

function Get-ProcessTreeIds {
  param(
    [Parameter(Mandatory = $true)]
    [int]$RootId
  )

  $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  $treeIds = New-Object "System.Collections.Generic.HashSet[int]"
  $treeIds.Add($RootId) | Out-Null

  $foundDescendant = $true
  while ($foundDescendant) {
    $foundDescendant = $false
    foreach ($process in $processes) {
      $processId = [int]$process.ProcessId
      $parentProcessId = [int]$process.ParentProcessId
      if ($treeIds.Contains($parentProcessId) -and $treeIds.Add($processId)) {
        $foundDescendant = $true
      }
    }
  }

  return @($treeIds | Sort-Object)
}

function Get-ProcessStartTicks {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process
  )

  try {
    return [long]$Process.StartTime.ToUniversalTime().Ticks
  } catch {
    return $null
  }
}

function Get-FreeLoopbackPort {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
}

function Wait-LilyRenderer {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )

  $knownTitles = @(
    "Lily Workbench"
    "智能工作台"
    "Smart Workbench"
    "منصة العمل الذكية"
  )
  $rendererTarget = $null
  $visibleWindow = $null
  $lastProcessIds = @()
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

  while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    $rootProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $rootProcess) {
      $stopwatch.Stop()
      return [pscustomobject][ordered]@{
        target = $null
        visibleWindow = $null
        rootExited = $true
        processIds = @($lastProcessIds)
      }
    }

    $lastProcessIds = @(Get-ProcessTreeIds -RootId $ProcessId)
    foreach ($treeId in $lastProcessIds) {
      $treeProcess = Get-Process -Id $treeId -ErrorAction SilentlyContinue
      if ($null -eq $treeProcess) {
        continue
      }

      try {
        $mainWindowHandle = [long]$treeProcess.MainWindowHandle
        if ($null -eq $visibleWindow -and $mainWindowHandle -ne 0) {
          $visibleWindow = [pscustomobject][ordered]@{
            processId = [int]$treeProcess.Id
            processName = [string]$treeProcess.ProcessName
            mainWindowHandle = $mainWindowHandle
            windowTitle = [string]$treeProcess.MainWindowTitle
          }
          break
        }
      } catch {
        # A process can exit between tree enumeration and window inspection.
      }
    }

    $rendererTarget = $null
    try {
      $targetResponse = Invoke-RestMethod `
        -Uri ("http://127.0.0.1:{0}/json/list" -f $Port) `
        -Method Get `
        -TimeoutSec 2 `
        -ErrorAction Stop
      $targets = @($targetResponse | Write-Output)
      $rendererTarget = @($targets | Where-Object {
        $targetType = Get-ObjectPropertyValue -InputObject $_ -Name "type"
        $isPageTarget = [string]::Equals($targetType, "page", [System.StringComparison]::Ordinal)
        $targetTitle = Get-ObjectPropertyValue -InputObject $_ -Name "title"
        $targetUrl = Get-ObjectPropertyValue -InputObject $_ -Name "url"
        $isPageTarget -and
        ($knownTitles -ccontains $targetTitle) -and
        ($targetUrl -match 'renderer[/\\]index\.html')
      } | Select-Object -First 1)
      if ($rendererTarget.Count -gt 0) {
        $rendererTarget = $rendererTarget[0]
      } else {
        $rendererTarget = $null
      }
    } catch {
      # Chromium's loopback endpoint is expected to refuse requests until startup completes.
      $rendererTarget = $null
    }

    if ($null -ne $rendererTarget -and $null -ne $visibleWindow) {
      $stopwatch.Stop()
      return [pscustomobject][ordered]@{
        target = $rendererTarget
        visibleWindow = $visibleWindow
        rootExited = $false
        processIds = @($lastProcessIds)
      }
    }

    Start-Sleep -Milliseconds 250
  }

  $stopwatch.Stop()
  return [pscustomobject][ordered]@{
    target = $null
    visibleWindow = $visibleWindow
    rootExited = $false
    processIds = @($lastProcessIds)
  }
}

function Get-LilyCrashEvents {
  param(
    [Parameter(Mandatory = $true)]
    [datetime]$StartTime
  )

  try {
    $applicationEvents = @(Get-WinEvent `
      -FilterHashtable @{
        LogName = "Application"
        StartTime = $StartTime
      } `
      -ErrorAction Stop)
  } catch {
    if ($_.FullyQualifiedErrorId -like "NoMatchingEventsFound*") {
      $applicationEvents = @()
    } else {
      throw ("Unable to query the Windows Application event log: " + $_.Exception.Message)
    }
  }

  $crashEvents = @($applicationEvents | Where-Object {
    ($_.ProviderName -eq "Application Error" -or $_.ProviderName -eq "Windows Error Reporting") -and
    ([string]$_.Message -match '(?i)(LilyWorkbench\.exe|Lily Workbench\.exe)')
  } | ForEach-Object {
    [pscustomobject][ordered]@{
      timeCreated = $_.TimeCreated.ToString("o")
      providerName = [string]$_.ProviderName
      eventId = [int]$_.Id
      level = [string]$_.LevelDisplayName
      recordId = [long]$_.RecordId
      message = [string]$_.Message
    }
  })

  Write-JsonEvidence -FileName "startup-event-log.json" -Value @($crashEvents) | Out-Null
  return @($crashEvents)
}

function Invoke-LilyLaunchProbe {
  param(
    [Parameter(Mandatory = $true)]
    [string]$MainExe,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )

  $startedAt = Get-Date
  $chromiumLog = Join-Path $script:OutputDirectory "chromium.log"
  $startupEventLog = Join-Path $script:OutputDirectory "startup-event-log.json"
  $script:Report["evidence"]["chromium.log"] = $chromiumLog
  $script:Report["evidence"]["startup-event-log.json"] = $startupEventLog

  $port = $null
  $rootProcess = $null
  $rootId = $null
  $rootStartTicks = $null
  $ownedStartTicks = @{}
  $rendererProbe = [pscustomobject][ordered]@{
    target = $null
    visibleWindow = $null
    rootExited = $false
    processIds = @()
  }
  $remainedAlive = $false
  $exitedUnexpectedly = $false
  $closedNormally = $false
  $crashEvents = @()
  $probeError = ""
  $crashEventQueryError = ""
  $cleanupError = ""
  $remainingOwnedProcessIds = @()

  try {
    $port = Get-FreeLoopbackPort
    $launchArguments = @(
      "--remote-debugging-address=127.0.0.1"
      ("--remote-debugging-port=" + $port)
      "--enable-logging=file"
      ("--log-file=`"" + $chromiumLog + "`"")
    )
    $rootProcess = Start-Process -FilePath $MainExe -ArgumentList $launchArguments -PassThru
    $rootId = [int]$rootProcess.Id
    $rootStartTicks = Get-ProcessStartTicks -Process $rootProcess
    if ($null -eq $rootStartTicks) {
      throw ("Unable to read the Lily Workbench launch process start time: " + $rootId)
    }
    $ownedStartTicks[[string]$rootId] = [long]$rootStartTicks

    $rendererProbe = Wait-LilyRenderer `
      -Port $port `
      -ProcessId $rootId `
      -TimeoutSeconds $TimeoutSeconds

    foreach ($treeId in @($rendererProbe.processIds)) {
      $treeProcess = Get-Process -Id $treeId -ErrorAction SilentlyContinue
      if ($null -eq $treeProcess) {
        continue
      }
      $treeStartTicks = Get-ProcessStartTicks -Process $treeProcess
      if ($null -ne $treeStartTicks -and [long]$treeStartTicks -ge [long]$rootStartTicks) {
        $ownedStartTicks[[string]$treeId] = [long]$treeStartTicks
      }
    }

    $currentRoot = Get-Process -Id $rootId -ErrorAction SilentlyContinue
    if ($null -eq $currentRoot) {
      $exitedUnexpectedly = $true
    } else {
      $currentRootStartTicks = Get-ProcessStartTicks -Process $currentRoot
      if ($null -eq $currentRootStartTicks -or
          [long]$currentRootStartTicks -ne [long]$rootStartTicks) {
        $exitedUnexpectedly = $true
      } else {
        $remainedAlive = $true
      }
    }

    if ($remainedAlive) {
      foreach ($treeId in @(Get-ProcessTreeIds -RootId $rootId)) {
        $treeProcess = Get-Process -Id $treeId -ErrorAction SilentlyContinue
        if ($null -eq $treeProcess) {
          continue
        }
        $treeStartTicks = Get-ProcessStartTicks -Process $treeProcess
        if ($null -ne $treeStartTicks -and [long]$treeStartTicks -ge [long]$rootStartTicks) {
          $ownedStartTicks[[string]$treeId] = [long]$treeStartTicks
        }
      }

      if (-not $rootProcess.CloseMainWindow()) {
        throw "Lily Workbench did not accept the normal window-close request."
      }
      Wait-Process -InputObject $rootProcess -Timeout 15 -ErrorAction Stop
      $closedNormally = $true
    }
  } catch {
    $probeError = $_.Exception.Message
  } finally {
    try {
      $crashEvents = @(Get-LilyCrashEvents -StartTime $startedAt)
    } catch {
      $crashEventQueryError = $_.Exception.Message
    }

    $cleanupStartTicks = @{}
    try {
      foreach ($knownIdText in @($ownedStartTicks.Keys)) {
        $knownId = [int]$knownIdText
        $knownProcess = Get-Process -Id $knownId -ErrorAction SilentlyContinue
        if ($null -eq $knownProcess) {
          continue
        }
        $knownCurrentStartTicks = Get-ProcessStartTicks -Process $knownProcess
        if ($null -eq $knownCurrentStartTicks -or
            [long]$knownCurrentStartTicks -ne [long]$ownedStartTicks[$knownIdText]) {
          continue
        }

        foreach ($cleanupId in @(Get-ProcessTreeIds -RootId $knownId)) {
          $cleanupProcess = Get-Process -Id $cleanupId -ErrorAction SilentlyContinue
          if ($null -eq $cleanupProcess) {
            continue
          }
          $cleanupTicks = Get-ProcessStartTicks -Process $cleanupProcess
          if ($null -eq $cleanupTicks -or
              $null -eq $rootStartTicks -or
              [long]$cleanupTicks -lt [long]$rootStartTicks) {
            continue
          }
          $cleanupStartTicks[[string]$cleanupId] = [long]$cleanupTicks
        }
      }

      foreach ($cleanupIdText in @($cleanupStartTicks.Keys | Sort-Object { [int]$_ } -Descending)) {
        $cleanupId = [int]$cleanupIdText
        $cleanupProcess = Get-Process -Id $cleanupId -ErrorAction SilentlyContinue
        if ($null -eq $cleanupProcess) {
          continue
        }
        $cleanupTicks = Get-ProcessStartTicks -Process $cleanupProcess
        if ($null -ne $cleanupTicks -and
            [long]$cleanupTicks -eq [long]$cleanupStartTicks[$cleanupIdText]) {
          Stop-Process -Id $cleanupId -Force -ErrorAction SilentlyContinue
        }
      }

      $cleanupStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
      while ($true) {
        $remainingOwnedProcessIds = @()
        foreach ($cleanupIdText in @($cleanupStartTicks.Keys)) {
          $cleanupId = [int]$cleanupIdText
          $cleanupProcess = Get-Process -Id $cleanupId -ErrorAction SilentlyContinue
          if ($null -eq $cleanupProcess) {
            continue
          }

          $cleanupTicks = Get-ProcessStartTicks -Process $cleanupProcess
          if ($null -eq $cleanupTicks -or
              [long]$cleanupTicks -eq [long]$cleanupStartTicks[$cleanupIdText]) {
            $remainingOwnedProcessIds += $cleanupId
          }
        }

        if ($remainingOwnedProcessIds.Count -eq 0) {
          break
        }
        if ($cleanupStopwatch.Elapsed.TotalSeconds -lt 5) {
          Start-Sleep -Milliseconds 100
          continue
        }
        break
      }
      $cleanupStopwatch.Stop()

      if ($remainingOwnedProcessIds.Count -gt 0) {
        $cleanupError = "Owned Lily Workbench processes remained after forced cleanup."
      }
    } catch {
      $cleanupError = $_.Exception.Message
      $remainingOwnedProcessIds = @()
      foreach ($cleanupIdText in @($cleanupStartTicks.Keys)) {
        $cleanupId = [int]$cleanupIdText
        $cleanupProcess = Get-Process -Id $cleanupId -ErrorAction SilentlyContinue
        if ($null -eq $cleanupProcess) {
          continue
        }
        $cleanupTicks = Get-ProcessStartTicks -Process $cleanupProcess
        if ($null -ne $cleanupTicks -and
            [long]$cleanupTicks -eq [long]$cleanupStartTicks[$cleanupIdText]) {
          $remainingOwnedProcessIds += $cleanupId
        }
      }
    }
  }

  return [pscustomobject][ordered]@{
    processId = $rootId
    remainedAlive = $remainedAlive
    exitedUnexpectedly = $exitedUnexpectedly
    visibleWindow = $rendererProbe.visibleWindow
    rendererTarget = $rendererProbe.target
    closedNormally = $closedNormally
    crashEvents = @($crashEvents)
    crashEventQueryError = $crashEventQueryError
    chromiumLog = $chromiumLog
    startupEventLog = $startupEventLog
    debuggingPort = $port
    probeError = $probeError
    cleanupError = $cleanupError
    remainingOwnedProcessIds = @($remainingOwnedProcessIds)
  }
}

function Invoke-MonitoredProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $rootProcess = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru
  $rootId = [int]$rootProcess.Id
  $rootStartTicks = Get-ProcessStartTicks -Process $rootProcess
  if ($null -eq $rootStartTicks) {
    throw ("Unable to read the start time for {0} process {1}." -f $Label, $rootId)
  }

  $knownStartTicks = @{}
  $knownStartTicks[[string]$rootId] = $rootStartTicks
  $previousAnchorIds = @($rootId)
  $lastActiveIds = @($rootId)
  $visibleWindows = [ordered]@{}
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $rootExited = $false
  $rootExitCode = $null
  $timedOut = $false

  while ($true) {
    $candidateIds = New-Object "System.Collections.Generic.HashSet[int]"
    foreach ($knownId in @($knownStartTicks.Keys)) {
      $candidateIds.Add([int]$knownId) | Out-Null
    }
    foreach ($anchorId in $previousAnchorIds) {
      foreach ($treeId in @(Get-ProcessTreeIds -RootId $anchorId)) {
        $candidateIds.Add([int]$treeId) | Out-Null
      }
    }

    $activeProcesses = New-Object System.Collections.Generic.List[object]
    foreach ($candidateId in @($candidateIds)) {
      $candidateProcess = Get-Process -Id $candidateId -ErrorAction SilentlyContinue
      if ($null -eq $candidateProcess) {
        continue
      }

      $currentStartTicks = Get-ProcessStartTicks -Process $candidateProcess
      if ($null -eq $currentStartTicks) {
        continue
      }

      $candidateKey = [string]$candidateId
      if ($knownStartTicks.ContainsKey($candidateKey)) {
        if ([long]$knownStartTicks[$candidateKey] -ne [long]$currentStartTicks) {
          continue
        }
      } else {
        if ([long]$currentStartTicks -lt [long]$rootStartTicks) {
          continue
        }
        $knownStartTicks[$candidateKey] = [long]$currentStartTicks
      }

      $activeProcesses.Add($candidateProcess) | Out-Null
      try {
        $mainWindowHandle = [long]$candidateProcess.MainWindowHandle
        if ($mainWindowHandle -eq 0) {
          continue
        }

        $windowKey = "{0}:{1}" -f $candidateProcess.Id, $mainWindowHandle
        if (-not $visibleWindows.Contains($windowKey)) {
          $visibleWindows[$windowKey] = [pscustomobject][ordered]@{
            processId = [int]$candidateProcess.Id
            processName = [string]$candidateProcess.ProcessName
            windowTitle = [string]$candidateProcess.MainWindowTitle
            label = $Label
          }
        }
      } catch {
        # The process can exit between enumeration and window inspection.
      }
    }
    $lastActiveIds = @($activeProcesses | ForEach-Object { [int]$_.Id })
    $previousAnchorIds = $lastActiveIds

    if (-not $rootExited) {
      try {
        if ($rootProcess.WaitForExit(0)) {
          $rootExitCode = [int]$rootProcess.ExitCode
          $rootExited = $true
        }
      } catch {
        $rootExited = $true
      }
    }

    if ($rootExited -and $lastActiveIds.Count -eq 0) {
      break
    }

    if ($stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
      $timedOut = $true
      break
    }

    Start-Sleep -Milliseconds 150
  }

  $stopwatch.Stop()

  if ($timedOut) {
    $processIdsToStop = New-Object "System.Collections.Generic.HashSet[int]"
    foreach ($activeId in $lastActiveIds) {
      $activeProcess = Get-Process -Id $activeId -ErrorAction SilentlyContinue
      if ($null -eq $activeProcess) {
        continue
      }

      $currentStartTicks = Get-ProcessStartTicks -Process $activeProcess
      if ($null -eq $currentStartTicks -or
          [long]$knownStartTicks[[string]$activeId] -ne [long]$currentStartTicks) {
        continue
      }

      foreach ($descendantId in @(Get-ProcessTreeIds -RootId $activeId)) {
        $processIdsToStop.Add([int]$descendantId) | Out-Null
      }
    }

    foreach ($processIdToStop in @($processIdsToStop | Sort-Object -Descending)) {
      Stop-Process -Id $processIdToStop -Force -ErrorAction SilentlyContinue
    }
  }

  $visibleWindowRecords = @($visibleWindows.GetEnumerator() | ForEach-Object { $_.Value })
  return [pscustomobject][ordered]@{
    processId = $rootId
    exitCode = $rootExitCode
    timedOut = $timedOut
    visibleWindows = $visibleWindowRecords
  }
}

function Test-PortableExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath
  )

  $stream = $null
  try {
    $stream = [System.IO.File]::Open(
      $LiteralPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    if ($stream.Length -lt 2) {
      return $false
    }

    $firstByte = $stream.ReadByte()
    $secondByte = $stream.ReadByte()
    return ($firstByte -eq 0x4D -and $secondByte -eq 0x5A)
  } finally {
    if ($null -ne $stream) {
      $stream.Dispose()
    }
  }
}

function Get-SignatureRecord {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath
  )

  $signature = Get-AuthenticodeSignature -LiteralPath $LiteralPath
  $signerSubject = ""
  $thumbprint = ""
  if ($null -ne $signature.SignerCertificate) {
    $signerSubject = [string]$signature.SignerCertificate.Subject
    $thumbprint = [string]$signature.SignerCertificate.Thumbprint
  }

  return [pscustomobject][ordered]@{
    path = [System.IO.Path]::GetFullPath($LiteralPath)
    status = [string]$signature.Status
    statusMessage = [string]$signature.StatusMessage
    signerSubject = $signerSubject
    thumbprint = $thumbprint
  }
}

function Get-PeSignatureInventory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Directory
  )

  $inventory = New-Object System.Collections.Generic.List[object]
  foreach ($file in @(Get-ChildItem -LiteralPath $Directory -Recurse -File -ErrorAction Stop | Sort-Object FullName)) {
    if (Test-PortableExecutable -LiteralPath $file.FullName) {
      $inventory.Add((Get-SignatureRecord -LiteralPath $file.FullName)) | Out-Null
    }
  }

  return @($inventory)
}

function Resolve-InstallDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Entry
  )

  $installLocation = ([string]$Entry.InstallLocation).Trim().Trim('"')
  if (-not [string]::IsNullOrWhiteSpace($installLocation) -and
      (Test-Path -LiteralPath $installLocation -PathType Container)) {
    return (Resolve-Path -LiteralPath $installLocation -ErrorAction Stop).ProviderPath
  }

  $displayIcon = ([string]$Entry.DisplayIcon).Trim()
  if (-not [string]::IsNullOrWhiteSpace($displayIcon)) {
    $iconPath = ($displayIcon -replace '\s*,\s*-?\d+\s*$', '').Trim().Trim('"')
    $iconDirectory = [System.IO.Path]::GetDirectoryName($iconPath)
    if (-not [string]::IsNullOrWhiteSpace($iconDirectory) -and
        (Test-Path -LiteralPath $iconDirectory -PathType Container)) {
      return (Resolve-Path -LiteralPath $iconDirectory -ErrorAction Stop).ProviderPath
    }
  }

  throw "Unable to resolve the Lily Workbench installation directory from ARP metadata."
}

function Get-LilyShortcuts {
  $locations = @(
    [pscustomobject]@{ scope = "Desktop"; path = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop) }
    [pscustomobject]@{ scope = "CommonDesktop"; path = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory) }
    [pscustomobject]@{ scope = "StartMenu"; path = [Environment]::GetFolderPath([Environment+SpecialFolder]::StartMenu) }
    [pscustomobject]@{ scope = "CommonStartMenu"; path = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonStartMenu) }
  )

  $shortcutsByPath = @{}
  foreach ($location in $locations) {
    if ([string]::IsNullOrWhiteSpace([string]$location.path) -or
        -not (Test-Path -LiteralPath $location.path -PathType Container)) {
      continue
    }

    foreach ($shortcut in @(Get-ChildItem -LiteralPath $location.path -Filter "*.lnk" -Recurse -File -ErrorAction SilentlyContinue)) {
      if ($shortcut.BaseName -ne "Lily Workbench" -and $shortcut.BaseName -ne "智能工作台") {
        continue
      }

      if (-not $shortcutsByPath.ContainsKey($shortcut.FullName)) {
        $shortcutsByPath[$shortcut.FullName] = [pscustomobject][ordered]@{
          path = [string]$shortcut.FullName
          scope = [string]$location.scope
        }
      }
    }
  }

  return @($shortcutsByPath.Values | Sort-Object path)
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
    $summaryLines.Add(("- {0}: {1}" -f ([string]$check.status).ToUpperInvariant(), $check.id)) | Out-Null
    if (-not [string]::IsNullOrWhiteSpace([string]$check.detail)) {
      $summaryLines.Add(("  " + $check.detail)) | Out-Null
    }
    if ($null -ne $check.evidence) {
      $evidenceText = ConvertTo-Json -InputObject $check.evidence -Depth 4 -Compress
      $summaryLines.Add(("  Evidence: " + $evidenceText)) | Out-Null
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

  Require-Check `
    -Id "preflight.windows" `
    -Condition ($env:OS -eq "Windows_NT") `
    -PassDetail "The runner is executing on Windows." `
    -FailDetail "This readiness runner must execute on Windows; lifecycle commands were not started."

  $resolvedInstaller = (Resolve-Path -LiteralPath $Installer -ErrorAction Stop).ProviderPath
  $isExeInstaller = [string]::Equals(
    [System.IO.Path]::GetExtension($resolvedInstaller),
    ".exe",
    [System.StringComparison]::OrdinalIgnoreCase
  )
  Require-Check `
    -Id "preflight.installer_exe" `
    -Condition $isExeInstaller `
    -PassDetail ("Resolved EXE installer: " + $resolvedInstaller) `
    -FailDetail ("The installer must resolve to an .exe file: " + $resolvedInstaller) `
    -Evidence $resolvedInstaller

  $script:Report.installer["path"] = $resolvedInstaller

  $registryBefore = @(Get-LilyUninstallEntries)
  $registryBeforePath = Write-JsonEvidence -FileName "registry-before.json" -Value @($registryBefore)
  Require-Check `
    -Id "preflight.clean_registry" `
    -Condition ($registryBefore.Count -eq 0) `
    -PassDetail "No existing Lily Workbench ARP entry was found." `
    -FailDetail ("Expected a clean VM, but found {0} existing Lily Workbench ARP entry or entries." -f $registryBefore.Count) `
    -Evidence $registryBeforePath

  $runningLilyProcesses = @(Get-LilyProcesses)
  $runningProcessEvidence = @($runningLilyProcesses | ForEach-Object {
    [pscustomobject][ordered]@{
      processId = [int]$_.Id
      processName = [string]$_.ProcessName
    }
  })
  Require-Check `
    -Id "preflight.no_running_lily" `
    -Condition ($runningLilyProcesses.Count -eq 0) `
    -PassDetail "No Lily Workbench process was running before installation." `
    -FailDetail ("Expected no Lily Workbench process before installation, but found {0}." -f $runningLilyProcesses.Count) `
    -Evidence $runningProcessEvidence

  $installerFile = Get-Item -LiteralPath $resolvedInstaller -ErrorAction Stop
  $installerHash = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash
  $installerSignature = Get-SignatureRecord -LiteralPath $resolvedInstaller
  $script:Report.installer["sizeBytes"] = [long]$installerFile.Length
  $script:Report.installer["sha256"] = [string]$installerHash
  $script:Report.installer["signature"] = $installerSignature

  $windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $windowsPrincipal = New-Object Security.Principal.WindowsPrincipal($windowsIdentity)
  $isAdministrator = $windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $privilegeLevel = if ($isAdministrator) { "administrator" } else { "standard_user" }
  $script:Report.machine["identityName"] = [string]$windowsIdentity.Name
  $script:Report.machine["isAdministrator"] = [bool]$isAdministrator
  $script:Report.machine["privilegeLevel"] = $privilegeLevel

  $privilegeEvidence = [pscustomobject][ordered]@{
    identityName = [string]$windowsIdentity.Name
    privilegeLevel = $privilegeLevel
    isAdministrator = [bool]$isAdministrator
  }
  if ($isAdministrator) {
    Add-Check `
      -Id "environment.standard_user" `
      -Status "warning" `
      -Detail "The runner is elevated. This rehearsal still requires a separate standard-user VM run." `
      -Evidence $privilegeEvidence | Out-Null
  } else {
    Add-Check `
      -Id "environment.standard_user" `
      -Status "pass" `
      -Detail "The runner is executing with a standard-user token." `
      -Evidence $privilegeEvidence | Out-Null
  }

  $installerSignatureIsValid = [string]::Equals(
    [string]$installerSignature.status,
    "Valid",
    [System.StringComparison]::Ordinal
  )
  if ($RequireSignature) {
    Require-Check `
      -Id "installer.signature" `
      -Condition $installerSignatureIsValid `
      -PassDetail "The installer Authenticode signature is valid." `
      -FailDetail ("The installer Authenticode signature is not valid: " + $installerSignature.status) `
      -Evidence $installerSignature
  } elseif ($installerSignatureIsValid) {
    Add-Check `
      -Id "installer.signature" `
      -Status "pass" `
      -Detail "The installer Authenticode signature is valid in rehearsal mode." `
      -Evidence $installerSignature | Out-Null
  } else {
    Add-Check `
      -Id "installer.signature" `
      -Status "warning" `
      -Detail ("The installer signature is not valid in rehearsal mode: " + $installerSignature.status) `
      -Evidence $installerSignature | Out-Null
  }

  if (-not [string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    $signerContainsExpectedPublisher = ([string]$installerSignature.signerSubject).IndexOf(
      $ExpectedPublisher,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -ge 0
    Require-Check `
      -Id "installer.publisher" `
      -Condition $signerContainsExpectedPublisher `
      -PassDetail ("The installer signer subject contains the expected publisher: " + $ExpectedPublisher) `
      -FailDetail ("The installer signer subject does not contain the expected publisher: " + $ExpectedPublisher) `
      -Evidence $installerSignature
  }

  $installArguments = @("/S", "/currentuser")
  $installResult = Invoke-MonitoredProcess `
    -FilePath $resolvedInstaller `
    -ArgumentList $installArguments `
    -TimeoutSeconds $InstallTimeoutSeconds `
    -Label "installer"

  $visibleInstallerWindows = @($installResult.visibleWindows)
  $silentInstallPassed = (
    -not $installResult.timedOut -and
    $null -ne $installResult.exitCode -and
    [int]$installResult.exitCode -eq 0 -and
    $visibleInstallerWindows.Count -eq 0
  )
  Require-Check `
    -Id "install.silent" `
    -Condition $silentInstallPassed `
    -PassDetail "The installer completed in time with exit code 0 and no visible root or descendant windows." `
    -FailDetail ("Silent install failed: timedOut={0}, exitCode={1}, visibleWindows={2}." -f $installResult.timedOut, $installResult.exitCode, $visibleInstallerWindows.Count) `
    -Evidence $installResult

  $registryInstalled = @(Get-LilyUninstallEntries)
  $registryInstalledPath = Write-JsonEvidence -FileName "registry-installed.json" -Value @($registryInstalled)
  Require-Check `
    -Id "registry.installed_entry_count" `
    -Condition ($registryInstalled.Count -eq 1) `
    -PassDetail "Exactly one Lily Workbench ARP entry was found after installation." `
    -FailDetail ("Expected exactly one Lily Workbench ARP entry after installation; found {0}." -f $registryInstalled.Count) `
    -Evidence $registryInstalledPath

  $script:InstalledEntry = $registryInstalled[0]
  $requiredRegistryFields = @(
    "DisplayName"
    "Publisher"
    "DisplayVersion"
    "InstallLocation"
    "UninstallString"
    "QuietUninstallString"
  )
  $missingRegistryFields = @($requiredRegistryFields | Where-Object {
    [string]::IsNullOrWhiteSpace((Get-ObjectPropertyValue -InputObject $script:InstalledEntry -Name $_))
  })
  Require-Check `
    -Id "registry.metadata" `
    -Condition ($missingRegistryFields.Count -eq 0) `
    -PassDetail "DisplayName, Publisher, DisplayVersion, InstallLocation, UninstallString, and QuietUninstallString are populated." `
    -FailDetail ("Required ARP metadata is empty: " + ($missingRegistryFields -join ", ")) `
    -Evidence $script:InstalledEntry

  if (-not [string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    $arpPublisherMatches = ([string]$script:InstalledEntry.Publisher).IndexOf(
      $ExpectedPublisher,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -ge 0
    Require-Check `
      -Id "registry.publisher" `
      -Condition $arpPublisherMatches `
      -PassDetail ("The ARP publisher contains the expected publisher: " + $ExpectedPublisher) `
      -FailDetail ("The ARP publisher does not contain the expected publisher: " + $ExpectedPublisher) `
      -Evidence $script:InstalledEntry
  }

  if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    $arpVersionMatches = [string]::Equals(
      [string]$script:InstalledEntry.DisplayVersion,
      $ExpectedVersion,
      [System.StringComparison]::Ordinal
    )
    Require-Check `
      -Id "registry.version" `
      -Condition $arpVersionMatches `
      -PassDetail ("The ARP display version exactly matches " + $ExpectedVersion) `
      -FailDetail ("The ARP display version does not exactly match " + $ExpectedVersion) `
      -Evidence $script:InstalledEntry
  }

  $installDirectory = Resolve-InstallDirectory -Entry $script:InstalledEntry
  $applicationPath = Join-Path $installDirectory "LilyWorkbench.exe"
  $script:Report["installation"] = [ordered]@{
    directory = $installDirectory
    applicationPath = $applicationPath
  }
  Require-Check `
    -Id "installation.application" `
    -Condition (Test-Path -LiteralPath $applicationPath -PathType Leaf) `
    -PassDetail ("Found the installed application executable: " + $applicationPath) `
    -FailDetail ("The installed application executable is missing: " + $applicationPath) `
    -Evidence $applicationPath

  $lilyShortcuts = @(Get-LilyShortcuts)
  $hasDesktopShortcut = @($lilyShortcuts | Where-Object {
    $_.scope -eq "Desktop" -or $_.scope -eq "CommonDesktop"
  }).Count -gt 0
  $hasStartMenuShortcut = @($lilyShortcuts | Where-Object {
    $_.scope -eq "StartMenu" -or $_.scope -eq "CommonStartMenu"
  }).Count -gt 0
  Require-Check `
    -Id "shortcuts.desktop_and_start_menu" `
    -Condition ($lilyShortcuts.Count -ge 2 -and $hasDesktopShortcut -and $hasStartMenuShortcut) `
    -PassDetail ("Found {0} unique Lily Workbench shortcuts across the desktop and Start menu." -f $lilyShortcuts.Count) `
    -FailDetail ("Expected at least two unique Lily Workbench shortcuts spanning the desktop and Start menu; found {0}." -f $lilyShortcuts.Count) `
    -Evidence $lilyShortcuts

  $signatureInventory = @(Get-PeSignatureInventory -Directory $installDirectory)
  $signatureInventoryPath = Write-JsonEvidence -FileName "signature-inventory.json" -Value @($signatureInventory)
  Require-Check `
    -Id "installation.pe_inventory" `
    -Condition ($signatureInventory.Count -gt 0) `
    -PassDetail ("Collected Authenticode evidence for {0} installed PE file or files." -f $signatureInventory.Count) `
    -FailDetail "No MZ portable executable was found in the installation directory." `
    -Evidence $signatureInventoryPath

  $invalidInstalledSignatures = @($signatureInventory | Where-Object {
    -not [string]::Equals([string]$_.status, "Valid", [System.StringComparison]::Ordinal)
  })
  if ($RequireSignature) {
    Require-Check `
      -Id "installation.signatures" `
      -Condition ($invalidInstalledSignatures.Count -eq 0) `
      -PassDetail "Every installed MZ portable executable has a valid Authenticode signature." `
      -FailDetail ("Found {0} installed MZ portable executable or executables without a valid Authenticode signature." -f $invalidInstalledSignatures.Count) `
      -Evidence $signatureInventoryPath
  } elseif ($invalidInstalledSignatures.Count -eq 0) {
    Add-Check `
      -Id "installation.signatures" `
      -Status "pass" `
      -Detail "Every installed MZ portable executable has a valid Authenticode signature in rehearsal mode." `
      -Evidence $signatureInventoryPath | Out-Null
  } else {
    Add-Check `
      -Id "installation.signatures" `
      -Status "warning" `
      -Detail ("Rehearsal mode found {0} installed MZ portable executable or executables without a valid Authenticode signature." -f $invalidInstalledSignatures.Count) `
      -Evidence $signatureInventoryPath | Out-Null
  }

  $launchResult = Invoke-LilyLaunchProbe `
    -MainExe $applicationPath `
    -TimeoutSeconds $LaunchTimeoutSeconds
  $script:Report["launch"] = $launchResult
  $launchCrashEvents = @($launchResult.crashEvents)
  $launchCrashEventQuerySucceeded = [string]::IsNullOrWhiteSpace(
    [string]$launchResult.crashEventQueryError
  )
  $launchRemainingOwnedProcessIds = @($launchResult.remainingOwnedProcessIds)

  Require-Check `
    -Id "launch.probe" `
    -Condition ([string]::IsNullOrWhiteSpace([string]$launchResult.probeError)) `
    -PassDetail "The Lily Workbench launch probe completed without an internal error." `
    -FailDetail ("The Lily Workbench launch probe failed: " + [string]$launchResult.probeError) `
    -Evidence $launchResult

  Require-Check `
    -Id "launch.cleanup" `
    -Condition (
      [string]::IsNullOrWhiteSpace([string]$launchResult.cleanupError) -and
      $launchRemainingOwnedProcessIds.Count -eq 0
    ) `
    -PassDetail "No process instance owned by the launch probe remained after cleanup." `
    -FailDetail ("Launch cleanup failed: error={0}, remainingProcessIds={1}." -f $launchResult.cleanupError, ($launchRemainingOwnedProcessIds -join ",")) `
    -Evidence $launchResult

  Require-Check `
    -Id "launch.visible_window" `
    -Condition ($null -ne $launchResult.visibleWindow) `
    -PassDetail "Lily Workbench opened a visible root or descendant window." `
    -FailDetail "Lily Workbench did not open a visible window during the bounded launch probe." `
    -Evidence $launchResult

  Require-Check `
    -Id "launch.renderer_ready" `
    -Condition ($null -ne $launchResult.rendererTarget) `
    -PassDetail "Chromium exposed the packaged Lily renderer page on the loopback debugging endpoint." `
    -FailDetail "The launch probe did not find the packaged Lily renderer page on the loopback debugging endpoint." `
    -Evidence $launchResult

  Require-Check `
    -Id "launch.chromium_log" `
    -Condition (Test-Path -LiteralPath $launchResult.chromiumLog -PathType Leaf) `
    -PassDetail "Chromium produced its requested startup log evidence file." `
    -FailDetail ("Chromium did not produce its requested startup log evidence file: " + $launchResult.chromiumLog) `
    -Evidence $launchResult

  Require-Check `
    -Id "launch.no_crash_event" `
    -Condition ($launchCrashEventQuerySucceeded -and $launchCrashEvents.Count -eq 0) `
    -PassDetail "No Lily Workbench crash event was recorded in the Windows Application log." `
    -FailDetail ("The Windows Application log crash check failed: querySucceeded={0}, crashEvents={1}." -f $launchCrashEventQuerySucceeded, $launchCrashEvents.Count) `
    -Evidence $launchResult

  Require-Check `
    -Id "launch.normal_close" `
    -Condition ([bool]$launchResult.closedNormally) `
    -PassDetail "Lily Workbench accepted CloseMainWindow and exited within 15 seconds." `
    -FailDetail "Lily Workbench did not complete a normal CloseMainWindow shutdown within 15 seconds." `
    -Evidence $launchResult
} catch {
  Add-Check `
    -Id "runner.exception" `
    -Status "fail" `
    -Detail $_.Exception.Message `
    -Evidence ([pscustomobject][ordered]@{
      exceptionType = $_.Exception.GetType().FullName
      scriptStackTrace = $_.ScriptStackTrace
    }) | Out-Null
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
