@echo off
setlocal
title Diagnose Lily Model Connection

echo ============================================================
echo Lily Workbench model connection diagnostics
echo ============================================================
echo.
echo This script only reads diagnostics. It does not delete or change files.
echo Keep this .bat file and diagnose-lily-model-connection.ps1 in the same folder.
echo.

set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%diagnose-lily-model-connection.ps1"

if not exist "%PS1%" (
  echo Missing file:
  echo "%PS1%"
  echo.
  echo Please put diagnose-lily-model-connection.bat and diagnose-lily-model-connection.ps1 in the same folder.
  echo.
  pause
  exit /b 1
)

echo Running diagnostics, please wait...
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
  echo Diagnostics failed. Exit code: %EXITCODE%
  echo Please screenshot this window and send it to support.
) else (
  echo Diagnostics finished.
  echo Please send the lily-model-diagnostics-*.zip file from Desktop to support.
)
echo.
pause
