# Lily Mobile Command Pro Desktop OS Adapters

## 1. Purpose

This document defines desktop screen capture, input injection, permission detection, helper process boundaries, and platform support for Lily Mobile Command Pro.

OS adapters are powerful and must be narrow, validated, auditable, and permission-gated.

## 2. Adapter Boundary

Desktop remote control pipeline:

```text
DataChannel event
-> schema validation
-> permission-policy
-> source bounds mapping
-> OS adapter
-> audit summary
```

OS adapters must not:

- parse mobile protocol envelopes
- decide permission
- access Lily session state
- execute arbitrary scripts
- accept raw shell commands
- read clipboard without approval

## 3. Screen Capture

### 3.1 Source Types

```ts
type CaptureSource =
  | {
      type: 'app';
      sourceId: string;
      title: string;
      bounds: Rect;
      scaleFactor: number;
    }
  | {
      type: 'desktop';
      displayId: string;
      title: string;
      bounds: Rect;
      scaleFactor: number;
    };
```

### 3.2 Source Rules

- Default source is Lily app window.
- Desktop source requires approval.
- Multi-monitor defaults to the display containing Lily.
- Display topology change pauses control.
- Source switch requires permission re-check.

## 4. Input Mapping

Mobile sends normalized coordinates:

```ts
type NormalizedPoint = {
  x: number; // 0..1
  y: number; // 0..1
  surfaceId: string;
};
```

Desktop maps to OS coordinates:

```text
osX = source.bounds.x + x * source.bounds.width
osY = source.bounds.y + y * source.bounds.height
```

Rules:

- Reject if x/y outside 0..1.
- Reject if surfaceId no longer matches active source.
- Reject if mapped point escapes authorized bounds.
- Account for DPI scaling before OS injection.

## 5. Windows

### 5.1 Capture

Initial:

- Electron `desktopCapturer`.

Production optimization:

- Windows Graphics Capture if needed.

### 5.2 Input

Use a narrow native helper around Win32 `SendInput`.

Helper command schema:

```ts
type WindowsInputCommand =
  | { type: 'move'; x: number; y: number }
  | { type: 'down'; button: 'left' | 'right' | 'middle' }
  | { type: 'up'; button: 'left' | 'right' | 'middle' }
  | { type: 'scroll'; deltaX: number; deltaY: number }
  | { type: 'typeText'; text: string }
  | { type: 'shortcut'; keys: string[] };
```

Rules:

- Helper accepts JSON over stdin or named pipe.
- Helper validates command schema.
- Helper does not execute shell.
- Helper process starts only during active control.
- Helper exits when control ends.

## 6. macOS

### 6.1 Capture

Options:

- ScreenCaptureKit where available.
- Electron capture fallback.

Required permissions:

- Screen Recording for desktop capture.
- Accessibility for input injection.

### 6.2 Input

Use CGEvent through a signed helper or native module.

Rules:

- Detect Accessibility permission before Control mode.
- If missing, allow Observe if Screen Recording is available.
- Never claim control is active when CGEvent injection fails.
- Prompt user with OS-specific guidance.

Packaging:

- Helper must be signed with app.
- Hardened runtime and notarization requirements must be respected.

## 7. Linux

### 7.1 Capture

Preferred:

- PipeWire / xdg-desktop-portal.

Limitations:

- Wayland input injection is often restricted.
- X11 tools may work but are not universal.

Policy:

- Linux Observe can be supported where portal works.
- Linux Control is best-effort and must fail loud when unsupported.
- Do not bypass compositor security.

## 8. Clipboard

Clipboard read/write goes through separate adapter:

- write requires current control permission
- read requires sensitive approval
- content is not logged
- large content is size-limited

## 9. Permission Detection

```ts
type DesktopPermissionStatus = {
  screenCapture: 'granted' | 'denied' | 'unknown' | 'unsupported';
  inputControl: 'granted' | 'denied' | 'unknown' | 'unsupported';
  clipboard: 'granted' | 'denied' | 'unknown' | 'unsupported';
};
```

Desktop exposes status to mobile as capability state, not as instructions to bypass permissions.

## 10. Helper Security

Rules:

- Helper path is resolved from packaged resources only.
- Helper binary hash is verified before launch when practical.
- Helper receives only validated commands.
- Helper cannot open network sockets.
- Helper cannot read files other than its own config if needed.
- Helper lifetime is bound to remote control session.
- Helper crash revokes control and returns to Observe or Chat Only.

## 11. Audit

Audit summaries:

- helper started/stopped
- source selected
- permission missing
- input injection failure
- control revoked

Do not audit:

- typed text
- raw coordinates stream
- clipboard content

## 12. Tests

Required tests:

- `test-remote-source-mapping.mjs`
- `test-remote-input-protocol.mjs`
- `test-remote-helper-contract.mjs`
- `test-remote-platform-permissions.mjs`
- `test-remote-helper-fail-safe.mjs`

Assertions:

- unauthorized input never reaches helper
- helper rejects malformed commands
- helper crash revokes control
- missing macOS Accessibility degrades to Observe/Chat
- Linux unsupported input fails loud

## 13. Acceptance Criteria

- Windows App Control can click/type in Lily window.
- Windows Desktop Control requires approval.
- macOS missing permissions are detected and explained.
- Linux unsupported control does not pretend success.
- No OS adapter can execute arbitrary command text.
