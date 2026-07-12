# Lily Mobile Command Pro OS Helper Spike

## 1. Purpose

This spike chooses concrete desktop helper implementations for screen capture and input injection.

The helper must be narrow, auditable, signed where required, and unable to execute arbitrary commands.

## 2. Windows Candidates

### 2.1 Input

| Candidate | Pros | Risks |
|---|---|---|
| custom Node native addon wrapping SendInput | direct integration | build/signing complexity |
| small Rust helper using windows crate | memory safety, standalone | IPC and packaging needed |
| C++ helper using SendInput | straightforward Win32 | more memory safety burden |

Recommended spike:

- Rust helper first.
- JSON stdin/stdout or named pipe.
- Validate schema before SendInput.

### 2.2 Capture

| Candidate | Pros | Risks |
|---|---|---|
| Electron desktopCapturer | already available | quality/perf limits |
| Windows Graphics Capture | high quality | native integration complexity |

Recommended:

- Start with Electron desktopCapturer for initial production if quality passes.
- Prototype Windows Graphics Capture for performance upgrade.

## 3. macOS Candidates

### 3.1 Input

| Candidate | Pros | Risks |
|---|---|---|
| native module using CGEvent | direct | signing/notarization |
| Swift helper | platform-native | IPC/packaging |

Recommended spike:

- Swift helper or native addon depending packaging fit.
- Must detect Accessibility permission.

### 3.2 Capture

| Candidate | Pros | Risks |
|---|---|---|
| Electron capture | simple | permission behavior |
| ScreenCaptureKit | modern | OS version/API complexity |

Recommended:

- Prototype ScreenCaptureKit for macOS 13+.
- Electron fallback if adequate.

## 4. Linux Candidates

| Capability | Candidate | Policy |
|---|---|---|
| capture | PipeWire / portal | support Observe where available |
| input | compositor-specific | fail loud if unsupported |
| X11 input | xdotool/uinput | only if safe and available |

Linux Control is not a release blocker if it fails loud and Chat Only works.

## 5. Helper IPC Contract

Helper accepts:

```json
{
  "version": 1,
  "id": "cmd_123",
  "type": "move",
  "payload": {
    "x": 100,
    "y": 200
  }
}
```

Helper returns:

```json
{
  "id": "cmd_123",
  "ok": true
}
```

Error:

```json
{
  "id": "cmd_123",
  "ok": false,
  "error": {
    "code": "HELPER_PERMISSION_DENIED",
    "recoverable": true
  }
}
```

No command type may contain shell text.

## 6. Spike Acceptance

For each platform:

- send move/click/type/shortcut
- reject malformed command
- detect missing permissions
- helper exits cleanly
- helper crash revokes control
- packaged path resolution works

## 7. Decision Matrix

| Platform | Candidate | Build complexity | Permission handling | Security | Performance | Decision |
|---|---|---:|---:|---:|---:|---|
| Windows input | Rust SendInput helper | TBD | TBD | TBD | TBD | TBD |
| Windows capture | Electron desktopCapturer | TBD | TBD | TBD | TBD | TBD |
| macOS input | Swift/CGEvent helper | TBD | TBD | TBD | TBD | TBD |
| macOS capture | ScreenCaptureKit | TBD | TBD | TBD | TBD | TBD |
| Linux observe | PipeWire portal | TBD | TBD | TBD | TBD | TBD |

## 8. Tests

Prototype tests:

- `test-remote-helper-contract.mjs`
- `test-remote-helper-malformed-command.mjs`
- `test-remote-helper-crash-revoke.mjs`

## 9. Deliverables

Create:

```text
artifacts/mobile-command/os-helper-spike/results.md
artifacts/mobile-command/os-helper-spike/prototype-notes.md
```

No helper binary should be committed until implementation is approved.
