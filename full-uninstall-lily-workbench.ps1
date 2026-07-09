param(
  [switch]$RemoveDocuments
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$desktop = [Environment]::GetFolderPath('Desktop')
# 备份放在用户文件夹而不是桌面：桌面常被 OneDrive 同步，几个 GB 的备份会触发云上传
$backupRoot = Join-Path $env:USERPROFILE ("lily-uninstall-backup-" + $stamp)
$removed = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]

# 只匹配这些明确属于 Lily 的名字，避免误删其他软件
$namePattern = 'Lily Workbench|lily-workbench|智能工作台|cn\.lilywb\.workbench'

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host ("==> " + $msg) -ForegroundColor Cyan
}

function Backup-Remove([string]$path) {
  if (-not $path) { return }
  $full = [Environment]::ExpandEnvironmentVariables($path)
  if (-not (Test-Path -LiteralPath $full)) { return }
  try {
    if (-not (Test-Path -LiteralPath $backupRoot)) {
      New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    }
    $leaf = Split-Path $full -Leaf
    if (-not $leaf) { $leaf = 'root' }
    $dest = Join-Path $backupRoot ($leaf + '-' + [Math]::Abs($full.GetHashCode()))
    Write-Host ("  正在处理: " + $full)
    try {
      # 同一磁盘上移动是瞬间完成的，几个 GB 也不会卡
      Move-Item -LiteralPath $full -Destination $dest -Force -ErrorAction Stop
    } catch {
      # 移动失败（文件被占用或跨磁盘）时退回"复制+删除"
      Write-Host "    无法直接移动，改为复制备份。目录较大时可能需要几分钟，窗口没输出不是卡死，请耐心等待..." -ForegroundColor Yellow
      Copy-Item -LiteralPath $full -Destination $dest -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    }
    $removed.Add($full)
    Write-Host ("  已删除(已备份): " + $full)
  } catch {
    $failed.Add($full)
    Write-Host ("  删除失败（文件可能被占用，重启电脑后重新运行本脚本）: " + $full) -ForegroundColor Yellow
  }
}

# ------------------------------------------------------------
Write-Step "第 1 步：关闭 Lily 相关进程"
foreach ($n in @('LilyWorkbench', 'Lily Workbench', 'lily-workbench', '智能工作台')) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force
}
# 兜底：按进程路径匹配（能覆盖 Lily 自带的 opencode/node 等子进程）
Get-Process | Where-Object { $_.Path -and ($_.Path -match $namePattern) } | Stop-Process -Force
Start-Sleep -Seconds 2
Write-Host "  完成。"

# ------------------------------------------------------------
Write-Step "第 2 步：调用系统卸载器（静默卸载程序本体）"
$uninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = foreach ($root in $uninstallRoots) {
  Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object {
    ($_.DisplayName -match $namePattern) -or ($_.PSChildName -match $namePattern)
  }
}
$apps = @($apps)
if ($apps.Count -eq 0) {
  Write-Host "  没有在系统卸载列表里找到 Lily Workbench（可能已经卸载过），继续清理残留。"
}
foreach ($app in $apps) {
  $cmd = if ($app.QuietUninstallString) { $app.QuietUninstallString } else { $app.UninstallString }
  if (-not $cmd) { continue }
  Write-Host ("  正在卸载: " + $app.DisplayName)
  if ($cmd -match '^\s*"([^"]+)"\s*(.*)$') {
    $exe = $Matches[1]; $exeArgs = $Matches[2]
  } else {
    $parts = $cmd -split '\s+', 2
    $exe = $parts[0]
    $exeArgs = if ($parts.Count -gt 1) { $parts[1] } else { '' }
  }
  if ($exe -and (Test-Path -LiteralPath $exe)) {
    if ($exeArgs -notmatch '(^|\s)/S(\s|$)') { $exeArgs = ($exeArgs + ' /S').Trim() }
    Start-Process -FilePath $exe -ArgumentList $exeArgs -Wait
  }
}
# NSIS 静默卸载会把自己复制到临时目录后立即返回，多等几秒让它删完
Start-Sleep -Seconds 5
Write-Host "  完成。"

# ------------------------------------------------------------
Write-Step "第 3 步：清理应用数据和安装目录残留（删除前会先备份）"
# 卸载器可能又拉起过进程，删数据前再兜底杀一次，避免文件占用
Get-Process | Where-Object { $_.Path -and ($_.Path -match $namePattern) } | Stop-Process -Force
Start-Sleep -Seconds 1
$dirNames = @(
  'Lily Workbench', 'lily-workbench', '智能工作台',
  'cn.lilywb.workbench',
  'lily-workbench-updater', 'Lily Workbench-updater',
  'ai-super-terminal', 'terminal-chat-claude'
)
foreach ($n in $dirNames) {
  if ($env:APPDATA) { Backup-Remove (Join-Path $env:APPDATA $n) }
  if ($env:LOCALAPPDATA) { Backup-Remove (Join-Path $env:LOCALAPPDATA $n) }
}
$installDirs = @()
if ($env:LOCALAPPDATA) {
  $installDirs += (Join-Path $env:LOCALAPPDATA 'Programs\Lily Workbench')
  $installDirs += (Join-Path $env:LOCALAPPDATA 'Programs\lily-workbench')
  $installDirs += (Join-Path $env:LOCALAPPDATA 'Programs\智能工作台')
}
if ($env:ProgramFiles) { $installDirs += (Join-Path $env:ProgramFiles 'Lily Workbench') }
if (${env:ProgramFiles(x86)}) { $installDirs += (Join-Path ${env:ProgramFiles(x86)} 'Lily Workbench') }
foreach ($d in $installDirs) { Backup-Remove $d }
# 用户可能把 Lily 装到过自定义位置（比如 D 盘），甚至装过多次；
# 从三个线索源找出所有实际安装目录：
#  1) 注册表卸载项里的 InstallLocation / DisplayIcon（第 2 步卸载前已抓取）
#  2) 快捷方式指向的目标程序位置（此时快捷方式还没删）
#  3) 每个本地磁盘的根目录 / Program Files / Programs 下名字匹配的文件夹
$extraDirs = New-Object System.Collections.Generic.List[string]
foreach ($app in $apps) {
  if ($app.InstallLocation) { $extraDirs.Add([string]$app.InstallLocation) }
  if ($app.DisplayIcon) {
    $icon = ([string]$app.DisplayIcon).Split(',')[0].Trim('"').Trim()
    if ($icon) { $extraDirs.Add((Split-Path $icon -Parent)) }
  }
}
$shortcutDirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu')
)
$wsh = New-Object -ComObject WScript.Shell
foreach ($dir in $shortcutDirs) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Recurse -Force -Filter '*.lnk' -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match 'Lily Workbench|智能工作台' } |
    ForEach-Object {
      $t = $null
      try { $t = $wsh.CreateShortcut($_.FullName).TargetPath } catch {}
      if ($t -and ($t -match $namePattern)) { $extraDirs.Add((Split-Path $t -Parent)) }
    }
}
foreach ($drv in @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
  $droot = [string]$drv.Root
  if ($droot -notmatch '^[A-Za-z]:\\$') { continue }
  $bases = @($droot,
    (Join-Path $droot 'Program Files'),
    (Join-Path $droot 'Program Files (x86)'),
    (Join-Path $droot 'Programs'))
  foreach ($base in $bases) {
    if (-not (Test-Path -LiteralPath $base)) { continue }
    Get-ChildItem -LiteralPath $base -Directory -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match $namePattern } |
      ForEach-Object { $extraDirs.Add($_.FullName) }
  }
}
foreach ($d in @($extraDirs | Sort-Object -Unique)) {
  if (-not $d) { continue }
  if ($d -match '^[A-Za-z]:\\?$') { continue }  # 护栏：绝不删磁盘根目录
  if (-not (Test-Path -LiteralPath $d)) { continue }
  # 护栏：目录名得匹配 Lily，或者目录里有 Electron 应用的标志文件，才敢删
  $leafOk = (Split-Path $d -Leaf) -match $namePattern
  $marker = Test-Path -LiteralPath (Join-Path $d 'resources\app.asar')
  if ($leafOk -or $marker) { Backup-Remove $d }
}
# 安装器/更新器在临时目录的残留（纯缓存，直接删不备份）
if ($env:TEMP) {
  Get-ChildItem -LiteralPath $env:TEMP -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $namePattern } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host "  完成。"

# ------------------------------------------------------------
Write-Step "第 4 步：删除桌面和开始菜单快捷方式"
# $shortcutDirs 在第 3 步已定义（先借快捷方式定位安装目录，再删快捷方式）
foreach ($dir in $shortcutDirs) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Recurse -Force -Filter '*.lnk' -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match 'Lily Workbench|智能工作台' } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force
      Write-Host ("  已删除: " + $_.FullName)
    }
}
Write-Host "  完成。"

# ------------------------------------------------------------
Write-Step "第 5 步：清理注册表残留和开机自启项"
# 卸载器没删干净的卸载列表项
foreach ($root in $uninstallRoots) {
  Get-Item ($root.TrimEnd('*') + '*') -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (($p.DisplayName -match $namePattern) -or ($_.PSChildName -match $namePattern)) {
      Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host ("  已删除注册表项: " + $_.Name)
    }
  }
}
# 应用自己的注册表配置
foreach ($k in @('HKCU:\Software\Lily Workbench', 'HKCU:\Software\lily-workbench', 'HKCU:\Software\cn.lilywb.workbench', 'HKCU:\Software\智能工作台')) {
  if (Test-Path $k) {
    Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ("  已删除注册表项: " + $k)
  }
}
# 防火墙规则（应用首次联网时 Windows 弹窗产生的；需要管理员权限，没有就跳过）
try {
  $fwFilters = @(Get-NetFirewallApplicationFilter -ErrorAction Stop | Where-Object { $_.Program -match $namePattern })
  foreach ($f in $fwFilters) {
    $rules = @($f | Get-NetFirewallRule -ErrorAction SilentlyContinue)
    foreach ($rule in $rules) {
      Remove-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue
      Write-Host ("  已删除防火墙规则: " + $rule.DisplayName)
    }
  }
} catch {
  Write-Host "  跳过防火墙规则清理（需要以管理员身份运行）。" -ForegroundColor Yellow
}
# 开机自启项
foreach ($rk in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run')) {
  $props = Get-ItemProperty $rk -ErrorAction SilentlyContinue
  if (-not $props) { continue }
  foreach ($prop in $props.PSObject.Properties) {
    if ($prop.Name -match '^PS' ) { continue }
    if (($prop.Name -match $namePattern) -or ([string]$prop.Value -match $namePattern)) {
      Remove-ItemProperty -Path $rk -Name $prop.Name -ErrorAction SilentlyContinue
      Write-Host ("  已删除自启项: " + $prop.Name)
    }
  }
}
Write-Host "  完成。"

# ------------------------------------------------------------
if ($RemoveDocuments) {
  Write-Step "第 6 步：删除文档目录里的工作空间数据（已先备份）"
  $docs = [Environment]::GetFolderPath('MyDocuments')
  if ($docs) {
    Backup-Remove (Join-Path $docs 'Lily Workbench')
    Backup-Remove (Join-Path $docs 'Lily Apps')
  }
  Write-Host "  完成。"
} else {
  Write-Step "第 6 步：按你的选择，保留文档目录（文档\Lily Workbench、文档\Lily Apps）"
}

# ------------------------------------------------------------
Write-Host ""
Write-Host "============================================================"
Write-Host " 卸载完成"
Write-Host "============================================================"
Write-Host (" 共删除 " + $removed.Count + " 个目录/文件。")
if (Test-Path -LiteralPath $backupRoot) {
  Write-Host (" 备份位置: " + $backupRoot)
  Write-Host " 确认一切正常后，可以手动删除这个备份文件夹。"
}
if ($failed.Count -gt 0) {
  Write-Host ""
  Write-Host " 以下路径删除失败（一般是文件被占用）:" -ForegroundColor Yellow
  foreach ($f in $failed) { Write-Host ("   " + $f) -ForegroundColor Yellow }
  Write-Host " 请重启电脑后再运行一次本脚本。" -ForegroundColor Yellow
  exit 2
}
exit 0
