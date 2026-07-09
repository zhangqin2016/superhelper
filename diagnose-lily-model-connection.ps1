$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$desktop = [Environment]::GetFolderPath("Desktop")
$out = Join-Path $desktop ("lily-model-diagnostics-" + $stamp)
New-Item -ItemType Directory -Force -Path $out | Out-Null
$report = Join-Path $out "report.txt"

function Write-Line {
  param([string]$Text = "")
  Add-Content -Path $report -Value $Text -Encoding UTF8
}

function Write-Section {
  param([string]$Name)
  Write-Line ""
  Write-Line ("==== " + $Name + " ====")
}

function Test-Url {
  param([string]$Url)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $response = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 20 -UseBasicParsing
    $sw.Stop()
    Write-Line ("OK   " + $Url + " status=" + [int]$response.StatusCode + " timeMs=" + $sw.ElapsedMilliseconds)
  } catch {
    $sw.Stop()
    $status = ""
    try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    Write-Line ("FAIL " + $Url + " status=" + $status + " timeMs=" + $sw.ElapsedMilliseconds + " error=" + $_.Exception.Message)
  }
}

function Copy-RedactedJson {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path -LiteralPath $Source)) { return }
  try {
    $text = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
    $text = $text -replace "(?i)(sk-[A-Za-z0-9_\-]{8,})", "[REDACTED_API_KEY]"
    $text = $text -replace "(?i)(api[_-]?key""?\s*:\s*"")([^""]+)("")", '$1[REDACTED]$3'
    $text = $text -replace "(?i)(token""?\s*:\s*"")([^""]+)("")", '$1[REDACTED]$3'
    $text = $text -replace "(?i)(authorization""?\s*:\s*"")([^""]+)("")", '$1[REDACTED]$3'
    Set-Content -LiteralPath $Destination -Value $text -Encoding UTF8
  } catch {}
}

Write-Section "Basic"
Write-Line ("time=" + (Get-Date).ToString("o"))
Write-Line ("user=" + $env:USERNAME)
Write-Line ("computer=" + $env:COMPUTERNAME)
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Write-Line ("os=" + $os.Caption + " " + $os.Version)
} catch {}
Write-Line ("appdata=" + $env:APPDATA)
Write-Line ("localappdata=" + $env:LOCALAPPDATA)

Write-Section "Proxy"
Write-Line ("HTTP_PROXY=" + $env:HTTP_PROXY)
Write-Line ("HTTPS_PROXY=" + $env:HTTPS_PROXY)
Write-Line ("NO_PROXY=" + $env:NO_PROXY)
try {
  netsh winhttp show proxy | Out-String | ForEach-Object { Write-Line $_.TrimEnd() }
} catch {}

Write-Section "DNS"
foreach ($hostName in @("lilych.lilywb.cn", "lilyxinjiapo.lilywb.cn")) {
  Write-Line ("-- " + $hostName)
  try {
    Resolve-DnsName $hostName |
      Select-Object Name, Type, IPAddress, NameHost |
      Format-Table -AutoSize |
      Out-String |
      ForEach-Object { Write-Line $_.TrimEnd() }
  } catch {
    Write-Line ("DNS_FAIL " + $_.Exception.Message)
  }
}

Write-Section "TCP 443"
foreach ($hostName in @("lilych.lilywb.cn", "lilyxinjiapo.lilywb.cn")) {
  try {
    $test = Test-NetConnection -ComputerName $hostName -Port 443 -InformationLevel Detailed
    Write-Line ($hostName + " TcpTestSucceeded=" + $test.TcpTestSucceeded + " RemoteAddress=" + $test.RemoteAddress)
  } catch {
    Write-Line ($hostName + " TCP_FAIL " + $_.Exception.Message)
  }
}

Write-Section "HTTP"
Test-Url "https://lilych.lilywb.cn/api/client/bootstrap"
Test-Url "https://lilyxinjiapo.lilywb.cn/api/client/bootstrap"
Test-Url "https://lilych.lilywb.cn/llm"
Test-Url "https://lilyxinjiapo.lilywb.cn/llm"

Write-Section "Lily files"
$roots = @()
foreach ($name in @("lily-workbench", "Lily Workbench", "ai-super-terminal", "terminal-chat-claude")) {
  if ($env:APPDATA) { $roots += Join-Path $env:APPDATA $name }
  if ($env:LOCALAPPDATA) { $roots += Join-Path $env:LOCALAPPDATA $name }
}
$roots = $roots | Select-Object -Unique
foreach ($root in $roots) {
  if (Test-Path -LiteralPath $root) {
    Write-Line ("ROOT " + $root)
    Get-ChildItem -LiteralPath $root -Force |
      Select-Object Name, Length, LastWriteTime |
      Format-Table -AutoSize |
      Out-String |
      ForEach-Object { Write-Line $_.TrimEnd() }
  }
}

$main = ""
if ($env:APPDATA) { $main = Join-Path $env:APPDATA "lily-workbench" }
if ($main -and (Test-Path -LiteralPath $main)) {
  foreach ($file in @("client-bootstrap-policy.json", "model-settings.json", "device-state.json", "app-preferences.json", "runtime-pack-root.json")) {
    $source = Join-Path $main $file
    Copy-RedactedJson $source (Join-Path $out ("redacted-" + $file))
  }
  $diag = Join-Path $main "diagnostics"
  if (Test-Path -LiteralPath $diag) {
    Copy-Item -LiteralPath $diag -Destination (Join-Path $out "diagnostics") -Recurse -Force
  }
}

Compress-Archive -Path (Join-Path $out "*") -DestinationPath ($out + ".zip") -Force
Write-Host ("Diagnostics finished: " + $out + ".zip")
