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

; Reap bundled helpers that can keep files below $INSTDIR locked. The updater
; itself and its ancestor chain are protected so an in-app setup never kills
; its own launcher while cleaning up an interrupted/crashed app session.
!macro _lilyReapInstallProcesses
  Push $R8
  Push $R9
  System::Call 'kernel32::GetCurrentProcessId() i .s'
  Pop $R9
  nsExec::Exec `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "$$prot=@{}; $$p=[int]$R9; while($$p -and -not $$prot.ContainsKey($$p)){ $$prot[$$p]=$$true; $$pr=Get-CimInstance Win32_Process -Filter ('ProcessId='+$$p) -ErrorAction SilentlyContinue; if($$pr){$$p=[int]$$pr.ParentProcessId}else{break} }; Get-CimInstance Win32_Process | Where-Object { ($$_.ExecutablePath -and $$_.ExecutablePath -like '$INSTDIR\*') -and (-not $$prot.ContainsKey([int]$$_.ProcessId)) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $R8
  Sleep 1200
  Pop $R9
  Pop $R8
!macroend

; Force-terminate Lily WITHOUT killing this installer. Two self-kill traps the
; earlier /T version fell into: (1) in-app updates launch setup as a DESCENDANT
; of "Lily Workbench.exe", so `taskkill /T` (kill children) took setup down too;
; (2) a blind install-dir sweep can match the setup process itself. So:
;  - taskkill the app by image name only (NO /T) — kills the app windows but not
;    their descendants, so a setup launched under the app survives;
;  - reap the bundled engine/runtime children that hold the install-dir lock
;    (node/opencode/python) via a path sweep that EXCLUDES this installer's PID
;    and its whole ancestor chain. Win11-safe (CIM Win32_Process, no wmic).
!macro _lilyForceKill
  Push $R8
  DetailPrint "Closing Lily Workbench before installing..."
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "Lily Workbench.exe" /F`
  Pop $R8
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "LilyWorkbench.exe" /F`
  Pop $R8
  !insertmacro _lilyReapInstallProcesses
  Pop $R8
!macroend

!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  Push $3

  ; electron-updater launches setup before app.quit() runs. In update mode,
  ; first let the normal before-quit path save sessions and terminate the
  ; OpenCode/runtime process tree. The old eager force-kill skipped that path,
  ; leaving locked files and making the app disappear without an installed
  ; replacement. After ten seconds the existing force-close fallback remains.
  ${if} ${isUpdated}
    StrCpy $3 0
    lilyGracefulQuitLoop:
      !insertmacro _lilyDetectRunning
      ${if} $0 == 0
        !insertmacro _lilyReapInstallProcesses
        Goto lilyKilled
      ${endif}
      IntOp $3 $3 + 1
      ${if} $3 < 20
        Sleep 500
        Goto lilyGracefulQuitLoop
      ${endif}
  ${endif}

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
