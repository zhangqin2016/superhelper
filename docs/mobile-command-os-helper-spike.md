# Lily Mobile Command Pro OS Helper Spike Evidence

## 1. Result And Evidence Boundary

Status: **evidence-needed**. Evidence was recorded on 2026-07-12; it does not select a production helper.

The only live desktop environment available was macOS 26.4.1 on arm64. Its display was asleep during the Electron capture probe. There was no Windows or Linux device/VM, no complete Xcode toolchain, no valid signing identity, and no notarization credentials. Therefore MC-ADR-005, MC-ADR-006, and MC-ADR-007 remain `proposed`.

Result vocabulary:

- `PASS`: the named command/probe produced the required observation in the stated environment.
- `FAIL`: the probe ran and did not meet the acceptance threshold.
- `BLOCKED`: an identified prerequisite prevented the experiment.
- `UNVERIFIED`: no representative experiment was run; candidate documentation is not a result.

## 2. Predeclared Acceptance Thresholds

Before a platform helper can be selected, a reproducible run on every claimed OS/version must show:

| Area | Acceptance threshold |
|---|---|
| Capture availability | authorized Lily-window and desktop sources enumerate and produce non-empty frames in 100/100 attempts; locked/asleep displays fail explicitly |
| Capture latency | first frame p95 <= 1,000 ms; steady capture input-to-frame p95 <= 150 ms at 1280x720/24 fps |
| Capture resource use | Electron plus helper average CPU <= 20% of one logical core and RSS increase <= 150 MiB over a 30-minute run |
| Input latency | move/click/key injection acknowledgement p95 <= 50 ms over 1,000 events |
| Input correctness | 100% of scoped clicks/keys remain inside the authorized surface; representative US and Chinese IME suites pass |
| Multi-monitor/DPI | 100% coordinate fixtures pass at 100%, 125%, 150%, 200% scaling and topology changes revoke/pause control |
| Permission recovery | denial is detected without injection; granting/revoking permission is reflected without hidden continued control |
| Crash recovery | 100/100 forced helper crashes revoke control; local Lily chat remains usable |
| Stability | zero helper/Electron crashes attributable to capture/input in a 2-hour run |
| Packaging | packaged helper path resolves; artifact signature verifies; macOS notarization or Windows signing verification passes |

## 3. Recorded Environment And Reproduction Sources

| Evidence ID | Environment/source | Command or procedure | Observation |
|---|---|---|---|
| OS-EV-001 | macOS 26.4.1 arm64, Electron 41, display asleep, 2026-07-12 | Electron `desktopCapturer` source/API probe executed in the local spike environment | API existed, but source enumeration returned 0 sources and thumbnails were empty; `FAIL` for usable capture, not evidence that Electron capture is unsupported on an awake display |
| OS-EV-002 | macOS 26.4.1 arm64, 2026-07-12 | ScreenCaptureKit prototype compiler/typecheck probe | API surface typechecked; `PASS` for compile/type availability only; no frame, permission, latency, CPU, packaging, signing, or recovery result |
| OS-EV-003 | macOS 26.4.1 arm64, 2026-07-12 | CoreGraphics event permission probe using `CGEvent.postEvent` path | Permission result was `false`; `FAIL` for authorized input in this environment; no input event was claimed delivered |
| OS-EV-004 | local build environment, 2026-07-12 | Xcode/signing/notarization prerequisite inspection | Complete Xcode, valid signing identity, and notarization credentials were unavailable; packaged-helper proof is `BLOCKED` |
| OS-EV-005 | Windows, 2026-07-12 | Environment inventory | No real Windows device or VM was available; every Windows capture/input/package result is `UNVERIFIED` |
| OS-EV-006 | Linux, 2026-07-12 | Environment inventory | No real Linux device or VM was available; Wayland/X11/portal/input/package results are `UNVERIFIED` |

## 4. Candidate Result Matrix

No cell is an inferred score or winner.

| Platform/candidate | Build/API | Capture/input behavior | Permission | Performance/stability | Packaging/signing | Overall observation |
|---|---|---|---|---|---|---|
| Windows Rust `SendInput` helper | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED; MC-ADR-005 stays proposed |
| Windows Electron `desktopCapturer` | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED; do not advertise observe/control |
| Windows Graphics Capture | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED — OS-EV-005 | UNVERIFIED |
| macOS Electron `desktopCapturer` | PASS — API exists, OS-EV-001 | FAIL — 0 sources/empty thumbnails with display asleep, OS-EV-001 | UNVERIFIED — no awake-display permission cycle | UNVERIFIED — no frames/run | BLOCKED — OS-EV-004 | Evidence insufficient; MC-ADR-006 stays proposed |
| macOS ScreenCaptureKit | PASS — typecheck only, OS-EV-002 | UNVERIFIED — no frame captured | UNVERIFIED | UNVERIFIED | BLOCKED — OS-EV-004 | Typecheck is not runtime support evidence |
| macOS CoreGraphics/CGEvent input | PASS — API probe executable, OS-EV-003 | FAIL — permission false; delivery not attempted/claimed | FAIL — OS-EV-003 | UNVERIFIED | BLOCKED — OS-EV-004 | Input control unavailable in tested permission state |
| Linux PipeWire/portal observe | UNVERIFIED — OS-EV-006 | UNVERIFIED — OS-EV-006 | UNVERIFIED — OS-EV-006 | UNVERIFIED — OS-EV-006 | UNVERIFIED — OS-EV-006 | UNVERIFIED; MC-ADR-007 stays proposed |
| Linux compositor/X11 input | UNVERIFIED — OS-EV-006 | UNVERIFIED — OS-EV-006 | UNVERIFIED — OS-EV-006 | UNVERIFIED — OS-EV-006 | UNVERIFIED — OS-EV-006 | UNVERIFIED; no control support claim |

## 5. Blocking Artifacts

- Awake/unlocked macOS capture rerun with Screen Recording denied, granted, and revoked.
- Runnable ScreenCaptureKit prototype producing timestamped frames and resource measurements.
- Accessibility-enabled CGEvent input run with scoped coordinates, keyboard layouts, Chinese IME, revocation, and crash tests.
- Complete Xcode plus a valid Developer ID identity, hardened-runtime entitlements, packaged helper, and notarization result.
- Representative Windows hardware/VM with signing certificate and Electron/WGC/SendInput probes.
- Representative Linux Wayland and X11 machines with portal/compositor versions and packaging probes.

## 6. Next Reproducible Experiment

1. Wake and unlock the macOS display; record OS build, Electron version, display topology, permissions, and exact probe revision.
2. Run Electron capture 100 times before and after Screen Recording grant; save source counts, first-frame times, frame hashes, CPU, RSS, and explicit denial/revocation results.
3. Run the same frame suite through a minimal ScreenCaptureKit executable.
4. Grant Accessibility, then run 1,000 bounded CGEvent inputs across US/Chinese IME fixtures; revoke mid-run and force 100 helper crashes.
5. Package/sign/notarize the helper and verify it from the packaged Electron path.
6. Repeat the equivalent published fixture suite on declared Windows versions and Linux Wayland/X11 environments.

Until those artifacts exist, live observe/control must be feature-disabled and degrade explicitly to Chat Only; desktop Lily remains unchanged.
