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

!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2

  retryCloseLilyWorkbench:
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

    ${if} $0 == 1
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Lily Workbench is running. Click OK to close it and continue setup, or Cancel to exit setup." /SD IDOK IDOK closeLilyWorkbench
      Quit

      closeLilyWorkbench:
        DetailPrint "Closing Lily Workbench before installing..."
        nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "LilyWorkbench.exe" /T /F`
        Pop $1
        nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "Lily Workbench.exe" /T /F`
        Pop $1
        Sleep 1500

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

        ${if} $0 == 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Lily Workbench could not be closed. Please close it manually, then click Retry." /SD IDCANCEL IDRETRY retryCloseLilyWorkbench
          Quit
        ${endif}
    ${endif}

  Pop $2
  Pop $1
  Pop $0
!macroend
