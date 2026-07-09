@echo off
chcp 65001 >nul
setlocal
title Full Uninstall Lily Workbench

echo ============================================================
echo  Lily Workbench 完全卸载脚本 (Windows 10 / 11)
echo ============================================================
echo.
echo 这个脚本会把本机恢复到尽量接近"从没安装过 Lily"的状态：
echo.
echo  1. 关闭 Lily Workbench 相关进程
echo  2. 调用系统卸载器静默卸载程序本体
echo  3. 清理 AppData / LocalAppData / 安装目录残留
echo  4. 删除桌面和开始菜单快捷方式
echo  5. 清理注册表残留和开机自启项
echo  6. (可选) 删除文档目录里的工作空间数据
echo.
echo 所有被删除的数据目录都会先备份到用户文件夹
echo (C:\Users\你的用户名\lily-uninstall-backup-时间)，
echo 确认没问题后可手动删除备份。
echo.
echo 提示：
echo  - 如果只是想修复模型配置，不要运行这个脚本，
echo    请运行 reset-lily-workbench.bat。
echo  - 如果当初是"为所有用户安装"的，请右键本文件选择
echo    "以管理员身份运行"，否则部分残留清不掉。
echo.

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%full-uninstall-lily-workbench.ps1"

if not exist "%PS1%" (
  echo 缺少文件:
  echo "%PS1%"
  echo.
  echo 请把 full-uninstall-lily-workbench.bat 和
  echo full-uninstall-lily-workbench.ps1 放在同一个文件夹里再运行。
  echo.
  pause
  exit /b 1
)

choice /C YN /M "确认完全卸载 Lily Workbench？"
if errorlevel 2 (
  echo 已取消，没有做任何改动。
  pause
  exit /b 0
)

echo.
echo 文档目录里的 "文档\Lily Workbench" 和 "文档\Lily Apps"
echo 存放的是用户自己的工作空间文件（聊天产出、安装的小应用等）。
choice /C YN /M "是否连这些用户数据也一起删除（删除前会先备份）？"
if errorlevel 2 (
  set "DOC_FLAG="
  echo 将保留文档目录。
) else (
  set "DOC_FLAG=-RemoveDocuments"
  echo 将一并删除文档目录（已备份）。
)

echo.
echo 开始卸载，请不要关闭这个窗口...
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %DOC_FLAG%
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo 完全卸载完成。
  echo 如果 Windows 设置的应用列表里仍显示 Lily Workbench，
  echo 重启电脑后再检查一次即可。
) else if "%EXITCODE%"=="2" (
  echo 卸载基本完成，但有个别文件被占用没删掉。
  echo 请重启电脑后再运行一次本脚本。
) else (
  echo 脚本运行出错，退出码: %EXITCODE%
  echo 请截图这个窗口发给技术支持。
)
echo.
pause
