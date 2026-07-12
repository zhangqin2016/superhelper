# Lily Mobile Command Pro OS Helper Decision Gate

## Decision

Status: **evidence-needed**. No production OS helper is selected. MC-ADR-005, MC-ADR-006, and MC-ADR-007 remain `proposed`.

The 2026-07-12 evidence proves only limited macOS API availability and a denied input-permission state. It does not prove an operable, performant, signed, packaged capture/input path. Windows and Linux remain unverified.

## Platform Outcomes

| Platform | Actual result | Current capability classification | Required degradation |
|---|---|---|---|
| Windows | No device/VM experiment | unverified | Do not advertise Live; Chat Only |
| macOS | Electron API exists but asleep display returned 0 sources/empty thumbnails; ScreenCaptureKit typechecked only; CGEvent permission was false | capture/input unverified; control unavailable in observed permission state | Explicit permission/unavailable state, revoke control, Chat Only |
| Linux | No device/VM experiment | unverified | Do not advertise Live; Chat Only |

## Acceptance And Blocking Evidence

The binding numeric thresholds and raw observation IDs are in [the OS helper spike](mobile-command-os-helper-spike.md). Acceptance additionally requires a narrow versioned IPC that rejects unknown/malformed commands; executable discovery from the packaged app; signature verification before launch; OS permission preflight and revocation; sandbox/least privilege; helper-app update coupling; bounded restart with immediate control revocation; and explicit unsupported-environment handling.

Blocking artifacts are real Windows/Linux environments, an awake macOS permission cycle, runtime ScreenCaptureKit frames, authorized CGEvent/IME tests, full Xcode, a valid signing identity, notarization credentials, signed packaged helpers, multi-monitor/DPI fixtures, performance/stability results, and crash/abuse tests.

## Provisional IPC Constraint, Not A Technology Choice

Any future helper must accept only an allowlisted, versioned message set (`move`, `click`, `scroll`, `key`, `text`, `health`, `close`) with request ID, authorized surface ID, permission epoch, bounded normalized coordinates, and payload limits. It must never accept shell text or paths. Every response must echo the request ID and return a stable result/error. Unknown version, signature failure, malformed input, helper crash, permission loss, topology change, or stale epoch revokes control and leaves local Lily usable.

## Next Reproducible Experiment

Run the procedure in [OS helper spike §6](mobile-command-os-helper-spike.md#6-next-reproducible-experiment) on each claimed platform, archive command revisions and raw metrics, then compare candidates against the predeclared thresholds. Only then may the relevant ADR select a helper and record human approval/date.
