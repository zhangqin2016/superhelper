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
$script:InstallDirectory = ""
$script:InstallAttemptStarted = $false
$script:UserDataResidueRecorded = $false
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
    "user-data-residue.json"
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

function Initialize-NativeCommandLine {
  if ($null -eq ("Lily.NativeCommandLine.CommandLineParser" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Lily.NativeCommandLine
{
    public static class CommandLineParser
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr memory);

        public static string[] Split(string commandLine)
        {
            if (commandLine == null)
            {
                throw new ArgumentNullException("commandLine");
            }

            int argumentCount;
            IntPtr argumentsPointer = CommandLineToArgvW(commandLine, out argumentCount);
            if (argumentsPointer == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            try
            {
                string[] arguments = new string[argumentCount];
                for (int index = 0; index < argumentCount; index++)
                {
                    IntPtr argumentPointer = Marshal.ReadIntPtr(argumentsPointer, index * IntPtr.Size);
                    arguments[index] = Marshal.PtrToStringUni(argumentPointer);
                }
                return arguments;
            }
            finally
            {
                LocalFree(argumentsPointer);
            }
        }
    }

    public sealed class VisibleWindowInfo
    {
        public int ProcessId { get; set; }
        public long WindowHandle { get; set; }
        public string WindowTitle { get; set; }
    }

    public static class WindowEnumerator
    {
        private delegate bool EnumWindowsCallback(IntPtr windowHandle, IntPtr state);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr state);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr windowHandle);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowTextLength(IntPtr windowHandle);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int GetWindowText(IntPtr windowHandle, StringBuilder text, int maximumCount);

        public static VisibleWindowInfo[] GetVisibleWindows(int[] processIds)
        {
            if (processIds == null)
            {
                throw new ArgumentNullException("processIds");
            }

            HashSet<uint> requestedProcessIds = new HashSet<uint>();
            foreach (int processId in processIds)
            {
                if (processId > 0)
                {
                    requestedProcessIds.Add((uint)processId);
                }
            }

            List<VisibleWindowInfo> windows = new List<VisibleWindowInfo>();
            Exception callbackException = null;
            EnumWindowsCallback callback = delegate(IntPtr windowHandle, IntPtr state)
            {
                try
                {
                    if (!IsWindowVisible(windowHandle))
                    {
                        return true;
                    }

                    uint processId;
                    GetWindowThreadProcessId(windowHandle, out processId);
                    if (!requestedProcessIds.Contains(processId))
                    {
                        return true;
                    }

                    int titleLength = GetWindowTextLength(windowHandle);
                    StringBuilder title = new StringBuilder(titleLength + 1);
                    if (titleLength > 0)
                    {
                        GetWindowText(windowHandle, title, title.Capacity);
                    }

                    windows.Add(new VisibleWindowInfo
                    {
                        ProcessId = (int)processId,
                        WindowHandle = windowHandle.ToInt64(),
                        WindowTitle = title.ToString()
                    });
                    return true;
                }
                catch (Exception exception)
                {
                    callbackException = exception;
                    return false;
                }
            };

            bool completed = EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            if (callbackException != null)
            {
                throw new InvalidOperationException("Visible-window enumeration failed.", callbackException);
            }
            if (!completed)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            return windows.ToArray();
        }
    }
}
'@
  }
}

function Get-VisibleTopLevelWindows {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [int[]]$ProcessIds,

    [string]$Label = ""
  )

  $uniqueProcessIds = @($ProcessIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  if ($uniqueProcessIds.Count -eq 0) {
    return @()
  }

  return @([Lily.NativeCommandLine.WindowEnumerator]::GetVisibleWindows(
    [int[]]$uniqueProcessIds
  ) | ForEach-Object {
    [pscustomobject][ordered]@{
      processId = [int]$_.ProcessId
      windowHandle = [long]$_.WindowHandle
      windowTitle = [string]$_.WindowTitle
      label = $Label
    }
  })
}

function Test-LilyPackagedRendererUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  $rendererUri = $null
  if (-not [System.Uri]::TryCreate(
    $Url,
    [System.UriKind]::Absolute,
    [ref]$rendererUri
  )) {
    return $false
  }
  if (-not [string]::Equals(
    $rendererUri.Scheme,
    "file",
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    return $false
  }
  if (-not [string]::IsNullOrEmpty($rendererUri.Query) -or
      -not [string]::IsNullOrEmpty($rendererUri.Fragment)) {
    return $false
  }

  try {
    $normalizedPath = [System.Uri]::UnescapeDataString($rendererUri.AbsolutePath).Replace("\", "/")
  } catch {
    return $false
  }
  return $normalizedPath -match '(?i)/resources/app\.asar/src/renderer/index\.html$'
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

function Get-LilyLegacyUninstallEntries {
  $legacyKeyName = "com.company.ai-super-terminal"
  $registryRoots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )

  foreach ($registryRoot in $registryRoots) {
    $registryPath = Join-Path $registryRoot $legacyKeyName
    if (-not (Test-Path -LiteralPath $registryPath)) {
      continue
    }

    $properties = Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop
    [pscustomobject][ordered]@{
      RegistryPath = $registryPath
      DisplayName = Get-ObjectPropertyValue -InputObject $properties -Name "DisplayName"
      DisplayVersion = Get-ObjectPropertyValue -InputObject $properties -Name "DisplayVersion"
      InstallLocation = Get-ObjectPropertyValue -InputObject $properties -Name "InstallLocation"
      UninstallString = Get-ObjectPropertyValue -InputObject $properties -Name "UninstallString"
      QuietUninstallString = Get-ObjectPropertyValue -InputObject $properties -Name "QuietUninstallString"
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
        visibleWindow = $visibleWindow
        rootExited = $true
        processIds = @($lastProcessIds)
      }
    }

    $lastProcessIds = @(Get-ProcessTreeIds -RootId $ProcessId)
    $visibleTopLevelWindows = @(
      Get-VisibleTopLevelWindows -ProcessIds $lastProcessIds -Label "application"
    )
    if ($null -eq $visibleWindow -and $visibleTopLevelWindows.Count -gt 0) {
      $visibleWindow = $visibleTopLevelWindows[0]
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
        (Test-LilyPackagedRendererUrl -Url $targetUrl)
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

function Add-OwnedDescendantProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [int[]]$AnchorIds,

    [Parameter(Mandatory = $true)]
    [hashtable]$DepthById,

    [Parameter(Mandatory = $true)]
    [hashtable]$OwnedStartTicks,

    [Parameter(Mandatory = $true)]
    [System.Collections.Generic.HashSet[string]]$Errors,

    [AllowNull()]
    [object]$MinimumStartTicks = $null
  )

  $discoveryIds = New-Object "System.Collections.Generic.HashSet[int]"
  foreach ($anchorId in $AnchorIds) {
    if ($anchorId -gt 0) {
      $discoveryIds.Add([int]$anchorId) | Out-Null
    }
  }
  foreach ($ownedIdText in @($OwnedStartTicks.Keys)) {
    $discoveryIds.Add([int]$ownedIdText) | Out-Null
  }

  try {
    $processSnapshot = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    $Errors.Add("Unable to enumerate owned-process descendants: " + $_.Exception.Message) | Out-Null
    return
  }

  $snapshotById = @{}
  foreach ($processRecord in $processSnapshot) {
    $snapshotById[[string][int]$processRecord.ProcessId] = $processRecord
  }

  $foundDescendant = $true
  while ($foundDescendant) {
    $foundDescendant = $false
    foreach ($processRecord in $processSnapshot) {
      $processId = [int]$processRecord.ProcessId
      $processKey = [string]$processId
      $parentProcessId = [int]$processRecord.ParentProcessId
      if ($OwnedStartTicks.ContainsKey($processKey) -or
          -not $discoveryIds.Contains($parentProcessId)) {
        continue
      }

      try {
        $process = [System.Diagnostics.Process]::GetProcessById($processId)
        $processStartTicks = Get-ProcessStartTicks -Process $process
        if ($null -eq $processStartTicks) {
          $Errors.Add("Unable to verify start time for descendant process " + $processId + ".") | Out-Null
          continue
        }
        if ($null -ne $MinimumStartTicks -and
            [long]$processStartTicks -lt [long]$MinimumStartTicks) {
          continue
        }

        $OwnedStartTicks[$processKey] = [long]$processStartTicks
        $discoveryIds.Add($processId) | Out-Null
        $foundDescendant = $true
      } catch [System.ArgumentException] {
        # The descendant exited between the CIM snapshot and identity verification.
      } catch {
        $Errors.Add("Unable to verify descendant process " + $processId + ": " + $_.Exception.Message) | Out-Null
      }
    }
  }

  $resolvedDepthById = @{}
  foreach ($anchorId in $AnchorIds) {
    $anchorKey = [string][int]$anchorId
    if ($DepthById.ContainsKey($anchorKey)) {
      $resolvedDepthById[$anchorKey] = [int]$DepthById[$anchorKey]
    } else {
      $resolvedDepthById[$anchorKey] = 0
    }
  }
  foreach ($depthIdText in @($DepthById.Keys)) {
    if (-not $resolvedDepthById.ContainsKey($depthIdText)) {
      $resolvedDepthById[$depthIdText] = [int]$DepthById[$depthIdText]
    }
  }

  $foundDepth = $true
  while ($foundDepth) {
    $foundDepth = $false
    foreach ($ownedIdText in @($OwnedStartTicks.Keys)) {
      if ($resolvedDepthById.ContainsKey($ownedIdText)) {
        continue
      }
      $ownedRecord = $snapshotById[$ownedIdText]
      if ($null -eq $ownedRecord) {
        continue
      }
      $parentKey = [string][int]$ownedRecord.ParentProcessId
      if ($resolvedDepthById.ContainsKey($parentKey)) {
        $resolvedDepthById[$ownedIdText] = [int]$resolvedDepthById[$parentKey] + 1
        $foundDepth = $true
      }
    }
  }

  foreach ($ownedIdText in @($OwnedStartTicks.Keys)) {
    if ($resolvedDepthById.ContainsKey($ownedIdText)) {
      $DepthById[$ownedIdText] = [int]$resolvedDepthById[$ownedIdText]
    } elseif (-not $DepthById.ContainsKey($ownedIdText)) {
      $DepthById[$ownedIdText] = 0
    }
  }
}

function Stop-OwnedProcessTree {
  param(
    [AllowNull()]
    [System.Diagnostics.Process]$RootProcess = $null,

    [AllowNull()]
    [object]$RootId = $null,

    [AllowNull()]
    [object]$RootStartTicks = $null,

    [Parameter(Mandatory = $true)]
    [AllowNull()]
    [object]$MinimumOwnedStartTicks,

    [hashtable]$KnownStartTicks = @{}
  )

  $errors = New-Object "System.Collections.Generic.HashSet[string]"
  $stoppedIds = New-Object "System.Collections.Generic.HashSet[int]"
  $ownedStartTicks = @{}
  $depthById = @{}
  $effectiveMinimumStartTicks = if ($null -ne $RootStartTicks) {
    [long]$RootStartTicks
  } else {
    $MinimumOwnedStartTicks
  }

  foreach ($knownIdText in @($KnownStartTicks.Keys)) {
    if ($null -eq $RootStartTicks -and
        $null -ne $RootId -and
        [int]$knownIdText -eq [int]$RootId) {
      $errors.Add("Ignored the unverified root PID from KnownStartTicks.") | Out-Null
      continue
    }
    $ownedStartTicks[[string][int]$knownIdText] = [long]$KnownStartTicks[$knownIdText]
  }
  if ($null -ne $RootId -and $null -ne $RootStartTicks) {
    $ownedStartTicks[[string][int]$RootId] = [long]$RootStartTicks
    $depthById[[string][int]$RootId] = 0
  }

  if ($null -ne $RootProcess -and $null -eq $RootStartTicks) {
    try {
      if ($null -ne $RootId) {
        Add-OwnedDescendantProcesses `
          -AnchorIds @([int]$RootId) `
          -DepthById $depthById `
          -OwnedStartTicks $ownedStartTicks `
          -Errors $errors `
          -MinimumStartTicks $effectiveMinimumStartTicks
      } else {
        $errors.Add("Unable to capture descendants because the object-bound root PID is unavailable.") | Out-Null
      }

      if (-not $RootProcess.HasExited) {
        $RootProcess.Kill()
        if (-not $RootProcess.WaitForExit(5000)) {
          $errors.Add("The root process did not exit within five seconds after object-bound Kill().") | Out-Null
        } else {
          $stoppedIds.Add([int]$RootProcess.Id) | Out-Null
        }
      }
    } catch {
      $errors.Add("Unable to stop the root process through its original process object: " + $_.Exception.Message) | Out-Null
    }
  }

  if ($null -ne $RootId) {
    Add-OwnedDescendantProcesses `
      -AnchorIds @([int]$RootId) `
      -DepthById $depthById `
      -OwnedStartTicks $ownedStartTicks `
      -Errors $errors `
      -MinimumStartTicks $effectiveMinimumStartTicks
  }

  $stopOrder = @($ownedStartTicks.Keys | ForEach-Object {
    $ownedIdText = [string]$_
    [pscustomobject][ordered]@{
      processId = [int]$ownedIdText
      depth = if ($depthById.ContainsKey($ownedIdText)) { [int]$depthById[$ownedIdText] } else { 0 }
    }
  } | Sort-Object `
    -Property @{ Expression = { $_.depth }; Descending = $true }, `
              @{ Expression = { $_.processId }; Descending = $true })

  foreach ($ownedProcessRecord in $stopOrder) {
    $ownedProcessId = [int]$ownedProcessRecord.processId
    $ownedProcessKey = [string]$ownedProcessId
    if ($null -eq $RootStartTicks -and
        $null -ne $RootId -and
        $ownedProcessId -eq [int]$RootId) {
      continue
    }
    try {
      $ownedProcess = [System.Diagnostics.Process]::GetProcessById($ownedProcessId)
    } catch [System.ArgumentException] {
      continue
    } catch {
      $errors.Add("Unable to open owned process " + $ownedProcessId + ": " + $_.Exception.Message) | Out-Null
      continue
    }

    $currentStartTicks = Get-ProcessStartTicks -Process $ownedProcess
    if ($null -eq $currentStartTicks) {
      $errors.Add("Unable to reverify start time for owned process " + $ownedProcessId + ".") | Out-Null
      continue
    }
    if ([long]$currentStartTicks -ne [long]$ownedStartTicks[$ownedProcessKey]) {
      continue
    }

    try {
      Stop-Process -Id $ownedProcessId -Force -ErrorAction Stop
      $stoppedIds.Add($ownedProcessId) | Out-Null
    } catch {
      $errors.Add("Unable to stop owned process " + $ownedProcessId + ": " + $_.Exception.Message) | Out-Null
    }
  }

  $remainingOwnedProcessIds = @()
  $emptyFallbackScans = 0
  $cleanupStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($cleanupStopwatch.Elapsed.TotalSeconds -lt 5) {
    if ($null -eq $RootStartTicks -and $null -ne $RootId) {
      Add-OwnedDescendantProcesses `
        -AnchorIds @([int]$RootId) `
        -DepthById $depthById `
        -OwnedStartTicks $ownedStartTicks `
        -Errors $errors `
        -MinimumStartTicks $effectiveMinimumStartTicks

      $lateStopOrder = @($ownedStartTicks.Keys | ForEach-Object {
        $lateOwnedIdText = [string]$_
        [pscustomobject][ordered]@{
          processId = [int]$lateOwnedIdText
          depth = if ($depthById.ContainsKey($lateOwnedIdText)) { [int]$depthById[$lateOwnedIdText] } else { 0 }
        }
      } | Sort-Object `
        -Property @{ Expression = { $_.depth }; Descending = $true }, `
                  @{ Expression = { $_.processId }; Descending = $true })

      foreach ($lateOwnedRecord in $lateStopOrder) {
        $ownedProcessId = [int]$lateOwnedRecord.processId
        if ($ownedProcessId -eq [int]$RootId) {
          continue
        }
        $ownedProcessKey = [string]$ownedProcessId
        try {
          $ownedProcess = [System.Diagnostics.Process]::GetProcessById($ownedProcessId)
        } catch [System.ArgumentException] {
          continue
        } catch {
          $errors.Add("Unable to open late descendant process " + $ownedProcessId + ": " + $_.Exception.Message) | Out-Null
          continue
        }

        $currentStartTicks = Get-ProcessStartTicks -Process $ownedProcess
        if ($null -eq $currentStartTicks) {
          $errors.Add("Unable to reverify start time for late descendant process " + $ownedProcessId + ".") | Out-Null
          continue
        }
        if ([long]$currentStartTicks -ne [long]$ownedStartTicks[$ownedProcessKey]) {
          continue
        }

        try {
          Stop-Process -Id $ownedProcessId -Force -ErrorAction Stop
          $stoppedIds.Add($ownedProcessId) | Out-Null
        } catch {
          $errors.Add("Unable to stop late descendant process " + $ownedProcessId + ": " + $_.Exception.Message) | Out-Null
        }
      }
    }

    $remainingOwnedProcessIds = @()
    foreach ($ownedIdText in @($ownedStartTicks.Keys)) {
      $ownedProcessId = [int]$ownedIdText
      try {
        $ownedProcess = [System.Diagnostics.Process]::GetProcessById($ownedProcessId)
      } catch [System.ArgumentException] {
        continue
      } catch {
        $errors.Add("Unable to verify cleanup for owned process " + $ownedProcessId + ": " + $_.Exception.Message) | Out-Null
        $remainingOwnedProcessIds += $ownedProcessId
        continue
      }

      $currentStartTicks = Get-ProcessStartTicks -Process $ownedProcess
      if ($null -eq $currentStartTicks) {
        $errors.Add("Unable to reverify cleanup identity for owned process " + $ownedProcessId + ".") | Out-Null
        $remainingOwnedProcessIds += $ownedProcessId
      } elseif ([long]$currentStartTicks -eq [long]$ownedStartTicks[$ownedIdText]) {
        $remainingOwnedProcessIds += $ownedProcessId
      }
    }

    if ($remainingOwnedProcessIds.Count -eq 0) {
      if ($null -eq $RootStartTicks -and
          $null -ne $RootId -and
          $emptyFallbackScans -lt 1) {
        $emptyFallbackScans++
        Start-Sleep -Milliseconds 100
        continue
      }
      break
    }
    $emptyFallbackScans = 0
    Start-Sleep -Milliseconds 100
  }
  $cleanupStopwatch.Stop()

  if ($null -ne $RootProcess -and $null -eq $RootStartTicks) {
    try {
      if (-not $RootProcess.HasExited -and $null -ne $RootId) {
        $remainingOwnedProcessIds += [int]$RootId
      }
    } catch {
      $errors.Add("Unable to verify object-bound root cleanup: " + $_.Exception.Message) | Out-Null
      if ($null -ne $RootId) {
        $remainingOwnedProcessIds += [int]$RootId
      }
    }
  }

  return [pscustomobject][ordered]@{
    stoppedIds = @($stoppedIds | Sort-Object)
    remainingOwnedProcessIds = @($remainingOwnedProcessIds | Sort-Object -Unique)
    errors = @($errors | Sort-Object)
  }
}

function Invoke-MonitoredProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $rootProcess = $null
  $rootId = $null
  $rootStartTicks = $null
  $monitorStartedAtTicks = $null
  $knownStartTicks = @{}
  $previousAnchorIds = @()
  $lastActiveIds = @()
  $visibleWindows = [ordered]@{}
  $stopwatch = $null
  $rootExited = $false
  $rootExitCode = $null
  $timedOut = $false
  $timeoutCleanup = $null

  try {
    $monitorStartedAtTicks = [DateTime]::UtcNow.Ticks
    $rootProcess = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru
    $rootId = [int]$rootProcess.Id
    $rootStartTicks = Get-ProcessStartTicks -Process $rootProcess
    if ($null -eq $rootStartTicks) {
      throw [System.InvalidOperationException]::new(
        ("Unable to read the start time for {0} process {1}." -f $Label, $rootId)
      )
    }

    $knownStartTicks[[string]$rootId] = [long]$rootStartTicks
    $previousAnchorIds = @($rootId)
    $lastActiveIds = @($rootId)
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

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
        try {
          $candidateProcess = [System.Diagnostics.Process]::GetProcessById($candidateId)
        } catch [System.ArgumentException] {
          continue
        }

        $currentStartTicks = Get-ProcessStartTicks -Process $candidateProcess
        if ($null -eq $currentStartTicks) {
          throw [System.InvalidOperationException]::new(
            ("Unable to verify the start time for {0} process {1}." -f $Label, $candidateId)
          )
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
      }
      $lastActiveIds = @($activeProcesses | ForEach-Object { [int]$_.Id })
      $previousAnchorIds = $lastActiveIds
      foreach ($visibleWindow in @(
        Get-VisibleTopLevelWindows -ProcessIds $lastActiveIds -Label $Label
      )) {
        $windowKey = "{0}:{1}" -f $visibleWindow.processId, $visibleWindow.windowHandle
        if (-not $visibleWindows.Contains($windowKey)) {
          $visibleWindows[$windowKey] = $visibleWindow
        }
      }

      if (-not $rootExited) {
        if ($rootProcess.WaitForExit(0)) {
          $rootExitCode = [int]$rootProcess.ExitCode
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

    if ($timedOut) {
      $timeoutCleanup = Stop-OwnedProcessTree `
        -RootProcess $rootProcess `
        -RootId $rootId `
        -RootStartTicks $rootStartTicks `
        -MinimumOwnedStartTicks $monitorStartedAtTicks `
        -KnownStartTicks $knownStartTicks
    }

    $visibleWindowRecords = @($visibleWindows.GetEnumerator() | ForEach-Object { $_.Value })
    return [pscustomobject][ordered]@{
      processId = $rootId
      exitCode = $rootExitCode
      timedOut = $timedOut
      visibleWindows = $visibleWindowRecords
      timeoutCleanup = $timeoutCleanup
    }
  } catch {
    $originalException = $_.Exception
    try {
      $exceptionCleanup = Stop-OwnedProcessTree `
        -RootProcess $rootProcess `
        -RootId $rootId `
        -RootStartTicks $rootStartTicks `
        -MinimumOwnedStartTicks $monitorStartedAtTicks `
        -KnownStartTicks $knownStartTicks
    } catch {
      $exceptionCleanup = [pscustomobject][ordered]@{
        stoppedIds = @()
        remainingOwnedProcessIds = @()
        errors = @("Exception cleanup helper failed: " + $_.Exception.Message)
      }
    }
    $cleanupPassed = (
      @($exceptionCleanup.remainingOwnedProcessIds).Count -eq 0 -and
      @($exceptionCleanup.errors).Count -eq 0
    )
    $cleanupStatus = if ($cleanupPassed) { "pass" } else { "fail" }
    $cleanupDetail = if ($cleanupPassed) {
      "The monitor stopped every process it owned before propagating the original monitoring exception."
    } else {
      "The monitor could not fully verify exception cleanup; the original monitoring exception is still propagated."
    }
    Add-Check `
      -Id ($Label + ".monitor_exception_cleanup") `
      -Status $cleanupStatus `
      -Detail $cleanupDetail `
      -Evidence $exceptionCleanup | Out-Null
    throw $originalException
  } finally {
    if ($null -ne $stopwatch) {
      $stopwatch.Stop()
    }
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

function Normalize-PublisherName {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Value
  )

  return $Value.Trim().Normalize([System.Text.NormalizationForm]::FormKC)
}

function Get-SignatureRecord {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath
  )

  $signature = Get-AuthenticodeSignature -LiteralPath $LiteralPath
  $signerSubject = ""
  $signerSimpleName = ""
  $thumbprint = ""
  if ($null -ne $signature.SignerCertificate) {
    $signerSubject = [string]$signature.SignerCertificate.Subject
    $signerSimpleName = [string]$signature.SignerCertificate.GetNameInfo(
      [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
      $false
    )
    $thumbprint = [string]$signature.SignerCertificate.Thumbprint
  }

  return [pscustomobject][ordered]@{
    path = [System.IO.Path]::GetFullPath($LiteralPath)
    status = [string]$signature.Status
    statusMessage = [string]$signature.StatusMessage
    signerSubject = $signerSubject
    signerSimpleName = $signerSimpleName
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

function Resolve-UninstallCommand {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Entry,

    [Parameter(Mandatory = $true)]
    [string]$InstallDirectory
  )

  $quietCommand = (Get-ObjectPropertyValue `
    -InputObject $Entry `
    -Name "QuietUninstallString").Trim()
  if ([string]::IsNullOrWhiteSpace($quietCommand)) {
    throw "The Lily Workbench ARP entry does not declare QuietUninstallString."
  }

  $expandedCommand = [Environment]::ExpandEnvironmentVariables($quietCommand)
  $tokens = @([Lily.NativeCommandLine.CommandLineParser]::Split($expandedCommand))
  if ($tokens.Count -lt 1 -or [string]::IsNullOrWhiteSpace([string]$tokens[0])) {
    throw "QuietUninstallString did not contain an uninstaller executable."
  }

  $uninstallerPath = [System.IO.Path]::GetFullPath([string]$tokens[0])
  $expandedInstallDirectory = [Environment]::ExpandEnvironmentVariables($InstallDirectory)
  $installRoot = [System.IO.Path]::GetFullPath($expandedInstallDirectory)
  $trimCharacters = [char[]]@(
    [System.IO.Path]::DirectorySeparatorChar
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  $installRootWithSeparator = $installRoot.TrimEnd($trimCharacters) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $uninstallerPath.StartsWith(
      $installRootWithSeparator,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw ("QuietUninstallString points outside the installation directory: " + $uninstallerPath)
  }
  if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    throw ("The registered quiet uninstaller does not exist: " + $uninstallerPath)
  }

  $arguments = @()
  if ($tokens.Count -gt 1) {
    $arguments = @($tokens[1..($tokens.Count - 1)] | ForEach-Object { [string]$_ })
  }
  $declaresSilent = $arguments -ccontains "/S"

  return [pscustomobject][ordered]@{
    filePath = $uninstallerPath
    arguments = @($arguments)
    declaresSilent = [bool]$declaresSilent
    originalCommand = $quietCommand
    expandedCommand = $expandedCommand
  }
}

function Record-UninstallQuietContract {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Command
  )

  $existingChecks = @($script:Checks | Where-Object {
    $_.id -eq "uninstall.quiet_contract"
  })
  if ($existingChecks.Count -gt 0) {
    return
  }

  if ([bool]$Command.declaresSilent) {
    Add-Check `
      -Id "uninstall.quiet_contract" `
      -Status "pass" `
      -Detail "QuietUninstallString explicitly declares the case-sensitive uppercase /S switch." `
      -Evidence $Command | Out-Null
    return
  }

  Add-Check `
    -Id "uninstall.quiet_contract" `
    -Status "fail" `
    -Detail "QuietUninstallString does not explicitly declare the case-sensitive uppercase /S switch; /S may only be appended for safe cleanup." `
    -Evidence $Command | Out-Null
}

function Invoke-SilentUninstall {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Entry,

    [Parameter(Mandatory = $true)]
    [string]$InstallDirectory,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )

  $command = Resolve-UninstallCommand `
    -Entry $Entry `
    -InstallDirectory $InstallDirectory
  $arguments = @($command.arguments)
  if (-not $command.declaresSilent) {
    $arguments += "/S"
  }

  $processResult = Invoke-MonitoredProcess `
    -FilePath $command.filePath `
    -ArgumentList $arguments `
    -TimeoutSeconds $TimeoutSeconds `
    -Label "uninstaller"

  $removalWaitSeconds = [Math]::Min(
    30,
    [Math]::Max(5, [int][Math]::Ceiling($TimeoutSeconds / 10.0))
  )
  $removalStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $productEntryRemoved = $false
  $installDirectoryRemoved = $false
  while ($true) {
    $remainingProductEntries = @(Get-LilyUninstallEntries)
    $productEntryRemoved = $remainingProductEntries.Count -eq 0
    $installDirectoryRemoved = -not (Test-Path -LiteralPath $InstallDirectory)
    if ($productEntryRemoved -and $installDirectoryRemoved) {
      break
    }
    if ($removalStopwatch.Elapsed.TotalSeconds -ge $removalWaitSeconds) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  $removalStopwatch.Stop()

  return [pscustomobject][ordered]@{
    command = $command
    argumentsUsed = @($arguments)
    process = $processResult
    productEntryRemoved = [bool]$productEntryRemoved
    remainingProductEntries = @($remainingProductEntries)
    installDirectoryRemoved = [bool]$installDirectoryRemoved
  }
}

function Get-LilyUserDataResidues {
  $candidates = New-Object System.Collections.Generic.List[object]
  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    $candidates.Add([pscustomobject]@{
      path = Join-Path $env:APPDATA "lily-workbench"
      kind = "roaming_user_data"
    }) | Out-Null
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidates.Add([pscustomobject]@{
      path = Join-Path $env:LOCALAPPDATA "lily-workbench"
      kind = "local_user_data"
    }) | Out-Null
    $candidates.Add([pscustomobject]@{
      path = Join-Path $env:LOCALAPPDATA "lily-workbench-updater"
      kind = "updater_data"
    }) | Out-Null
  }

  $documentsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
  if (-not [string]::IsNullOrWhiteSpace($documentsDirectory)) {
    $candidates.Add([pscustomobject]@{
      path = Join-Path $documentsDirectory "Lily Workbench"
      kind = "documents"
    }) | Out-Null
    $candidates.Add([pscustomobject]@{
      path = Join-Path $documentsDirectory "Lily Apps"
      kind = "documents"
    }) | Out-Null
  }

  $seenPaths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  $residues = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in $candidates) {
    $candidatePath = [System.IO.Path]::GetFullPath([string]$candidate.path)
    if (-not $seenPaths.Add($candidatePath) -or
        -not (Test-Path -LiteralPath $candidatePath)) {
      continue
    }
    $residues.Add([pscustomobject][ordered]@{
      path = $candidatePath
      kind = [string]$candidate.kind
    }) | Out-Null
  }

  return @($residues | Sort-Object path)
}

function Get-LilyInstallResidues {
  $candidateRoots = New-Object System.Collections.Generic.List[object]
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candidateRoots.Add([pscustomobject]@{
      path = Join-Path $env:LOCALAPPDATA "Programs"
      kind = "per_user_programs"
    }) | Out-Null
  }
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $candidateRoots.Add([pscustomobject]@{
      path = $env:ProgramFiles
      kind = "program_files"
    }) | Out-Null
  }
  if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
    $candidateRoots.Add([pscustomobject]@{
      path = ${env:ProgramFiles(x86)}
      kind = "program_files_x86"
    }) | Out-Null
  }

  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($candidateRoot in $candidateRoots) {
    foreach ($directoryName in @("LilyWorkbench", "Lily Workbench")) {
      $candidates.Add([pscustomobject]@{
        path = Join-Path ([string]$candidateRoot.path) $directoryName
        kind = [string]$candidateRoot.kind
      }) | Out-Null
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($script:InstallDirectory)) {
    $candidates.Add([pscustomobject]@{
      path = $script:InstallDirectory
      kind = "observed_install_directory"
    }) | Out-Null
  }

  $seenPaths = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  $residues = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in $candidates) {
    $candidatePath = [System.IO.Path]::GetFullPath([string]$candidate.path)
    if (-not $seenPaths.Add($candidatePath) -or
        -not (Test-Path -LiteralPath $candidatePath -PathType Container)) {
      continue
    }
    $residues.Add([pscustomobject][ordered]@{
      path = $candidatePath
      kind = [string]$candidate.kind
    }) | Out-Null
  }

  return @($residues | Sort-Object path)
}

function Try-NormalUninstallCleanup {
  $entry = $null
  try {
    $entries = @(Get-LilyUninstallEntries)
    if ($entries.Count -eq 0) {
      Add-Check `
        -Id "cleanup.normal_uninstaller" `
        -Status "not_applicable" `
        -Detail "No Lily Workbench ARP entry remained for normal-uninstaller cleanup." | Out-Null
      return
    }
    if ($entries.Count -gt 1) {
      Add-Check `
        -Id "cleanup.normal_uninstaller" `
        -Status "fail" `
        -Detail ("Normal cleanup refused to guess between {0} Lily Workbench ARP entries." -f $entries.Count) `
        -Evidence $entries | Out-Null
      return
    }

    $entry = $entries[0]
    $cleanupInstallDirectory = $script:InstallDirectory
    if ([string]::IsNullOrWhiteSpace($cleanupInstallDirectory) -or
        -not (Test-Path -LiteralPath $cleanupInstallDirectory -PathType Container)) {
      $cleanupInstallDirectory = Resolve-InstallDirectory -Entry $entry
    }

    $command = Resolve-UninstallCommand `
      -Entry $entry `
      -InstallDirectory $cleanupInstallDirectory
    Record-UninstallQuietContract -Command $command
    $cleanupResult = Invoke-SilentUninstall `
      -Entry $entry `
      -InstallDirectory $cleanupInstallDirectory `
      -TimeoutSeconds $script:UninstallTimeoutSeconds
    $cleanupVisibleWindows = @($cleanupResult.process.visibleWindows)
    $cleanupPassed = (
      -not $cleanupResult.process.timedOut -and
      $null -ne $cleanupResult.process.exitCode -and
      [int]$cleanupResult.process.exitCode -eq 0 -and
      $cleanupVisibleWindows.Count -eq 0 -and
      [bool]$cleanupResult.productEntryRemoved -and
      [bool]$cleanupResult.installDirectoryRemoved
    )
    if ($cleanupPassed) {
      Add-Check `
        -Id "cleanup.normal_uninstaller" `
        -Status "pass" `
        -Detail "The registered normal uninstaller completed bounded silent cleanup." `
        -Evidence $cleanupResult | Out-Null
    } else {
      Add-Check `
        -Id "cleanup.normal_uninstaller" `
        -Status "fail" `
        -Detail "The registered normal uninstaller did not complete bounded silent cleanup." `
        -Evidence $cleanupResult | Out-Null
    }
  } catch {
    $quietContractChecks = @($script:Checks | Where-Object {
      $_.id -eq "uninstall.quiet_contract"
    })
    if ($quietContractChecks.Count -eq 0) {
      Add-Check `
        -Id "uninstall.quiet_contract" `
        -Status "fail" `
        -Detail ("Unable to validate the registered uppercase /S quiet-uninstall contract: " + $_.Exception.Message) `
        -Evidence $entry | Out-Null
    }
    Add-Check `
      -Id "cleanup.normal_uninstaller" `
      -Status "fail" `
      -Detail ("Normal-uninstaller cleanup failed: " + $_.Exception.Message) `
      -Evidence ([pscustomobject][ordered]@{
        exceptionType = $_.Exception.GetType().FullName
        scriptStackTrace = $_.ScriptStackTrace
      }) | Out-Null
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
  Add-Check `
    -Id "certification.wack" `
    -Status "not_applicable" `
    -Detail "The current artifact is a raw/unpackaged NSIS EXE, while the current Windows App Certification Kit CLI targets packaged AppX/MSIX artifacts; this runner does not fabricate a WACK result." | Out-Null

  Start-Transcript -Path $transcriptPath -Force | Out-Null
  $transcriptStarted = $true

  Require-Check `
    -Id "preflight.windows" `
    -Condition ($env:OS -eq "Windows_NT") `
    -PassDetail "The runner is executing on Windows." `
    -FailDetail "This readiness runner must execute on Windows; lifecycle commands were not started."

  Initialize-NativeCommandLine

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

  $legacyEntries = @(Get-LilyLegacyUninstallEntries)
  Require-Check `
    -Id "preflight.no_legacy_install" `
    -Condition ($legacyEntries.Count -eq 0) `
    -PassDetail "No installation registered under the former Lily Workbench appId was found." `
    -FailDetail ("Expected a clean VM, but found {0} installation registered under the former Lily Workbench appId." -f $legacyEntries.Count) `
    -Evidence $legacyEntries

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
    $normalizedExpectedPublisher = Normalize-PublisherName -Value $ExpectedPublisher
    $normalizedSignerSimpleName = Normalize-PublisherName `
      -Value ([string]$installerSignature.signerSimpleName)
    $signerMatchesExpectedPublisher = [string]::Equals(
      $normalizedSignerSimpleName,
      $normalizedExpectedPublisher,
      [System.StringComparison]::OrdinalIgnoreCase
    )
    Require-Check `
      -Id "installer.publisher" `
      -Condition $signerMatchesExpectedPublisher `
      -PassDetail ("The installer signer simple name exactly matches the expected publisher: " + $ExpectedPublisher) `
      -FailDetail ("The installer signer simple name does not exactly match the expected publisher: " + $ExpectedPublisher) `
      -Evidence $installerSignature
  }

  $installArguments = @("/S", "/currentuser")
  $script:InstallAttemptStarted = $true
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
    $normalizedExpectedPublisher = Normalize-PublisherName -Value $ExpectedPublisher
    $normalizedArpPublisher = Normalize-PublisherName `
      -Value ([string]$script:InstalledEntry.Publisher)
    $arpPublisherMatches = [string]::Equals(
      $normalizedArpPublisher,
      $normalizedExpectedPublisher,
      [System.StringComparison]::OrdinalIgnoreCase
    )
    Require-Check `
      -Id "registry.publisher" `
      -Condition $arpPublisherMatches `
      -PassDetail ("The normalized ARP publisher exactly matches the expected publisher: " + $ExpectedPublisher) `
      -FailDetail ("The normalized ARP publisher does not exactly match the expected publisher: " + $ExpectedPublisher) `
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
  $script:InstallDirectory = $installDirectory
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

  $uninstallCommand = Resolve-UninstallCommand `
    -Entry $script:InstalledEntry `
    -InstallDirectory $script:InstallDirectory
  Record-UninstallQuietContract -Command $uninstallCommand
  $uninstallResult = Invoke-SilentUninstall `
    -Entry $script:InstalledEntry `
    -InstallDirectory $script:InstallDirectory `
    -TimeoutSeconds $UninstallTimeoutSeconds
  $script:Report["uninstall"] = $uninstallResult

  if (-not $uninstallResult.process.timedOut) {
    Add-Check `
      -Id "uninstall.completed_in_time" `
      -Status "pass" `
      -Detail "The registered quiet uninstaller completed within the configured timeout." `
      -Evidence $uninstallResult | Out-Null
  } else {
    Add-Check `
      -Id "uninstall.completed_in_time" `
      -Status "fail" `
      -Detail "The registered quiet uninstaller exceeded the configured timeout." `
      -Evidence $uninstallResult | Out-Null
  }

  if ($null -ne $uninstallResult.process.exitCode -and
      [int]$uninstallResult.process.exitCode -eq 0) {
    Add-Check `
      -Id "uninstall.exit_code" `
      -Status "pass" `
      -Detail "The registered quiet uninstaller returned exit code 0." `
      -Evidence $uninstallResult | Out-Null
  } else {
    Add-Check `
      -Id "uninstall.exit_code" `
      -Status "fail" `
      -Detail ("The registered quiet uninstaller did not return exit code 0: " + [string]$uninstallResult.process.exitCode) `
      -Evidence $uninstallResult | Out-Null
  }

  $uninstallVisibleWindows = @($uninstallResult.process.visibleWindows)
  if ($uninstallVisibleWindows.Count -eq 0) {
    Add-Check `
      -Id "uninstall.no_visible_ui" `
      -Status "pass" `
      -Detail "The registered quiet uninstaller showed no visible root or descendant windows." `
      -Evidence $uninstallResult | Out-Null
  } else {
    Add-Check `
      -Id "uninstall.no_visible_ui" `
      -Status "fail" `
      -Detail ("The registered quiet uninstaller showed {0} visible window or windows." -f $uninstallVisibleWindows.Count) `
      -Evidence $uninstallResult | Out-Null
  }

  if ([bool]$uninstallResult.productEntryRemoved) {
    Add-Check `
      -Id "uninstall.product_entry_removed" `
      -Status "pass" `
      -Detail "The Lily Workbench ARP entry disappeared after uninstall." `
      -Evidence $uninstallResult | Out-Null
  } else {
    Add-Check `
      -Id "uninstall.product_entry_removed" `
      -Status "fail" `
      -Detail "The Lily Workbench ARP entry remained after the bounded removal poll." `
      -Evidence $uninstallResult | Out-Null
  }

  if ([bool]$uninstallResult.installDirectoryRemoved) {
    Add-Check `
      -Id "uninstall.install_directory_removed" `
      -Status "pass" `
      -Detail "The installation directory disappeared after the bounded asynchronous NSIS removal poll." `
      -Evidence $uninstallResult | Out-Null
  } else {
    Add-Check `
      -Id "uninstall.install_directory_removed" `
      -Status "fail" `
      -Detail "The installation directory remained after the bounded asynchronous NSIS removal poll." `
      -Evidence $uninstallResult | Out-Null
  }

  $remainingShortcuts = @(Get-LilyShortcuts)
  if ($remainingShortcuts.Count -eq 0) {
    Add-Check `
      -Id "uninstall.shortcuts_removed" `
      -Status "pass" `
      -Detail "No Lily Workbench desktop or Start menu shortcut remained after uninstall." `
      -Evidence $remainingShortcuts | Out-Null
  } else {
    Add-Check `
      -Id "uninstall.shortcuts_removed" `
      -Status "fail" `
      -Detail ("Found {0} Lily Workbench shortcut or shortcuts after uninstall." -f $remainingShortcuts.Count) `
      -Evidence $remainingShortcuts | Out-Null
  }

  $userDataResidues = @(Get-LilyUserDataResidues)
  $userDataResiduePath = Write-JsonEvidence `
    -FileName "user-data-residue.json" `
    -Value @($userDataResidues)
  if ($userDataResidues.Count -eq 0) {
    Add-Check `
      -Id "uninstall.user_data_residue" `
      -Status "pass" `
      -Detail "No known Lily Workbench user-data residue remained." `
      -Evidence $userDataResiduePath | Out-Null
  } elseif ($AllowUserDataRemnants) {
    Add-Check `
      -Id "uninstall.user_data_residue" `
      -Status "warning" `
      -Detail ("AllowUserDataRemnants explicitly permits {0} inventoried user-data residue path or paths." -f $userDataResidues.Count) `
      -Evidence $userDataResiduePath | Out-Null
  } else {
    Add-Check `
      -Id "uninstall.user_data_residue" `
      -Status "fail" `
      -Detail ("Strict residue policy found {0} known Lily Workbench user-data residue path or paths." -f $userDataResidues.Count) `
      -Evidence $userDataResiduePath | Out-Null
  }
  $script:UserDataResidueRecorded = $true
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
  try {
    $remainingEntriesBeforeCleanup = @(Get-LilyUninstallEntries)
    if ($script:InstallAttemptStarted -and $remainingEntriesBeforeCleanup.Count -gt 0) {
      Try-NormalUninstallCleanup
    }
  } catch {
    Add-Check `
      -Id "cleanup.normal_uninstaller" `
      -Status "fail" `
      -Detail ("Unable to inspect ARP state before normal-uninstaller cleanup: " + $_.Exception.Message) `
      -Evidence ([pscustomobject][ordered]@{
        exceptionType = $_.Exception.GetType().FullName
        scriptStackTrace = $_.ScriptStackTrace
      }) | Out-Null
  }

  try {
    $registryAfter = @(Get-LilyUninstallEntries)
    $registryAfterPath = Write-JsonEvidence `
      -FileName "registry-after.json" `
      -Value @($registryAfter)
    Add-Check `
      -Id "cleanup.registry_after" `
      -Status "pass" `
      -Detail ("Captured the real post-cleanup ARP snapshot with {0} Lily Workbench entry or entries." -f $registryAfter.Count) `
      -Evidence $registryAfterPath | Out-Null
  } catch {
    Add-Check `
      -Id "cleanup.registry_after" `
      -Status "fail" `
      -Detail ("Unable to capture registry-after.json after cleanup: " + $_.Exception.Message) `
      -Evidence ([pscustomobject][ordered]@{
        exceptionType = $_.Exception.GetType().FullName
        scriptStackTrace = $_.ScriptStackTrace
      }) | Out-Null
  }

  try {
    $installResidues = @(Get-LilyInstallResidues)
    if ($installResidues.Count -eq 0) {
      Add-Check `
        -Id "cleanup.install_residue" `
        -Status "pass" `
        -Detail "No known Lily Workbench installation directory remained after normal cleanup." `
        -Evidence $installResidues | Out-Null
    } else {
      Add-Check `
        -Id "cleanup.install_residue" `
        -Status "fail" `
        -Detail ("Found {0} known Lily Workbench installation directory residue path or paths." -f $installResidues.Count) `
        -Evidence $installResidues | Out-Null
    }
  } catch {
    Add-Check `
      -Id "cleanup.install_residue" `
      -Status "fail" `
      -Detail ("Unable to inventory installation-directory residue: " + $_.Exception.Message) `
      -Evidence ([pscustomobject][ordered]@{
        exceptionType = $_.Exception.GetType().FullName
        scriptStackTrace = $_.ScriptStackTrace
      }) | Out-Null
  }

  try {
    $shortcutResidues = @(Get-LilyShortcuts)
    if ($shortcutResidues.Count -eq 0) {
      Add-Check `
        -Id "cleanup.shortcut_residue" `
        -Status "pass" `
        -Detail "No Lily Workbench desktop or Start menu shortcut residue remained after normal cleanup." `
        -Evidence $shortcutResidues | Out-Null
    } else {
      Add-Check `
        -Id "cleanup.shortcut_residue" `
        -Status "fail" `
        -Detail ("Found {0} Lily Workbench shortcut residue path or paths." -f $shortcutResidues.Count) `
        -Evidence $shortcutResidues | Out-Null
    }
  } catch {
    Add-Check `
      -Id "cleanup.shortcut_residue" `
      -Status "fail" `
      -Detail ("Unable to inventory shortcut residue: " + $_.Exception.Message) `
      -Evidence ([pscustomobject][ordered]@{
        exceptionType = $_.Exception.GetType().FullName
        scriptStackTrace = $_.ScriptStackTrace
      }) | Out-Null
  }

  try {
    $finalUserDataResidues = @(Get-LilyUserDataResidues)
    $finalUserDataResiduePath = Write-JsonEvidence `
      -FileName "user-data-residue.json" `
      -Value @($finalUserDataResidues)
    if (-not $script:UserDataResidueRecorded) {
      if ($finalUserDataResidues.Count -eq 0) {
        Add-Check `
          -Id "cleanup.user_data_residue" `
          -Status "pass" `
          -Detail "No known Lily Workbench user-data residue remained after normal cleanup." `
          -Evidence $finalUserDataResiduePath | Out-Null
      } elseif ($AllowUserDataRemnants) {
        Add-Check `
          -Id "cleanup.user_data_residue" `
          -Status "warning" `
          -Detail ("AllowUserDataRemnants explicitly permits {0} inventoried user-data residue path or paths after cleanup." -f $finalUserDataResidues.Count) `
          -Evidence $finalUserDataResiduePath | Out-Null
      } else {
        Add-Check `
          -Id "cleanup.user_data_residue" `
          -Status "fail" `
          -Detail ("Strict residue policy found {0} known Lily Workbench user-data residue path or paths after cleanup." -f $finalUserDataResidues.Count) `
          -Evidence $finalUserDataResiduePath | Out-Null
      }
      $script:UserDataResidueRecorded = $true
    }
  } catch {
    Add-Check `
      -Id "cleanup.user_data_residue" `
      -Status "fail" `
      -Detail ("Unable to inventory or write user-data-residue.json: " + $_.Exception.Message) `
      -Evidence ([pscustomobject][ordered]@{
        exceptionType = $_.Exception.GetType().FullName
        scriptStackTrace = $_.ScriptStackTrace
      }) | Out-Null
  }

  if ($transcriptStarted) {
    try {
      Stop-Transcript | Out-Null
    } catch {
      Add-Check `
        -Id "cleanup.transcript" `
        -Status "fail" `
        -Detail ("Unable to stop readiness transcript: " + $_.Exception.Message) | Out-Null
      Write-Warning ("Unable to stop transcript: " + $_.Exception.Message)
    }
  }

  $failedChecks = @($Checks | Where-Object { $_.status -eq "fail" })
  if ($failedChecks.Count -eq 0) {
    $exitCode = 0
  } else {
    $exitCode = 1
  }

  try {
    Write-Reports
  } catch {
    $exitCode = 1
    Write-Warning ("Unable to write readiness reports: " + $_.Exception.Message)
  }

  try {
    Set-Content -LiteralPath $exitCodePath -Value $exitCode -Encoding ASCII
  } catch {
    $exitCode = 1
    Write-Warning ("Unable to write readiness exit-code sentinel: " + $_.Exception.Message)
    try {
      Set-Content -LiteralPath $exitCodePath -Value 1 -Encoding ASCII
    } catch {
      Write-Warning ("Unable to retry readiness exit-code sentinel: " + $_.Exception.Message)
    }
  }
}

exit $exitCode
