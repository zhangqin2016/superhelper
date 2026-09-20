# Windows native acceptance - 2026-09-20

## Scope and environment

Real native Electron source client, package 0.1.178, Windows, existing local
profile and configured real model/providers. UI operated with native desktop
automation, not a mocked renderer. Synthetic input/output only, workspace
`D:\aicode\images\output`. This is NOT signed installer/update acceptance or
proof that every model, permission mode, runtime pack and external service works.
No production deployment, publishing, model downgrade, context reduction or
permission-setting change was performed.

## Completed native cases

| Case | Evidence | Result |
| --- | --- | --- |
| Office pipeline | Session `72f152ad-3bf3-4c70-8501-eb35dc7a2d59`, turn `turn_5aace3f9-f567-46c0-b151-3b3d1783cccd`; 271345 ms, 35 tools | CSV, XLSX formulas/chart, two-page DOCX/PDF, three-slide PPTX, Markdown and PNG produced; terminal completed; persisted final visible after restart |
| Media pipeline | Same session, turn `turn_1516e9f0-da74-4466-be4c-e315501880ad`; 258735 ms, 31 tools | Real DashScope image/speech/video returned; corrected blue-cup image seen; video playback visibly changed frames; audio playback UI responded |
| Failure explanation | Old interrupted/restarted turn `turn_973202b6-97e9-4293-b06a-c4958c188c84` | Native renderer reload displayed durable outcome-unknown explanation after fix, rather than only generic failure |
| Explicit stop | Session `e6d53567-028a-4ce2-b34c-6fc53201b678`, turn `turn_90ba20cb-50bf-444a-94ae-2b41f7239baf` | Direct system `soffice.exe --version` opened interactive console and stalled; native Stop made session idle/interrupted and child soffice exited |
| Restart and continue | Same long-task session; continuation `turn_4a96e38e-e40c-4196-a55f-ba2d2886d0b6` | Original 12-store requirements retained; existing progress checked; real batch execution resumed |

Office output: `qa-win-20260920-r2`. Media output:
`qa-win-media-20260920`. Native media provider was DashScope, NOT proof of Lily
GPU-hosted generation. Audio intelligibility was not heard/verified. Agent-made
verification counts are not independent proof of every acceptance criterion.

## Defects found and source fixes

- Windows PowerShell default pipeline corrupts non-ASCII media JSON: reproduced
  question-mark image and invalid TTS text. Three media CLIs now accept UTF-8
  `--input-file` (including BOM), retaining original stdin. Skill guides/manifests
  use file transport on Windows. Localhost transport tests exercise actual child
  processes and actual PowerShell character loss. New transport still needs an
  additional end-to-end real-provider UI run.
- Durable dispatch failure explanation lost in richer history projection and
  hidden by renderer narrative policy: retain host recovery evidence and display
  those terminal reasons without dropping partial work or tools. Native reload
  confirmed the explanation is visible.
- Bare Chinese `不联网` misclassified as affirmative external research: explicit
  research classification respects prohibition; genuine offline external-fact
  claims still require evidence. Regression tests preserve positive research.
- Managed LibreOffice conversion/render and health probes now disable Windows
  printer enumeration/default printer lookup in CHILD environment only. This
  does not change system printing settings or disable explicit user printing.
- Direct absolute `soffice.exe --version/--help/-h` informational commands can
  allocate a waiting console. Narrow Windows plugin chooses existing sibling
  `soffice.com`; unknown paths, conversion and printing remain unchanged. Helper
  is separate from plugin exports to respect OpenCode's factory loader. Native
  CLI subprocess test passes; updated plugin still requires final UI recheck.
- Earlier changes in this working tree also cover exact-parent final-history
  recovery, media delivery without fabricated user turns, delivery ownership and
  document evidence guidance. Focused tests passed; not every failure injection
  was reproduced through the desktop.

## Outstanding observations / not accepted

- Long 12-store run is still being observed; final result is not yet accepted.
- Some process narration remains English despite Chinese request and existing
  language guidance. Do not claim language behavior fixed.
- Failed/replaced image attempt remains among hoisted historical media cards.
  Final corrected image is present, but final-media selection UX is not accepted.
- Old generated runtime `bin/soffice.cmd` points to absent bundled LibreOffice;
  the model recovered via installed system LibreOffice. Build/runtime shim
  lifecycle needs separate validation before Windows packaging.
- A session switch briefly showed stale previous-batch state while durable
  events/outputs advanced. Further live UI lifecycle verification is required.
- No overnight endurance, network-loss/power-loss native trial, all-provider
  matrix, installer/updater, speech microphone, collaboration, runtime-pack
  download/install, scheduled execution or every role/skill acceptance claimed.

## Follow-up UI skill trial (23:12 local)

Isolated source client PID 35080, profile under
`lily-native-large-history-YOybl1/profile`, session
`c993e211-3ceb-4467-8784-999f2dfc5d0e` named
`Windows技能验收-表格文档-0920`. The 2GiB archive remains present; this is a
new UI-created conversation. Existing 29 skills were inspected through the UI,
without changing permission mode or granting permissions automatically.

Submitted a synthetic four-store analysis through the composer: formula/chart
XLSX, one-page Chinese DOCX and matching PDF, no network or printing, output
confined to `qa-capabilities-0920`. Expected net sales 520,000 and gross profit
201,000. Delivery is NOT accepted yet.

Observed blockers:
- Permission cards show only generic labels (`运行命令` / external directory),
  not the command or directory. User cannot assess the requested scope directly.
- Reading the enabled office-intent and document-verification SKILL.md files
  produced two external-directory permission requests. Actual read completion
  remains unverified; do not classify this as successful skill use or no skill use.
- A literal system `soffice.exe --version; Write-Output ...` spawned a visible
  console. The process command line independently confirms the GUI executable.
  The generated engine config includes windows-office-cli.js, so registration
  alone does not prove hook effectiveness. Root cause remains open.
- During permission wait, Bash cards continued showing running time over 150s,
  while the main turn correctly said waiting for confirmation. This is not
  evidence of model latency or successful command completion.
- Startup watchdog reported 5,565ms main lag. No startup responsiveness acceptance.

The user was asked to handle permission cards manually. UI automation did not
approve/deny them or change security settings. No output files or end-to-end
skill value are certified from this blocked run. Real profile was not modified.

## Earlier regression evidence

Passed focused checks: runtime-health, windows-office-cli (including native
LibreOffice CLI version), media-input-encoding, media-generation-skills,
external-fact-grounding, semantic-external-fact-contract,
opencode-conversation-source, turn-narrative-policy, turn-view-model,
opencode-sdk-session, opencode-session-policies, opencode-conversation-adapter,
task-long-progress, task-continuity-integration (7), task-acceptance-recovery,
task-execution-progress, turn-loop-guard, media-result-tracker,
document-delivery-gate, answer-evidence-finalizer, session-runtime-store,
render-document-profile-uri, agent-guide-headroom, skill-catalog,
architecture-boundaries, git diff --check.

Office conversion guard initially could not find LibreOffice; rerun with the
installed system program directory passed. Generic render-document check skipped
Office rendering because LibreOffice is not bundled; native document tasks did
perform real system-LibreOffice conversion. Full test suite not executed.

## Follow-up: native office fixes and retest

- Informational CLI hook failure was the `--version;` token boundary, not a
  missing plugin registration. Real bundled engine probe now rewrites to the
  existing sibling soffice.com and completes in 633ms; UI replay took 0.7s.
- Permission cards now retain operation command/path/patterns through the reducer
  and render them as text. Focused reducer/model/card tests pass. Native approval
  card acceptance remains open; automation did not change permissions.
- Vendored XLSX recalc has no Windows subprocess timeout and uses the non-Windows
  macro profile path. A real task stalled there. Vendor code is untouched; the
  first-party helper recalculates a separate copy and rejects missing caches,
  lost formulas and Excel errors. This does not prove all workbook fidelity.
- LibreOffice crashed with rc=3221226505 when its private profile was nested in
  the deep output path. The same workbook succeeded in a short output path.
  Moving only the temporary profile outside the delivery tree made the original
  failing deep path succeed. Native regression covers deep output paths, cached
  arithmetic, original hash preservation and division-by-zero rejection.
- UI task in the isolated 2GiB profile was stopped, then resumed through the
  composer. It performed a new conversion (5.3s), rendered PDF/DOCX/XLSX
  (0.9/6.1/5.9s), used vision and delivered a final response. Independent PDF and
  spreadsheet page inspection found intact Chinese, tables and chart. Total
  net sales 520000 and gross profit 201000 agree with the synthetic inputs.
- The live app still read its old installed skill copy; therefore this is native
  conversion/render acceptance, NOT fresh-install acceptance of the new skill
  guidance. The independent-recalc directory is our test evidence, not an agent
  deliverable. No customer files or permission settings were changed.
- Passed: xlsx-recalc native, office-conversion-guard (with the explicit installed
  LibreOffice directory), render-document-profile-uri, turn-action-prompt-cards,
  git diff --check. Default office guard first failed due to absent executable
  discovery, then passed with the explicit runtime path. Full suite, packaged
  release, media providers, skill refresh, automatic verification retry quality
  and arbitrary long-task acceptance are still open.
