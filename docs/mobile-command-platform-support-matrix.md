# Lily Mobile Command Pro Platform Evidence Matrix

## 1. Meaning Of Support

Status: **production platform evidence-needed** as of 2026-07-14. This matrix records verified, unverified, and required degradation for production platform support; it does not authorize release.

Phase 1 web demo note: the current demo core is usable for phone command, image attachment, projection, interrupt, history, and pairing management. See [Mobile Command Current Demo Status](mobile-command-current-demo-status.md). That demo evidence does not by itself prove native mobile support, background behavior, push, WebRTC/TURN, screen observation/control, OS input injection, clipboard, voice, or production platform support.

- `verified`: exercised in a representative environment with recorded evidence for the stated scope.
- `unverified`: not exercised end-to-end; it must not be advertised as supported.
- `blocked`: a known missing prerequisite prevented verification.
- `degrade`: behavior required when an unverified/blocked capability is encountered.

No iOS native, Android native, or full mobile PWA device/browser production matrix was executed. No Windows/Linux desktop device/VM was executed. macOS capture/input evidence is limited as recorded in [the OS spike](mobile-command-os-helper-spike.md).

## 2. Pair Matrix

The status applies to production platform claims for every capability column below; `Chat Only` is a required design fallback. The separate Phase 1 web demo is tracked in [Mobile Command Current Demo Status](mobile-command-current-demo-status.md).

| Desktop + client | Command | Push | Background upload | Lily observe/control | Desktop observe/control | Clipboard | Keyboard/IME | File share/camera | Reconnect/permissions | Exact downgrade |
|---|---|---|---|---|---|---|---|---|---|---|
| Windows + iOS native | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | Feature-disabled Live/native actions; Chat Only design fallback |
| Windows + Android native | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | Feature-disabled Live/native actions; Chat Only design fallback |
| Windows + PWA | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | No native/background assumptions; Chat Only design fallback |
| macOS + iOS native | unverified | unverified | unverified | blocked | blocked | unverified | blocked | unverified | blocked | Electron capture produced no source while display slept; CGEvent permission false; revoke control and use Chat Only |
| macOS + Android native | unverified | unverified | unverified | blocked | blocked | unverified | blocked | unverified | blocked | Same limited desktop evidence; feature-disable Live/control and use Chat Only |
| macOS + PWA | unverified | unverified | unverified | blocked | blocked | unverified | blocked | unverified | blocked | Same limited desktop evidence; no native capability assumption; use Chat Only |
| Linux + iOS native | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | Feature-disabled Live/control/native actions; Chat Only design fallback |
| Linux + Android native | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | Feature-disabled Live/control/native actions; Chat Only design fallback |
| Linux + PWA | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | unverified | No portal/native/background assumption; Chat Only design fallback |

## 3. Verified Facts And Non-Claims

| Area | Evidence status |
|---|---|
| macOS Electron capture API availability | verified only that Electron 41 exposed the API on macOS 26.4.1 arm64 |
| macOS usable Electron frames | not verified; observed failure was 0 sources/empty thumbnails with display asleep |
| ScreenCaptureKit | verified only that the prototype typechecked; runtime capture is unverified |
| CGEvent input | verified permission probe result `false`; authorized input/control is not supported by this evidence |
| Windows/Linux desktop capability | unverified due to no device/VM |
| Phase 1 web demo core | implemented for command, image attachment, projection, interrupt, history, and pairing management; see current demo status |
| Production mobile command/push/upload/share/camera/reconnect matrix | unverified due to no full real-device/platform matrix |
| ASR | candidate APIs documented, but all production performance and privacy thresholds unverified |

Unsupported or unverified capability must be absent/disabled in release metadata and UI. Failure must be explicit, must not grant authority, and must preserve today's local Lily behavior.

## 4. Closure Requirements

Platform support requires the OS/helper experiment and signing artifacts in [the OS decision gate](mobile-command-os-helper-decision.md), the mobile device/native/PWA test matrix, network/reconnect and background tests, permissions/revocation tests, and ASR evidence in [the ASR decision gate](mobile-command-asr-decision.md). Each claimed pair must record exact OS/device/app/browser versions and the applicable test-case evidence.

The visual system is also blocked and is not created by this evidence task: high-fidelity screens, brand-derived token proof, required state screenshots, accessibility QA, and explicit design approval are missing. MC-SPEC-022 remains `evidence-needed`.
