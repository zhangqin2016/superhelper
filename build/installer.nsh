; Legacy-identity cleanup (改名遗留): the product used to ship under NSIS appId
; com.company.ai-super-terminal ("AI Super Terminal" / "智能助手" / "智能工作台").
; The rename to cn.lilywb.workbench makes NSIS treat old and new as SEPARATE
; products installed side by side; the old binaries pass local license checks
; but speak a dead protocol ("licensed but never works" via stale shortcuts).
; On every new install, silently run the OLD product's own uninstaller when its
; uninstall registry key exists (per-user first, then per-machine). Best-effort:
; any failure just proceeds with the normal install.
!macro _lilyUninstallLegacyFromKey ROOT_HKEY
  ClearErrors
  ReadRegStr $0 ${ROOT_HKEY} "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.company.ai-super-terminal" "QuietUninstallString"
  ${if} ${Errors}
  ${orif} $0 == ""
    ClearErrors
    ReadRegStr $0 ${ROOT_HKEY} "Software\Microsoft\Windows\CurrentVersion\Uninstall\com.company.ai-super-terminal" "UninstallString"
    ${ifNot} ${Errors}
    ${andif} $0 != ""
      StrCpy $0 `$0 /S`
    ${endif}
  ${endif}
  ${if} $0 != ""
    DetailPrint "Removing legacy installation (pre-rename product)..."
    ; _?= is not set, so ExecWait returns immediately for NSIS uninstallers
    ; that copy themselves to %TEMP%; give the copy a moment to detach files.
    nsExec::Exec `"$SYSDIR\cmd.exe" /C $0`
    Pop $1
    Sleep 2000
  ${endif}
!macroend

!macro customInit
  Push $0
  Push $1
  StrCpy $0 ""
  !insertmacro _lilyUninstallLegacyFromKey HKCU
  StrCpy $0 ""
  !insertmacro _lilyUninstallLegacyFromKey HKLM
  Pop $1
  Pop $0
!macroend

; Sets $0 = 1 if any Lily Workbench window/helper process is running, else 0.
!macro _lilyDetectRunning
  StrCpy $0 0
  nsExec::ExecToStack `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq LilyWorkbench.exe" /FO CSV | "$SYSDIR\find.exe" /I "LilyWorkbench.exe"`
  Pop $1
  Pop $2
  ${if} $1 == 0
    StrCpy $0 1
  ${endif}
  nsExec::ExecToStack `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq Lily Workbench.exe" /FO CSV | "$SYSDIR\find.exe" /I "Lily Workbench.exe"`
  Pop $1
  Pop $2
  ${if} $1 == 0
    StrCpy $0 1
  ${endif}
!macroend

; Force-terminate Lily: the app process tree (both exe names, /T kills children),
; PLUS anything running from the install dir — the bundled engine/runtime (node,
; opencode, python helpers) that Lily spawns can outlive the main window and hold
; a lock on the install folder, which is what blocks the file replacement.
!macro _lilyForceKill
  DetailPrint "Closing Lily Workbench before installing..."
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "Lily Workbench.exe" /T /F`
  Pop $1
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "LilyWorkbench.exe" /T /F`
  Pop $1
  ; Path-based sweep (Win11 has no wmic): kill every process whose image lives
  ; under $INSTDIR. `Where-Object Path -Like` avoids $_ so NSIS won't mangle it.
  nsExec::Exec `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Process | Where-Object Path -Like '$INSTDIR\*' | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $1
  Sleep 1200
!macroend

!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  Push $3

  !insertmacro _lilyDetectRunning
  ${if} $0 == 1
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Lily Workbench is running. Click OK to close it and continue setup, or Cancel to exit setup." /SD IDOK IDOK lilyDoKill
    Quit

    lilyDoKill:
      StrCpy $3 0
      lilyKillLoop:
        !insertmacro _lilyForceKill
        !insertmacro _lilyDetectRunning
        ${if} $0 == 0
          Goto lilyKilled
        ${endif}
        IntOp $3 $3 + 1
        ${if} $3 < 5
          Goto lilyKillLoop
        ${endif}
        ; Still alive after repeated force-kills (usually an elevation mismatch:
        ; the app was started as admin but setup is running as the user).
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Lily Workbench could not be closed automatically. Please close it manually (or end 'Lily Workbench' in Task Manager), then click Retry." /SD IDCANCEL IDRETRY lilyDoKill
        Quit
      lilyKilled:
  ${endif}

  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
