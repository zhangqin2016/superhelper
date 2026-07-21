# 2026-07-21 — "Activated but unusable" full-chain hardening

## Why

Users reported "activated/logged in but can't use": `Permission denied` errors,
`Connection to the model service was interrupted`, silently signed-out accounts,
and "diagnostics all green yet broken". User directive: **be top-tier like Cursor
— if the model API works, nothing else may block the user; auto-repair
everything; no hardcoding, judgment goes to the model; fail open.**

A three-way audit (send chain / auth+license / engine+diagnostics) found the
gaps; this note records what was fixed and the design rules that emerged.

## What changed (all on branch `feat/opencode-engine`)

P0 — send chain & auth:

- `src/main/turn-start-guard.js` (new): `guardTurnStart()` wraps every
  `_startTurn` call so ANY throw becomes a friendly failed turn instead of a
  stuck session; `startStuckPhaseGuard()` sweeps every 30s and recovers turns
  stuck in `starting` >4min / `finalizing` >2min.
- `account-manager.js`: `isTransientRefreshFailure()` — network/408/429/5xx
  refresh failures no longer clear the account (no silent sign-out); only
  401/403/404 mean real logout.
- `license-manager.js`: `requireValidLicenseFresh()` — STALE/INSUFFICIENT
  entitlement errors trigger one bounded (8s) refresh and re-judge before
  failing; CLOCK_ROLLBACK self-heals `lastSeenTime` when the token is still
  valid (rollback can't extend an expired token, so blocking valid users was
  pure collateral damage).
- `ipc-assistant.js`: all four send paths use `requireValidLicenseFresh()`.

P1 — engine & recovery:

- `runtime/opencode-sdk-session.js`: `withCallTimeout()` + `SDK_CALL_TIMEOUTS_MS`
  bound every engine control-plane HTTP call (health 5s, get/abort 10s,
  messages 15s, promptAsync 30s). Reject-style timeout with a settled-tracker
  `.catch(()=>{})` sink (no unhandledRejection) and deliberately NOT unref'd
  (an empty event loop would exit the process early). Steer fallback rides the
  promptAsync 30s bound.
- `agent-runner.js`: ENGINE_UNAVAILABLE regex extended to serve-startup
  failures (`did not report a listening port`, `session.create failed`, …) so
  they enter the rescue path.
- `app-watchdog.js`: module-level `activeWatchdog` + `getLastWatchdogSnapshot()`
  — support-diagnostics' call was a dangling reference before.
- `ipc-utils.js`: `checkSendDiskSpace()` pre-send guard (<100MB free →
  `LOW_DISK_SPACE`, fail open when statfs is unavailable).

P2 — detection & UX:

- `src/main/startup-health.js` (new): 4s after window load, runs the local half
  of diagnostics (probeModel:false); error items push an `app:startup-health`
  banner with a "go fix" button → diagnostics page.
- Failure bubbles get a one-click "diagnose & repair" action
  (`message.js` → `runSupportDiagnosticsNow`).
- `src/main/mac-legacy-installs.js` (new): detects same-signature old .app
  installs (multi-install config drift), offers one-time `shell.trashItem`
  cleanup (reversible).
- `turn-orchestrator.js` telemetry gate: `reportModelFailureDiagnostic` now
  reports EVERY failure class including unclassified (`UNCLASSIFIED_FAILURE`) —
  a model-only gate blinds us to exactly these bugs. User-interrupted turns
  never reach the failed branch, so no abort spam.

## Design rules (reusable)

- A gate that only reports the errors you already understand hides the ones
  you don't. Telemetry and diagnostics must default to open.
- Transient ≠ fatal: any auth/entitlement decision based on a network answer
  must classify the answer's reliability before acting on it.
- Every await on the engine control plane needs a bound; an unbounded HTTP
  call is a future "stuck forever" report.
- Reversible cleanup only (trash, not delete) for user-install detection.
- Line ratchet: `turn-orchestrator.js` is at 1968/1968 — edits must be
  line-neutral; new logic goes into new modules (all <500 lines).

## Tests

`test-turn-start-guard`, `test-account-resilience`, `test-startup-health`,
`test-opencode-sdk-session`, `test-mac-legacy-installs`,
`test-license-clock-rollback` + regressions (`test-turn-orchestrator*`,
`test-turn-error-classify`, `test-tool-call-rescue`, `test-license-update`,
`test-windows-legacy-installs`). Full suite baseline 465/468 with 3 pre-existing
unrelated failures (context-os-beat-e2e, skill-catalog-governance,
turn-article-frame).

## Residual known items (deliberately deferred)

- G2 minor throw points (covered by turn-start guard umbrella), G6 double-send
  race (covered by stuck-phase sweep), G9 watchdog engine dimension, G8 copy
  calibration, D3 signature-rotation fallback.
