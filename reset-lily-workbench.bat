@echo off
chcp 65001 >nul
title Full Reset Lily Workbench

echo ============================================================
echo  Lily Workbench 强清理脚本
echo ============================================================
echo.
echo 这个脚本会先备份，再删除 Lily Workbench 的本机数据：
echo - 登录/激活状态、模型配置、会话、缓存、日志
echo - Lily 自己的 AppData / LocalAppData 配置目录
echo.
echo 不会删除客户文档、默认工作区、已安装工作区应用、生成文件。
echo.
echo 备份会放到桌面 lily-workbench-backup-时间 文件夹。
echo 清理后需要重新打开 Lily Workbench 并重新激活/登录。
echo.
choice /C YN /M "确认继续清理 Lily Workbench 应用配置和缓存？"
if errorlevel 2 (
  echo 已取消。
  pause
  exit /b 0
)

echo 正在关闭 Lily Workbench...
taskkill /F /IM "Lily Workbench.exe" >nul 2>nul
taskkill /F /IM "lily-workbench.exe" >nul 2>nul
taskkill /F /IM "智能工作台.exe" >nul 2>nul
taskkill /F /IM "opencode.exe" >nul 2>nul
taskkill /F /IM "lily-workbench-helper.exe" >nul 2>nul
taskkill /F /IM "node.exe" /FI "WINDOWTITLE eq Lily Workbench*" >nul 2>nul

echo.
echo 正在备份并清理 Lily Workbench 本机数据...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue'; $ProgressPreference='SilentlyContinue';" ^
  "$backup = Join-Path ([Environment]::GetFolderPath('Desktop')) ('lily-workbench-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'));" ^
  "$paths = New-Object System.Collections.Generic.List[string];" ^
  "$names = @('lily-workbench','Lily Workbench','智能工作台','ai-super-terminal','terminal-chat-claude');" ^
  "foreach ($n in $names) { if ($env:APPDATA) { $paths.Add((Join-Path $env:APPDATA $n)) } }" ^
  "foreach ($n in $names) { if ($env:LOCALAPPDATA) { $paths.Add((Join-Path $env:LOCALAPPDATA $n)) } }" ^
  "New-Item -ItemType Directory -Force -Path $backup | Out-Null;" ^
  "$found = $false;" ^
  "$seen = @{};" ^
  "foreach ($raw in $paths) {" ^
  "  if (-not $raw) { continue }" ^
  "  $p = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($raw));" ^
  "  $key = $p.ToLowerInvariant();" ^
  "  if ($seen.ContainsKey($key)) { continue }" ^
  "  $seen[$key] = $true;" ^
  "  if (Test-Path -LiteralPath $p) {" ^
  "    $found = $true;" ^
  "    $leaf = Split-Path $p -Leaf;" ^
  "    if (-not $leaf) { $leaf = 'root' }" ^
  "    $name = $leaf + '-' + ([Math]::Abs($p.GetHashCode()));" ^
  "    Copy-Item -LiteralPath $p -Destination (Join-Path $backup $name) -Recurse -Force;" ^
  "    Remove-Item -LiteralPath $p -Recurse -Force;" ^
  "    Write-Host ('已清理: ' + $p);" ^
  "    $stateBackup = Join-Path (Join-Path $backup $name) 'device-state.json';" ^
  "    if (Test-Path -LiteralPath $stateBackup) {" ^
  "      New-Item -ItemType Directory -Force -Path $p | Out-Null;" ^
  "      Copy-Item -LiteralPath $stateBackup -Destination (Join-Path $p 'device-state.json') -Force;" ^
  "      Write-Host ('已保留设备身份(授权绑定不丢): ' + (Join-Path $p 'device-state.json'));" ^
  "    }" ^
  "  }" ^
  "}" ^
  "if (-not $found) { Write-Host '没有找到 Lily Workbench 用户数据目录。'; }" ^
  "Write-Host ('备份位置: ' + $backup);"

echo.
echo 清理完成。设备身份(device-state.json)已保留，授权绑定不会因清理而丢失。
echo 请重新打开 Lily Workbench，直接新建对话测试即可(一般无需重新激活)。
echo 如果清理后需要恢复旧数据，请把桌面备份目录发给技术人员处理。
pause
