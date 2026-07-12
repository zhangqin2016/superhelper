# macOS arm64 OS Helper Evidence — 2026-07-12

This directory preserves the reproducible, non-mutating evidence behind OS-EV-001
through OS-EV-004. The probes do not request permissions, inject input, change system
settings, or integrate with Lily product code.

## Environment limitation

The host was macOS 26.4.1 arm64 on Apple M5 Pro. The only built-in display was online
but asleep. Consequently, Electron's screen-only source enumeration returned zero
sources and zero non-empty thumbnails. Treat that result as a failed usable-capture
observation in this environment, not as proof that Electron capture fails when awake.

## Evidence map

| ID | Source and raw output | Result boundary |
|---|---|---|
| OS-EV-001 | `electron-capture-probe.cjs`, `electron-capture-output.txt` | Electron API exists; usable capture failed with 0 sources while display asleep |
| OS-EV-002 | `screencapturekit-typecheck.swift`, `swift-probes-output.txt` | ScreenCaptureKit symbols compile; runtime capture remains unverified |
| OS-EV-003 | `coregraphics-permission-probe.swift`, `swift-probes-output.txt` | Permission preflight ran; event posting permission was false; no input was injected |
| OS-EV-004 | `environment-tools-output.txt` | Full Xcode, signing identity, and notarization credentials were unavailable |

`SHA256SUMS` binds the three executable probe sources to the hashes cited by the
decision documents. Raw outputs contain no secrets or absolute user-home path; the
hostname is explicitly redacted.

## Reproduction

From repository root:

```bash
./node_modules/.bin/electron docs/evidence/mobile-command/os/2026-07-12-macos-arm64/electron-capture-probe.cjs
swiftc -typecheck docs/evidence/mobile-command/os/2026-07-12-macos-arm64/screencapturekit-typecheck.swift
swiftc docs/evidence/mobile-command/os/2026-07-12-macos-arm64/coregraphics-permission-probe.swift -o /tmp/lily-coregraphics-permission-probe
perl -e 'alarm 5; exec @ARGV' /tmp/lily-coregraphics-permission-probe
rm -f /tmp/lily-coregraphics-permission-probe
shasum -a 256 docs/evidence/mobile-command/os/2026-07-12-macos-arm64/{electron-capture-probe.cjs,screencapturekit-typecheck.swift,coregraphics-permission-probe.swift}
```

Do not call `askForMediaAccess`, `CGRequestScreenCaptureAccess`, or
`CGRequestPostEventAccess` as part of this evidence reproduction. Do not post CGEvents.
