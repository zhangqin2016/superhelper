# Lily Mobile Command Pro WebRTC Runbook

## 1. Purpose

This runbook owns WebRTC operational behavior: signaling, ICE/TURN, media constraints, DataChannel backpressure, weak-network actions, and QA. MC-SM-WEBRTC, MC-SM-RECONNECT and MC-SM-BACKGROUND in [the canonical state machines](mobile-command-state-machines.md) own state names/transitions; [the error recovery catalog](mobile-command-error-recovery-catalog.md) owns codes and retry policy.

Signaling/TURN route and operation authority is [the API completeness matrix](mobile-command-api-completeness-matrix.md); this runbook does not create alternate endpoints.

WebRTC failure must degrade to Chat Only. It must not break local Lily agent execution.

## 2. Session Modes

| Mode | Source | Input | Permission |
|---|---|---|---|
| App Observe | Lily window | none | Observe App |
| App Control | Lily window | Lily window only | Control App |
| Desktop Observe | selected screen | none | Observe Desktop |
| Desktop Control | selected screen | selected screen | Control Desktop |

Mode changes require permission re-check. Switching from app to desktop source requires approval.

## 3. Signaling Flow

```mermaid
sequenceDiagram
  participant M as Mobile
  participant S as Signaling
  participant D as Desktop

  M->>S: create remote session
  M->>S: request TURN credentials
  M->>S: webrtc.offer
  S->>D: webrtc.offer
  D->>S: webrtc.answer
  S->>M: webrtc.answer
  M->>S: webrtc.ice.candidate
  S->>D: webrtc.ice.candidate
  D->>S: webrtc.ice.candidate
  S->>M: webrtc.ice.candidate
  M-->>D: WebRTC media + data channels
```

Rules:

- Signaling messages use `WsEnvelope`.
- Offer includes requested mode and source.
- Desktop may downgrade source if permission does not allow requested source.
- Unknown signaling messages are rejected and logged.

## 4. ICE And TURN

### 4.1 ICE Servers

Desktop and mobile both receive the same short-lived `iceServers` set:

- STUN first.
- TURN UDP.
- TURN TCP fallback.
- TURN TLS fallback if needed.

TURN credentials:

- TTL max 30 minutes.
- Bound to account and remote session.
- Refreshed before expiry during long sessions.

### 4.2 Candidate Policy

- Default: all candidates.
- Corporate/firewall mode: relay-only if P2P fails twice.
- Do not expose local IP telemetry beyond connection type and error code.

### 4.3 Connection Timeout

| Phase | Timeout |
|---|---:|
| signaling offer to answer | 10 seconds |
| ICE connecting | 20 seconds |
| first video frame | 10 seconds after connected |
| DataChannel open | 10 seconds after connected |

Timeout result:

- show recoverable Live Control error
- keep Chat Only
- do not end Lily session

## 5. Media Constraints

### 5.1 App Source

```ts
type AppSourceConstraints = {
  maxWidth: 1280;
  maxFps: 24;
  contentHint: 'detail';
};
```

### 5.2 Desktop Source

```ts
type DesktopSourceConstraints = {
  maxWidth: 1920;
  maxFps: 30;
  contentHint: 'detail';
};
```

Weak network downgrade:

| Condition | Action |
|---|---|
| packet loss > 5% for 10s | reduce bitrate |
| packet loss > 10% for 10s | reduce fps to 15 |
| RTT > 500ms for 10s | reduce width to 1280 or 720 |
| sustained decode freeze | restart sender track |

## 6. DataChannels

| Channel | Ordered | Reliable | Purpose |
|---|---:|---:|---|
| control | false | false | pointer move/scroll |
| keyboard | true | true | typing/shortcuts |
| clipboard | true | true | clipboard requests |
| health | false | false | stats/ping |

File/upload/artifact metadata is deliberately absent: it uses authenticated HTTP/WS projection and is owned by the file-transfer contract. DataChannel cannot mint upload or artifact authority.

### 6.1 Backpressure

Rules:

- Drop stale pointer move events when `bufferedAmount` exceeds threshold.
- Never drop keyboard events.
- Never drop clipboard events.
- Health events may be sampled.

Thresholds:

| Channel | Warning | Drop/Block |
|---|---:|---:|
| control | 128 KB | drop pointer move |
| keyboard | 64 KB | block UI typing and show lag |
| clipboard | 64 KB | reject new clipboard request |
| health | 64 KB | sample |

## 7. Reconnect State Machine

Use MC-SM-WEBRTC for media/ICE reconnect and MC-SM-RECONNECT for durable command/projection recovery. ICE failure permits one ICE restart and then one signaling reconnect as cataloged by `MC-ERR-WEBRTC-ICE-FAILED`. Input pauses before either attempt; identity, permission and source are revalidated before resume. Exhaustion enters canonical `chat_only`, never a locally invented reconnect state, and does not end the Lily task.

## 8. Mobile Background Behavior

MC-SM-BACKGROUND is canonical: input pauses immediately, control is revoked after 10 seconds, observe may remain only until 60 seconds when platform/policy allow, and lock closes WebRTC/revokes L2+. Native shell owns lifecycle observation, not permission state, and cannot keep control active silently. Missing/restarted lifecycle state assumes background/Chat Only.

## 9. Desktop Source Mapping

Desktop sends source metadata:

```ts
type SourceMetadata = {
  surfaceId: string;
  mode: 'app' | 'desktop';
  width: number;
  height: number;
  scaleFactor: number;
  displayId?: string;
  appBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};
```

Mobile sends normalized coordinates only. Desktop maps them to actual OS coordinates.

DPI and multi-monitor rules:

- Capture source owns coordinate mapping.
- Input outside authorized source bounds is rejected.
- If display topology changes, pause control and require source refresh.

## 10. Privacy Indicators

Desktop must show:

- visible indicator during Observe App/Desktop
- stronger indicator during Control App/Desktop
- active mobile device name
- stop control button

When indicator cannot be shown, remote observe/control must not start.

## 11. Platform Compatibility

### 11.1 Mobile

| Platform | Required |
|---|---|
| iOS 16+ WKWebView/Safari | WebRTC, IndexedDB, WebCrypto |
| Android 10+ Chrome/WebView | WebRTC, IndexedDB, WebCrypto |

Known limitations:

- iOS background WebRTC is unreliable.
- iOS may require user gesture for media playback.
- Android vendor WebViews may lag behind Chrome.

### 11.2 Desktop

| Platform | Capture | Input |
|---|---|---|
| Windows | Electron desktopCapturer, later Windows Graphics Capture | SendInput helper |
| macOS | ScreenCaptureKit/Electron | CGEvent with Accessibility |
| Linux | PipeWire/portal | limited, fail loud |

## 12. Telemetry

Allowed telemetry:

- connection mode: p2p/turn/failed
- setup duration
- reconnect count
- rtt bucket
- packet loss bucket
- source mode
- error code

Forbidden telemetry:

- screen frames
- raw input events
- typed text
- clipboard content

## 13. QA Matrix

Required scenarios:

- same Wi-Fi P2P
- mobile 5G to desktop home broadband P2P
- TURN relay forced
- TURN TCP/TLS forced
- mobile background and return
- phone lock
- desktop lock
- display change
- DPI scaling 125/150/200%
- multi-monitor
- weak network packet loss 5/10/20%
- high latency 300/700/1200ms
- DataChannel backpressure

## 14. Tests

Automated:

- `test-remote-signaling-contract.mjs`
- `test-remote-webrtc-state-machine.mjs`
- `test-remote-datachannel-backpressure.mjs`
- `test-remote-source-mapping.mjs`
- `test-remote-webrtc-fail-open.mjs`

Manual:

- run QA matrix on Windows + iOS
- run QA matrix on Windows + Android
- macOS permission missing/recovered
- Linux fail-loud behavior

## 15. Acceptance Criteria

- Chat Only works when WebRTC is disabled.
- Failed WebRTC setup does not end Lily session.
- Control input is paused during reconnect.
- Control permission is revoked after grace period.
- Desktop source switch requires approval.
- Pointer coordinates cannot escape authorized source bounds.
- TURN relay works when P2P is blocked.
