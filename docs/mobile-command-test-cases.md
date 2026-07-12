# Lily Mobile Command Pro Test Cases

## 1. Purpose

This document expands the test plan into case-level Given/When/Then scenarios. Every release gate should map to at least one case ID.

## 2. Protocol Cases

### MCP-PROTO-001 Invalid Major Version

File: `scripts/test-mobile-protocol-schema.mjs`

Given a WebSocket envelope with `version: 2`  
When the desktop validator receives it  
Then it rejects the event with `REQUEST_INVALID`  
And no side effect runs.

### MCP-PROTO-002 Unknown Additive Field

Given a valid version 1 HTTP request with an unknown additive field  
When the server validates it  
Then validation succeeds  
And the unknown field is ignored.

### MCP-PROTO-003 DataChannel Coordinate Bounds

Given a pointer event with `x: 1.2`  
When the desktop validates the DataChannel payload  
Then it rejects the payload before permission-policy  
And the OS input adapter is not called.

## 3. Security Cases

### MCP-SEC-001 Bad Signature

File: `scripts/test-mobile-signature-replay.mjs`

Given a signed mobile request with a modified body  
When the server verifies signature  
Then it returns `DEVICE_SIGNATURE_INVALID`.

### MCP-SEC-002 Nonce Replay

Given a valid signed request already accepted once  
When the same nonce is sent again within replay window  
Then the request is rejected with `REQUEST_REPLAY_DETECTED`.

### MCP-SEC-003 Revoked Device

Given a bound mobile device is revoked  
When it attempts to create a remote session  
Then the server returns `DEVICE_REVOKED`  
And all active sessions for that mobile device are ended.

## 4. Permission Cases

### MCP-PERM-001 Default Chat Only

File: `scripts/test-remote-session-permissions.mjs`

Given a newly paired phone  
When it creates a remote session  
Then permission level is `ChatOnly`.

### MCP-PERM-002 Unauthorized Input

Given a remote session at `ChatOnly`  
When a pointer event arrives  
Then permission-policy denies it  
And input adapter is not called.

### MCP-PERM-003 Desktop Control Requires Approval

Given a remote session at `ControlApp`  
When mobile requests `ControlDesktop`  
Then approval is required  
And control remains scoped to app until approval is granted.

### MCP-PERM-004 Policy Exception

Given permission-policy throws an exception  
When a control event arrives  
Then event is denied  
And session degrades to Chat Only.

## 5. Agent Bridge Cases

### MCP-AGENT-001 Target Session Delivery

File: `scripts/test-remote-agent-bridge.mjs`

Given mobile sends an agent message with `lilySessionId: A`  
When desktop bridge receives it  
Then the message is appended only to Lily session A.

### MCP-AGENT-002 Bridge Failure

Given file staging fails for an attachment  
When agent-mobile-bridge prepares the turn  
Then it returns recoverable error  
And does not send a blind prompt to the agent.

### MCP-AGENT-003 Busy Runner

Given target Lily session is busy  
When mobile sends a follow-up command  
Then it follows existing queue/steer rules  
And does not create an unbound runner.

## 6. File Transfer Cases

### MCP-FILE-001 Chunk Retry

File: `scripts/test-remote-upload-idempotency.mjs`

Given a chunk upload succeeds  
When the same chunk and idempotency key are retried  
Then server returns existing status  
And no duplicate object is created.

### MCP-FILE-002 Hash Mismatch

Given desktop pulls a verified object  
When full sha256 does not match upload metadata  
Then desktop deletes temp file  
And upload becomes `failed_recoverable`.

### MCP-FILE-003 Staging Before Agent

Given upload is verified but not staged  
When mobile sends agent message with that upload  
Then bridge waits or returns recoverable error  
And agent never receives the temporary object path.

### MCP-FILE-004 Risky Upload

Given mobile uploads `setup.exe`  
When risk classifier runs  
Then file risk is high  
And execution requires approval.

## 7. WebRTC Cases

### MCP-RTC-001 ICE Failure

File: `scripts/test-remote-webrtc-state-machine.mjs`

Given WebRTC ICE fails after one restart  
When reconnect grace expires  
Then Live Control closes  
And Command remains available.

### MCP-RTC-002 DataChannel Backpressure

Given control channel buffered amount exceeds threshold  
When pointer move events arrive  
Then stale pointer moves are dropped  
And keyboard events are not dropped.

### MCP-RTC-003 Source Topology Change

Given desktop display topology changes during control  
When source metadata changes  
Then control is paused  
And source refresh requires permission re-check.

## 8. Native Shell Cases

### MCP-NATIVE-001 Private Key Not Exported

File: `scripts/test-mobile-native-key-contract.mjs`

Given native shell generates a device key  
When Web receives result  
Then result includes `keyHandle` and `publicKey`  
And does not include private key material.

### MCP-NATIVE-002 Native Upload Cannot Verify

Given native background upload completes transport  
When native reports status  
Then Web upload remains not `verified` until server verification.

## 9. Voice Cases

### MCP-VOICE-001 Preserve Draft On Failure

File: `scripts/test-mobile-voice-fail-open.mjs`

Given composer contains typed text  
When ASR fails mid-recording  
Then typed text remains  
And partial transcript is preserved if available.

### MCP-VOICE-002 User Edit Wins

Given ASR partial transcript appears  
When user edits a word  
And a later ASR patch arrives for the old range  
Then user edit is not overwritten.

### MCP-VOICE-003 Sensitive Direct Send Blocked

Given direct send is enabled  
When user says "delete the desktop folder"  
Then transcript is shown for review  
And approval is required before execution.

## 10. UI Cases

### MCP-UI-001 Offline Does Not Claim Sent

File: `scripts/test-mobile-ui-states.mjs`

Given desktop is offline  
When user writes a command  
Then UI allows saving draft  
And does not show sent/delivered.

### MCP-UI-002 Brand Consistency

Given mobile app renders manifest and shell  
When brand assets are inspected  
Then name is Lily Workbench / 智能工作台  
And icons derive from desktop source.

## 11. Ops Cases

### MCP-OPS-001 Kill Desktop Control

Given remote config sets `desktopControlEnabled: false`  
When mobile requests Desktop Control  
Then request is denied  
And Chat Only remains available.

### MCP-OPS-002 TURN Cost Guard

Given account exceeds TURN bandwidth quota  
When a new relay session is requested  
Then Live Control is denied or degraded  
And Chat Only remains available.
