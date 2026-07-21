@echo off
setlocal
chcp 65001 >nul
title Lily Workbench Connection Diagnostic

echo Running Lily Workbench connection diagnostics...
echo This may take 1-3 minutes. Please do not close this window.
echo.

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%windows-model-connection-diagnose.ps1"

if not exist "%PS_SCRIPT%" (
  echo ERROR: Could not find "%PS_SCRIPT%".
  echo Please keep this .cmd file in the same folder as windows-model-connection-diagnose.ps1.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -Repair -NoPause
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Diagnostic script exited with code %EXIT_CODE%.
  echo If no zip was created on the Desktop, please send a screenshot of this window.
) else (
  echo Done. Please send the LilyConnectionDiagnostic zip file from the Desktop.
)
echo.
pause
exit /b %EXIT_CODE%
