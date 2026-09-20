# Terminal ownership follow-up

## Scope

Fix the audited normal-idle, history-recovery and health-probe races without
changing model selection, tools, context size or task continuation budgets.
This is a source change, not a published Windows release.

## Ownership

- `opencode-execution-scope` captures an execution epoch, start time and engine
  identity. New submissions and safe replay attempts receive a fresh epoch.
- `opencode-idle-completion` owns asynchronous idle confirmation and probing;
  the session class remains the adapter. Pending completion identity must also
  match, so a superseding observation invalidates an older completion read.
- History reads check ownership before returning or publishing supplemental
  text. The expected prompt is captured before I/O rather than read afterward.
- Health probes have a separate cancellation generation and engine identity.
  Clearing a timer also invalidates its in-flight request.
- Safe replay checks ownership after asynchronous work and before error handling.
  Only the explicit engine-rebuild path permits server replacement within the
  same execution epoch.

## Terminal evidence

Unknown status does not confirm idle. Existing no-progress and health guards
remain active; no unconditional model redispatch is added.
Select the newest non-compaction assistant before examining its text. A newer
error cannot disappear behind older narration. Errors retain a failing payload;
empty latest messages and tool-call steps remain incomplete. Existing parent
closure policy decides whether incomplete work earns continuation. Legacy
messages without finish metadata retain their supported behavior.

## Validation boundaries

The new deterministic terminal-ownership test covers stale status/history/replay
results, replacement completion observations, idle-probe cancellation, pending
questions, supplemental output, latest empty/error/tool messages and duplicate
health loops. Existing session integration tests exercise the fake engine through
normal IPC-adapter behavior. The prior unknown-status-success expectation is
replaced with a status-outage-then-recovery check preserving streamed output.

These tests do not identify the customer's exact failure, prove all providers'
terminal schemas, or constitute installed Windows UI/real-model long-task
acceptance. No claim of complete customer-device remediation is made.

## Native UI follow-up

Tested the actual Electron desktop with the isolated 2 GiB history profile,
bundled OpenCode 1.18.30 and the configured real model, using Windows UI actions.

- Found that a successful sparse engine status map omits idle sessions. Fixed
  the server adapter; malformed/failed status queries still remain unknown.
  The bundled-engine test verifies the sparse contract against the actual binary.
- Read-only spreadsheet task completed in 11 seconds without manual continuation.
- A 72-second, 14-step report task completed but exposed an Office-only delivery
  gate replacing Markdown/CSV output. Text documents now receive structural
  checks without Office rendering requirements. Missing content certification
  remains explicit; file existence alone is not verified delivery.
- After the fix, source-to-report generation, readback and delivery completed in
  51 seconds / 13 steps. Final tables, file links and the content-verification
  caveat remained visible. Source workbook was not modified.
- Stop showed interrupted. A real network outage then produced an explicit API
  connection failure. Clicking Retry after connectivity recovered completed the
  task in 19 seconds / 7 steps. This is not proof of automatic outage recovery.
- Empty abort/failure history copies exposed different engine/host message IDs.
  A separate history-ownership module binds assistants via their explicit engine
  parent user ID. It does not infer ownership from empty text or elapsed time;
  missing parent metadata retains the existing fallback. Cross-role metadata
  attachment is rejected. Focused conversation/adapter tests passed.

Both complete gate reruns passed 418 scripts, including the rerun after
the parent-identity fix. This native evidence covers
minute-scale multi-step work, not an hours-long customer task or every skill.
