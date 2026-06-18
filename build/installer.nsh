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
