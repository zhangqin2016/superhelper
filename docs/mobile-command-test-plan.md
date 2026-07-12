# Lily Mobile Command Pro Test Plan

## 1. Purpose

This document defines the automated and manual verification plan for Lily Mobile Command Pro.

The release is not acceptable unless remote failures degrade to the existing Lily baseline and permission failures reject risky actions.

## 2. Test Layers

| Layer | Scope |
|---|---|
| Unit | permission policy, state machines, schema validation |
| Integration | server routes, desktop services, upload, agent bridge |
| Contract | HTTP/WebSocket/DataChannel/native bridge schemas |
| Renderer/App | mobile UI states and interactions |
| E2E manual | WebRTC, OS permissions, weak network, real devices |
| Security | replay, revocation, approval bypass, malicious files |

## 3. Automated Test Files

### 3.1 Protocol

`scripts/test-mobile-protocol-schema.mjs`

- validates HTTP sample payloads
- validates WebSocket envelopes
- validates DataChannel messages
- rejects unknown major version

`scripts/test-mobile-error-contract.mjs`

- all known error codes map to category/recoverable/message key
- handlers return `ApiError`

`scripts/test-mobile-idempotency.mjs`

- duplicate session create returns same session
- duplicate agent message does not create duplicate turn
- duplicate chunk commit is safe

### 3.2 Security

`scripts/test-mobile-signature-replay.mjs`

- bad signature rejected
- stale timestamp rejected
- reused nonce rejected

`scripts/test-remote-session-permissions.mjs`

- verifies permission truth table
- unknown permission level denied

`scripts/test-remote-approval-policy.mjs`

- approval TTL
- max uses
- session binding
- scoped sensitive action

`scripts/test-remote-device-revocation.mjs`

- revocation ends active sessions
- revoked device cannot reconnect

### 3.3 Agent Bridge

`scripts/test-remote-agent-bridge.mjs`

- mobile message enters target Lily session
- no cross-session delivery
- busy runner follows existing queue/steer behavior
- bridge failure leaves retryable message, no fake assistant completion

`scripts/test-remote-session-isolation.mjs`

- two mobile devices do not leak sessions
- multiple desktops under same account route correctly

### 3.4 File Transfer

`scripts/test-remote-file-transfer.mjs`

- upload state transitions
- desktop pull and staging
- attach only after staging

`scripts/test-remote-upload-idempotency.mjs`

- retry create/chunk/complete

`scripts/test-remote-upload-hash.mjs`

- chunk hash mismatch
- full file hash mismatch

`scripts/test-remote-upload-risk.mjs`

- executable, macro, archive risk

`scripts/test-remote-artifact-download.mjs`

- short-lived URL
- no local desktop path leak

### 3.5 WebRTC And Control

`scripts/test-remote-signaling-contract.mjs`

- offer/answer/candidate schema
- unknown event rejected

`scripts/test-remote-webrtc-state-machine.mjs`

- connect, reconnect, fail chat-only

`scripts/test-remote-datachannel-backpressure.mjs`

- pointer move drop
- keyboard not dropped

`scripts/test-remote-input-protocol.mjs`

- unauthorized input rejected before OS adapter

`scripts/test-remote-source-mapping.mjs`

- normalized coordinates bound to source
- topology change pauses control

### 3.6 Native Shell

`scripts/test-mobile-native-bridge-schema.mjs`

- bridge request/response validation

`scripts/test-mobile-native-key-contract.mjs`

- private key never returned
- invalid key requires re-pairing

`scripts/test-mobile-native-upload-contract.mjs`

- native upload cannot mark verified/staged

### 3.7 UI

`scripts/test-mobile-ui-states.mjs`

- offline does not claim delivery
- permission pending
- degraded Live returns to Command
- upload state visibility
- approval card buttons

## 4. Capability Gate Tests

Must register in `CAPABILITY-GATE.md`:

- `test-remote-fail-open.mjs`
- `test-remote-session-permissions.mjs`
- `test-remote-agent-bridge.mjs`
- `test-remote-input-protocol.mjs`
- `test-mobile-signature-replay.mjs`

Required assertions:

- WebRTC failure preserves local Lily baseline.
- Permission-policy failure denies control.
- Agent bridge failure does not poison Lily session.
- Audit failure blocks sensitive actions.
- Old config without mobile control starts as today.

## 5. Manual QA Matrix

### 5.1 Devices

| Desktop | Mobile |
|---|---|
| Windows 11 | iPhone iOS 16+ |
| Windows 11 | Android 10+ Chrome |
| macOS latest | iPhone iOS 16+ |
| macOS latest | Android 10+ |
| Linux | Android Chrome, fail-loud control limits |

### 5.2 Network

- same Wi-Fi
- mobile 5G to home broadband
- forced TURN
- forced TURN TCP/TLS
- packet loss 5/10/20%
- latency 300/700/1200ms
- offline/reconnect

### 5.3 OS Events

- phone lock
- phone background
- desktop lock
- desktop sleep/wake
- display topology change
- DPI scaling 125/150/200%
- multi-monitor

### 5.4 User Flows

- pair phone
- revoke phone
- send chat command
- upload photo
- upload 500 MB file
- upload risky file
- view Lily window
- control Lily window
- request desktop control
- deny approval
- grant approval
- artifact download

## 6. Release Gates

No release unless:

- all registered capability tests pass
- protocol contract tests pass
- permission truth table tests pass
- file transfer corruption tests pass
- at least one iOS and one Android manual WebRTC pass
- old config compatibility test passes
- kill switch behavior verified

## 7. Bug Severity

P0:

- unauthorized desktop control
- sensitive action without approval
- cross-session message leak
- local Lily session corrupted by remote failure
- private key leak

P1:

- WebRTC cannot connect through TURN
- uploads corrupt or duplicate
- approvals fail to expire
- revocation does not end active session

P2:

- weak-network quality issues
- UI state confusion
- non-sensitive telemetry gap

## 8. Test Data

Fixtures:

- small text file
- image with EXIF location
- 500 MB generated binary
- executable dummy file
- macro Office fixture
- nested archive fixture
- zip bomb safe synthetic fixture

No real secrets in fixtures.

## 9. Final Acceptance

The release is accepted only when:

- normal mobile Command tasks work without Live Control
- Live Control failure degrades to Command
- Desktop Control requires explicit approval
- files upload, stage, attach, and download with hash verification
- revoked devices cannot reconnect
- all sensitive actions are audited or denied
- telemetry contains no screen/input/clipboard/file body content
