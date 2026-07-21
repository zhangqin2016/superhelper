# Lily Workbench model-connection diagnostic script for Windows.
#
# Customer command:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-model-connection-diagnose.ps1 -Repair
#
# Output:
#   Desktop\LilyConnectionDiagnostic-YYYYMMDD-HHMMSS.zip
#
# The script is privacy-conscious by default:
# - It does not change Lily configuration, proxy settings, registry values, or API keys.
# - With -Repair it only flushes DNS cache.
# - It redacts common API keys, bearer tokens, and Lily gateway tokens before writing reports.

#requires -version 5.1

param(
  [switch]$Repair,
  [switch]$NoPause,
  [int]$Days = 7,
  [string]$OutputRoot = [Environment]::GetFolderPath("Desktop")
)

$ErrorActionPreference = "Continue"

try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::Tls12 -bor
    [Net.SecurityProtocolType]::Tls11 -bor
    [Net.SecurityProtocolType]::Tls
} catch {}

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$WorkDir = Join-Path $env:TEMP "LilyConnectionDiagnostic-$Stamp"
$ZipPath = Join-Path $OutputRoot "LilyConnectionDiagnostic-$Stamp.zip"
$SummaryPath = Join-Path $WorkDir "summary.txt"
$NetworkPath = Join-Path $WorkDir "network.txt"
$ProxyPath = Join-Path $WorkDir "proxy.txt"
$ErrorsPath = Join-Path $WorkDir "matched-errors.txt"
$RepairPath = Join-Path $WorkDir "repair.txt"
$ConfigDir = Join-Path $WorkDir "redacted-config"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null

Write-Host "Running Lily Workbench connection diagnostics..."
Write-Host "This may take 1-3 minutes. Please keep this window open."
Write-Host ""

function Add-Text {
  param([string]$Path, [string]$Text)
  Add-Content -Path $Path -Value $Text -Encoding UTF8
}

function Add-Section {
  param([string]$Path, [string]$Title)
  Add-Text $Path ""
  Add-Text $Path "==== $Title ===="
}

function Redact-Text {
  param([AllowNull()][string]$Text)
  if ($null -eq $Text) { return "" }
  $Value = [string]$Text
  $Value = $Value -replace '(?i)Bearer\s+[A-Za-z0-9._~+/=-]{12,}', 'Bearer [REDACTED]'
  $Value = $Value -replace '(?i)\blilygw\.[A-Za-z0-9._~+/=-]{12,}', 'lilygw.[REDACTED]'
  $Value = $Value -replace '(?i)\bsk-[A-Za-z0-9._~+/=-]{12,}', 'sk-[REDACTED]'
  $Value = $Value -replace '(?i)\bark-[A-Za-z0-9._~+/=-]{12,}', 'ark-[REDACTED]'
  $Value = $Value -replace '(?i)("?(api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|license[_-]?key|secret)"?\s*[:=]\s*)"?[^",}\s]+', '$1"[REDACTED]"'
  $Value = $Value -replace '(?i)(authorization\s*[:=]\s*)"?[^",}\r\n]+', '$1"[REDACTED]"'
  return $Value
}

function Safe-Run {
  param(
    [string]$Title,
    [scriptblock]$Block,
    [string]$Path = $SummaryPath
  )
  Add-Section $Path $Title
  try {
    $Result = & $Block 2>&1 | Out-String
    Add-Text $Path (Redact-Text $Result.Trim())
  } catch {
    Add-Text $Path ("ERROR: " + (Redact-Text ($_.Exception.Message)))
  }
}

function Get-AppDataCandidates {
  $Candidates = New-Object System.Collections.Generic.List[string]
  if ($env:APPDATA) {
    $Candidates.Add((Join-Path $env:APPDATA "lily-workbench"))
    $Candidates.Add((Join-Path $env:APPDATA "Lily Workbench"))
  }
  if ($env:LOCALAPPDATA) {
    $Candidates.Add((Join-Path $env:LOCALAPPDATA "lily-workbench"))
    $Candidates.Add((Join-Path $env:LOCALAPPDATA "Lily Workbench"))
  }
  $Candidates | Select-Object -Unique | Where-Object { Test-Path $_ }
}

function Test-Tls {
  param([string]$HostName, [int]$Port = 443)
  $Tcp = $null
  $Ssl = $null
  try {
    $Tcp = New-Object Net.Sockets.TcpClient
    $Async = $Tcp.BeginConnect($HostName, $Port, $null, $null)
    if (-not $Async.AsyncWaitHandle.WaitOne(10000, $false)) {
      $Tcp.Close()
      return "TLS: timeout connecting to ${HostName}:$Port"
    }
    $Tcp.EndConnect($Async)
    $Callback = { param($sender, $certificate, $chain, $sslPolicyErrors) return $true }
    $Ssl = New-Object Net.Security.SslStream -ArgumentList ($Tcp.GetStream()), $false, $Callback
    $Ssl.AuthenticateAsClient($HostName)
    $Cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $Ssl.RemoteCertificate
    $Chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    $ChainOk = $Chain.Build($Cert)
    $Status = ($Chain.ChainStatus | ForEach-Object { $_.Status.ToString() + ":" + $_.StatusInformation.Trim() }) -join "; "
    if (-not $Status) { $Status = "none" }
    return "TLS: ok protocol=$($Ssl.SslProtocol) certSubject=$($Cert.Subject) certIssuer=$($Cert.Issuer) notAfter=$($Cert.NotAfter.ToString('s')) chainOk=$ChainOk chainStatus=$Status"
  } catch {
    return "TLS: error " + $_.Exception.Message
  } finally {
    if ($Ssl) { $Ssl.Dispose() }
    if ($Tcp) { $Tcp.Close() }
  }
}

function Test-Url {
  param([string]$Url)
  $Watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    $Response = Invoke-WebRequest -Uri $Url -Method GET -UseBasicParsing -TimeoutSec 15 -Headers @{
      "User-Agent" = "LilyConnectionDiagnostic/1.0"
    }
    $Watch.Stop()
    return "GET $Url -> HTTP $([int]$Response.StatusCode) in $($Watch.ElapsedMilliseconds)ms"
  } catch {
    $Watch.Stop()
    $Status = ""
    try {
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $Status = " HTTP " + ([int]$_.Exception.Response.StatusCode)
      }
    } catch {}
    return "GET $Url -> ERROR$Status in $($Watch.ElapsedMilliseconds)ms: " + $_.Exception.Message
  }
}

function Copy-RedactedFile {
  param([string]$Source, [string]$DestinationName)
  try {
    if (-not (Test-Path $Source)) { return }
    $Info = Get-Item $Source -ErrorAction Stop
    if ($Info.Length -gt 2MB) {
      Add-Text $SummaryPath "Skipped large config: $Source ($($Info.Length) bytes)"
      return
    }
    $Raw = Get-Content -Raw -Path $Source -ErrorAction Stop
    $Redacted = Redact-Text $Raw
    $Dest = Join-Path $ConfigDir $DestinationName
    Set-Content -Path $Dest -Value $Redacted -Encoding UTF8
  } catch {
    Add-Text $SummaryPath "Failed to copy redacted config ${Source}: $($_.Exception.Message)"
  }
}

function Repair-ModelSettingsJson {
  param([string]$Root)
  $Path = Join-Path $Root "model-settings.json"
  Add-Section $RepairPath "Model settings JSON repair"
  if (-not (Test-Path $Path)) {
    Add-Text $RepairPath "No model-settings.json found at $Path"
    return
  }
  try {
    $Raw = Get-Content -Raw -Path $Path -ErrorAction Stop
    $null = $Raw | ConvertFrom-Json -ErrorAction Stop
    Add-Text $RepairPath "model-settings.json is valid JSON; no repair needed: $Path"
  } catch {
    $Backup = Join-Path $Root "model-settings.json.corrupt-$Stamp.bak"
    try {
      Copy-Item -LiteralPath $Path -Destination $Backup -Force -ErrorAction Stop
      $DefaultModelSettings = @'
{
  "activePresetId": null,
  "customPresets": [],
  "apiGateway": {
    "mode": "builtin",
    "baseUrl": "",
    "protocol": "openai",
    "tlsSkipVerify": false,
    "apiKeyProtected": null
  }
}
'@
      Set-Content -LiteralPath $Path -Value $DefaultModelSettings -Encoding UTF8 -ErrorAction Stop
      Add-Text $RepairPath "Repaired corrupt model-settings.json: $Path"
      Add-Text $RepairPath "Original file was backed up to: $Backup"
      Add-Text $RepairPath ("Original parse error: " + (Redact-Text $_.Exception.Message))
    } catch {
      Add-Text $RepairPath "Failed to repair corrupt model-settings.json at ${Path}: $($_.Exception.Message)"
    }
  }
}

Add-Section $SummaryPath "Overview"
Add-Text $SummaryPath "GeneratedAt: $((Get-Date).ToString('s'))"
Add-Text $SummaryPath "ComputerName: $env:COMPUTERNAME"
Add-Text $SummaryPath "UserName: $env:USERNAME"
Add-Text $SummaryPath "PowerShell: $($PSVersionTable.PSVersion)"
Add-Text $SummaryPath "RepairMode: $Repair"
Add-Text $SummaryPath "LookbackDays: $Days"

Safe-Run "Operating system" {
  Get-CimInstance Win32_OperatingSystem |
    Select-Object Caption, Version, BuildNumber, OSArchitecture, LastBootUpTime |
    Format-List
}

Safe-Run "Time and locale" {
  "NowLocal: $((Get-Date).ToString('o'))"
  "TimeZone: $((Get-TimeZone).Id)"
  "Culture: $([Globalization.CultureInfo]::CurrentCulture.Name)"
}

Safe-Run "Relevant processes" {
  Get-Process |
    Where-Object { $_.ProcessName -match 'Lily|lily|opencode|node' } |
    Select-Object ProcessName, Id, StartTime, Responding |
    Sort-Object ProcessName |
    Format-Table -AutoSize
}

$AppRoots = @(Get-AppDataCandidates)
Add-Section $SummaryPath "Lily userData candidates"
if ($AppRoots.Count -eq 0) {
  Add-Text $SummaryPath "No Lily userData directory found under APPDATA or LOCALAPPDATA."
} else {
  foreach ($Root in $AppRoots) {
    try {
      $Item = Get-Item $Root
      $Size = (Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
      Add-Text $SummaryPath "$Root | LastWrite=$($Item.LastWriteTime.ToString('s')) | SizeBytes=$Size"
    } catch {
      Add-Text $SummaryPath "$Root | ERROR $($_.Exception.Message)"
    }
  }
}

if ($Repair) {
  foreach ($Root in $AppRoots) {
    Repair-ModelSettingsJson -Root $Root
  }
}

$KnownConfigFiles = @(
  "model-settings.json",
  "client-bootstrap-policy.json",
  "remote-config-cache.json",
  "engine-settings.json",
  "app-preferences.json",
  "media-provider-settings.json",
  "search-settings.json"
)

foreach ($Root in $AppRoots) {
  foreach ($Name in $KnownConfigFiles) {
    $Source = Join-Path $Root $Name
    $SafeName = (($Root -replace '[:\\\/ ]+', '_').Trim('_') + "__" + $Name)
    Copy-RedactedFile -Source $Source -DestinationName $SafeName
  }
}

Add-Section $ProxyPath "Environment proxy variables"
Get-ChildItem Env: |
  Where-Object { $_.Name -match 'proxy|SSL_CERT|NODE_EXTRA_CA_CERTS|NO_PROXY' } |
  Sort-Object Name |
  ForEach-Object { Add-Text $ProxyPath (Redact-Text ("$($_.Name)=$($_.Value)")) }

Safe-Run "WinHTTP proxy" { netsh winhttp show proxy } $ProxyPath
Safe-Run "WinINET proxy registry" {
  Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" |
    Select-Object ProxyEnable, ProxyServer, AutoConfigURL, ProxyOverride |
    Format-List
} $ProxyPath

if ($Repair) {
  Add-Section $RepairPath "Safe repair actions"
  Safe-Run "Flush DNS cache" { ipconfig /flushdns } $RepairPath
  Add-Text $RepairPath "No proxy, registry, Lily config, API key, or certificate setting was changed."
} else {
  Add-Section $RepairPath "Repair actions"
  Add-Text $RepairPath "Repair mode was not enabled. Re-run with -Repair to flush DNS cache."
  Add-Text $RepairPath "No proxy, registry, Lily config, API key, or certificate setting was changed."
}

$Domains = @(
  "lilych.lilywb.cn",
  "lilyxinjiapo.lilywb.cn",
  "www.lilywb.cn"
)

Add-Section $NetworkPath "DNS and TCP checks"
foreach ($Domain in $Domains) {
  Add-Text $NetworkPath ""
  Add-Text $NetworkPath "-- $Domain --"
  try {
    $Dns = Resolve-DnsName $Domain -ErrorAction Stop
    $Dns | Select-Object Name, Type, IPAddress, NameHost | Format-Table -AutoSize |
      Out-String | ForEach-Object { Add-Text $NetworkPath $_.TrimEnd() }
  } catch {
    Add-Text $NetworkPath "Resolve-DnsName failed: $($_.Exception.Message)"
    try {
      [Net.Dns]::GetHostAddresses($Domain) |
        ForEach-Object { Add-Text $NetworkPath ("System.Net.Dns address: " + $_.IPAddressToString) }
    } catch {
      Add-Text $NetworkPath "System.Net.Dns failed: $($_.Exception.Message)"
    }
  }
  try {
    Test-NetConnection -ComputerName $Domain -Port 443 -InformationLevel Detailed |
      Select-Object ComputerName, RemoteAddress, RemotePort, InterfaceAlias, SourceAddress, TcpTestSucceeded |
      Format-List | Out-String | ForEach-Object { Add-Text $NetworkPath $_.TrimEnd() }
  } catch {
    Add-Text $NetworkPath "Test-NetConnection failed: $($_.Exception.Message)"
  }
  Add-Text $NetworkPath (Test-Tls -HostName $Domain)
}

Add-Section $NetworkPath "HTTP checks"
$Urls = @(
  "https://lilych.lilywb.cn/health",
  "https://lilyxinjiapo.lilywb.cn/health",
  "https://www.lilywb.cn",
  "https://lilych.lilywb.cn/llm/v1/models",
  "https://lilyxinjiapo.lilywb.cn/llm/v1/models"
)
foreach ($Url in $Urls) {
  Add-Text $NetworkPath (Redact-Text (Test-Url $Url))
}

$Needles = @(
  "Connection to the model service was interrupted",
  "MODEL_CONNECTION_FAILED",
  "MODEL_GATEWAY_TOKEN",
  "MANAGED_MODEL_AUTH",
  "AUTH_FAILED",
  "MODEL_UNAVAILABLE",
  "Request Entity Too Large",
  "CONTEXT_LIMIT",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "fetch failed",
  "socket connection was closed",
  "timeout",
  "502",
  "503",
  "504",
  "bad gateway",
  "gateway timeout",
  "upstream"
)

Add-Section $ErrorsPath "Matched recent Lily error lines"
if ($AppRoots.Count -eq 0) {
  Add-Text $ErrorsPath "No Lily userData directory found; skipped local error scan."
} else {
  $Since = (Get-Date).AddDays(-1 * [Math]::Abs($Days))
  $TotalMatches = 0
  foreach ($Root in $AppRoots) {
    Add-Text $ErrorsPath ""
    Add-Text $ErrorsPath "-- root: $Root --"
    $Files = Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object {
        $_.LastWriteTime -ge $Since -and
        $_.Length -le 10MB -and
        $_.FullName -notmatch '\\(blobs|runtime-packs|skills-cache|file-staging|workspace-apps)\\' -and
        ($_.Extension -in @(".log", ".txt", ".json", ".jsonl", ".err", ".out") -or $_.DirectoryName -match 'diagnostics|logs')
      } |
      Select-Object -First 300
    foreach ($File in $Files) {
      try {
        $Matches = Select-String -Path $File.FullName -Pattern $Needles -SimpleMatch -ErrorAction Stop | Select-Object -First 20
        foreach ($Match in $Matches) {
          $TotalMatches += 1
          $Line = Redact-Text $Match.Line
          if ($Line.Length -gt 600) { $Line = $Line.Substring(0, 600) + "..." }
          Add-Text $ErrorsPath ("$($File.FullName):$($Match.LineNumber): $Line")
        }
      } catch {}
      if ($TotalMatches -ge 300) {
        Add-Text $ErrorsPath "Match limit reached; stopped scanning."
        break
      }
    }
  }
  if ($TotalMatches -eq 0) {
    Add-Text $ErrorsPath "No matching recent error lines found."
  }
}

Safe-Run "Recent application event log errors" {
  Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = (Get-Date).AddDays(-1 * [Math]::Abs($Days)) } -MaxEvents 200 |
    Where-Object { $_.ProviderName -match 'Lily|Application Error|Windows Error Reporting|\.NET Runtime' -or $_.Message -match 'Lily|lily-workbench|opencode|node\.exe' } |
    Select-Object TimeCreated, ProviderName, Id, LevelDisplayName, Message |
    Format-List
} (Join-Path $WorkDir "windows-event-log.txt")

Add-Section $SummaryPath "Interpretation hints"
Add-Text $SummaryPath "If /health works but /llm/v1/models returns 401/403, routing is reachable and auth is expected without a Lily token."
Add-Text $SummaryPath "If DNS/TCP/TLS fail for both lilych and lilyxinjiapo, suspect local network, proxy, DNS, TLS interception, or firewall."
Add-Text $SummaryPath "If only matched-errors shows 502/503/504/upstream/socket/timeout, suspect transient model gateway or upstream model service interruption."
Add-Text $SummaryPath "If only one Lily conversation fails while a new conversation works, suspect conversation history, attachment, or large-context state rather than global configuration."

try {
  if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
  Compress-Archive -Path (Join-Path $WorkDir "*") -DestinationPath $ZipPath -Force
  Write-Host ""
  Write-Host "Lily diagnostic package created:"
  Write-Host $ZipPath
  Write-Host ""
  Write-Host "Please send this zip file to Lily support."
} catch {
  Write-Host "Failed to create zip: $($_.Exception.Message)"
  Write-Host "Raw diagnostic folder:"
  Write-Host $WorkDir
}

if (-not $NoPause) {
  Write-Host ""
  Write-Host "Press Enter to close this window."
  try { [void](Read-Host) } catch {}
}
