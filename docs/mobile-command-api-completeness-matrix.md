# Lily Mobile Command Pro API Completeness Matrix

## 1. Purpose

This matrix is the canonical journey-to-boundary inventory (MC-SPEC-009). Operation names and schema names are normative targets for Task 6; the current OpenAPI implements only 5 of the 11 required HTTP path families, so a row here does not claim that production code or machine schema exists. State/error semantics link to the canonical [state machines](mobile-command-state-machines.md) and [error catalog](mobile-command-error-recovery-catalog.md).

All mutating HTTP/WS/DataChannel envelopes bind protocol version, exact desktop/mobile/session IDs, timestamp, nonce, canonical body hash and device signature. They also require an idempotency key unless the operation is naturally read-only. Native methods do not create remote envelopes or sign arbitrary payload strings; they sign a canonical digest request defined by the identity contract.

| Journey | Transport | Operation/event | Request schema | Response/event schema | Auth | Idempotency | State transition | Errors | Requirement IDs |
|---|---|---|---|---|---|---|---|---|---|
| Pairing start | HTTP POST | `/public/mobile/pairing/start` | `StartPairingRequest` | `PairingChallenge` | desktop access token + device signature/nonce | required | MC-SM-PAIRING `initial→challenge_created` | `MC-ERR-AUTH-*`, `MC-ERR-PAIRING-*`, `MC-ERR-SERVER-*` | `MC-PAIR-001`, `MC-PAIR-002` |
| Pairing consume/desktop decision | HTTP POST + WS | `/public/mobile/pairing/consume`; `pairing.approve|pairing.reject` | `ConsumePairingRequest`; `PairingDecision` | `PairingPending`; `PairingGrant` | same user tuple; both device signatures | required per operation | MC-SM-PAIRING to terminal | `MC-ERR-PAIRING-*`, `MC-ERR-PROTOCOL-IDEMPOTENCY-CONFLICT` | `MC-PAIR-003`, `MC-PAIR-004` |
| List devices | HTTP GET | `/public/mobile/devices` | `ListDevicesQuery` | `DeviceList` | account access token | read-only | none | `MC-ERR-AUTH-REQUIRED`, `MC-ERR-SERVER-*` | `MC-PAIR-005` |
| Revoke device | HTTP DELETE | `/public/mobile/devices/{mobileDeviceId}` | `RevokeDeviceRequest` | `RevocationReceipt` | account token + authorized device signature/nonce | required | MC-SM-REVOCATION | `MC-ERR-AUTH-*`, `MC-ERR-PROTOCOL-*` | `MC-PAIR-006`, `MC-PERM-009` |
| Create/refresh/end remote session | HTTP POST/DELETE | `POST /public/mobile/sessions`; `POST /public/mobile/sessions/{remoteSessionId}/refresh`; `DELETE /public/mobile/sessions/{remoteSessionId}` | `CreateRemoteSessionRequest`; `RefreshRemoteSessionRequest`; `EndRemoteSessionRequest` | `RemoteSession`; `AccessToken`; `EndReceipt` | full identity tuple + bound signature/nonce | required | MC-SM-REMOTE-SESSION | `MC-ERR-SESSION-*`, `MC-ERR-AUTH-*` | `MC-CMD-001`, `MC-PAIR-007` |
| Send command | WebSocket | `agent.command.submit` | `AgentCommandEnvelope` | `agent.command.admission` / terminal projection | remote token + signature/nonce | required; ledger scope `(desktop,mobile,key)` | bridge ledger plus remote session | `MC-ERR-BRIDGE-*`, `MC-ERR-PROTOCOL-*` | `MC-CMD-002`, `MC-CMD-003`, `MC-CMD-004` |
| Reconnect/snapshot | WebSocket | `projection.reconnect` / `projection.ack` | `ReconnectRequest` | `ProjectionReplay` or `ProjectionSnapshot` | full tuple revalidated | read-idempotent cursor | MC-SM-RECONNECT | `MC-ERR-AUTH-DEVICE-REVOKED`, `MC-ERR-PROTOCOL-CLIENT-UPGRADE-REQUIRED` | `MC-CMD-005`, `MC-CMD-006` |
| Approval request/decision/consume | WS + desktop local IPC | `approval.requested`; `approval.allow_once|allow_timed|deny`; `approval.consume` | `ApprovalRequest`; `ApprovalDecision`; `ApprovalConsume` | `ApprovalProjection` | mobile may request/answer eligible runtime prompts; sensitive grant only desktop authority | required per request/decision/consume | MC-SM-APPROVAL | `MC-ERR-PERMISSION-*`, `MC-ERR-AUTH-DEVICE-REVOKED` | `MC-PERM-001`–`MC-PERM-004` |
| Observe/control elevation | HTTP/WS | `POST /public/mobile/sessions/{remoteSessionId}/permissions`; `permission.*` | `PermissionRequest` | `PermissionProjection` | remote token + signature; decision desktop-only | required | MC-SM-PERMISSION | `MC-ERR-PERMISSION-*`, `MC-ERR-WEBRTC-SOURCE-UNAVAILABLE` | `MC-LIVE-001`, `MC-PERM-005` |
| Signaling | WebSocket | `webrtc.offer`, `webrtc.answer`, `webrtc.ice.candidate` | discriminated signaling event | signaling ack/event | remote token + signature/nonce + generation | required event ID/generation | MC-SM-WEBRTC | `MC-ERR-WEBRTC-*`, `MC-ERR-PROTOCOL-*` | `MC-LIVE-002`, `MC-LIVE-003` |
| TURN credentials | HTTP POST | `POST /public/mobile/sessions/{remoteSessionId}/turn-credentials` | `TurnCredentialRequest` | `TurnCredentialSet` | active bound remote session + signature/nonce | required | MC-SM-WEBRTC signaling checkpoint | `MC-ERR-WEBRTC-TURN-UNAVAILABLE`, `MC-ERR-AUTH-*` | `MC-LIVE-004` |
| Pointer/scroll/keyboard | WebRTC DataChannel | `input.pointer`, `input.scroll`, `input.keyboard` | discriminated input event with sequence | optional `input.ack` for reliable keyboard | per-event session/generation; desktop permission check | sequence dedup; pointer may coalesce, keyboard never replayed after ambiguity | MC-SM-PERMISSION active control | `MC-ERR-PERMISSION-DENIED`, `MC-ERR-WEBRTC-DATA-CHANNEL-CLOSED` | `MC-LIVE-005`, `MC-PERM-006` |
| Clipboard read/write | DataChannel + approval WS | `clipboard.read.request`, `clipboard.write` | `ClipboardRequest` | `ClipboardResult` (content never telemetry) | control grant; read requires scoped desktop approval | required request ID; no automatic write retry | MC-SM-APPROVAL / MC-SM-PERMISSION | `MC-ERR-PERMISSION-*`, `MC-ERR-WEBRTC-DATA-CHANNEL-CLOSED` | `MC-LIVE-006`, `MC-PRIV-003` |
| Create/chunk/complete/status upload | HTTP PUT/POST/GET | `POST /public/mobile/uploads`; `PUT /public/mobile/uploads/{uploadId}/chunks/{chunkIndex}`; `POST /public/mobile/uploads/{uploadId}/complete`; `GET /public/mobile/uploads/{uploadId}` | `CreateUploadRequest`; `UploadChunk`; `CompleteUploadRequest` | `UploadRecord` | remote token + signature/nonce | required; chunk-scoped | MC-SM-UPLOAD through `verified` | `MC-ERR-UPLOAD-*`, `MC-ERR-PROTOCOL-*` | `MC-FILE-001`–`MC-FILE-005` |
| Desktop pull/stage/attach | WS + desktop internal adapter | `upload.desktop_pull`, `upload.staged`, command attachment | `DesktopPullRequest`; opaque upload reference | `StagedUploadProjection` | active exact tuple; desktop local adapter | upload+desktop, upload+session+command keys | MC-SM-UPLOAD to terminal | `MC-ERR-UPLOAD-DESKTOP-PULL-FAILED`, `MC-ERR-UPLOAD-STAGING-FAILED` | `MC-FILE-006`, `MC-FILE-007` |
| Artifact metadata/download | WS projection + HTTP POST/GET | `artifact.available`; `POST /public/mobile/artifacts/{artifactId}/download`; authorized object `GET` | `ArtifactDownloadRequest` | `ArtifactDescriptor`; `AuthorizedDownload` | active session/device and artifact ACL | materialization required; download GET read-only | no turn-state mutation | `MC-ERR-ARTIFACT-*`, `MC-ERR-BRIDGE-ARTIFACT-UNAVAILABLE` | `MC-FILE-008`, `MC-FILE-009` |
| Health/diagnostics | DataChannel + WS + HTTP POST | `health.ping/stats`; `diagnostics.snapshot`; `/public/mobile/diagnostics` | `HealthEvent`; `DiagnosticsRequest` | redacted `DiagnosticsBundle` | active session; explicit user consent for bundle | read-only snapshot; upload required | none | `MC-ERR-SERVER-*`, `MC-ERR-NATIVE-TIMEOUT` | `MC-OPS-001`, `MC-PRIV-004` |
| Push register/unregister/wakeup | native bridge + HTTP | `push.register/unregister`; `/public/mobile/push-token`; provider wake event | `PushRegistration`; opaque `PushWakePayload` | receipt / non-sensitive wake hint | native attestation where available + account/session auth | required registration key; wake hints dedup by event ID | reconnect only; never grants authority | `MC-ERR-NATIVE-METHOD-UNSUPPORTED`, `MC-ERR-SERVER-*` | `MC-OPS-002`, `MC-PRIV-005` |
| Native sharing | native bridge | `share.getPendingSharedFiles`, `share.ack` | `NativeShareQuery/Ack` | `SharedFileDescriptor[]` | app-local capability; no remote authority | share ID ack required | feeds MC-SM-UPLOAD `created`; does not attach | `MC-ERR-NATIVE-PERMISSION-DENIED`, `MC-ERR-UPLOAD-TOO-LARGE` | `MC-FILE-010` |
| Background upload | native bridge | `upload.startBackgroundUpload/getUploadStatus/cancelUpload` | `NativeTransportUploadRequest` | `NativeUploadTransportStatus` | app-local handle; pre-authorized URL/header allowlist | upload/chunk/handle key required | transport observation only; MC-SM-UPLOAD remains canonical | `MC-ERR-NATIVE-UPLOAD-FAILED`, `MC-ERR-NATIVE-TIMEOUT` | `MC-FILE-011`, `MC-REL-003` |
| Camera/QR and voice capture | native bridge | `camera.scanQr`; `voice.capture.start/stop/cancel` | native capability params | QR text or local audio descriptor | OS permission; no protocol consumption/submission | invocation ID; no auto retry after capture ambiguity | pairing input or upload input only | `MC-ERR-NATIVE-PERMISSION-DENIED`, `MC-ERR-NATIVE-METHOD-UNSUPPORTED` | `MC-PAIR-008`, `MC-CMD-007` |
| Mobile lifecycle | native event | `app.foreground`, `app.background`, `app.locked`, `network.changed` | discriminated lifecycle event | Web adapter ack | app-local monotonic sequence/timestamp | event sequence dedup | MC-SM-BACKGROUND | `MC-ERR-NATIVE-TIMEOUT`, `MC-ERR-PROTOCOL-INVALID` | `MC-LIVE-007`, `MC-REL-004` |

## 2. Normative Provisional Requirement Registry

These definitions are normative now; no ID in the matrix is a future placeholder. Task 9 will migrate each row unchanged into the requirements traceability document and add implementation/test/release mappings. Migration MUST NOT renumber an ID or change its requirement text/canonical owner without an explicit supersession record.

| ID | Normative requirement | Canonical section / owner |
|---|---|---|
| `MC-PAIR-001` | An active signed desktop can create one bounded, expiring pairing challenge. | MC-SM-PAIRING / state machines |
| `MC-PAIR-002` | Pairing start persists only a one-time hashed challenge and returns no standing authority. | identity contract + MC-SM-PAIRING |
| `MC-PAIR-003` | Consume binds the exact user/license/desktop/mobile/key tuple and atomically consumes the token. | identity contract + MC-SM-PAIRING |
| `MC-PAIR-004` | Only an explicit desktop decision can create the pairing grant; reject/timeout is terminal. | MC-SM-PAIRING |
| `MC-PAIR-005` | Device listing exposes only account-authorized, redacted device/grant status. | identity contract / devices API row |
| `MC-PAIR-006` | Authorized device revocation is durable, idempotent, audited, and cascades before later authority. | MC-SM-REVOCATION |
| `MC-PAIR-007` | Remote-session create/refresh/end revalidates the full identity tuple and one-time token family. | MC-SM-REMOTE-SESSION + identity contract |
| `MC-PAIR-008` | QR scanning returns untrusted text to Web validation and never consumes a challenge natively. | native shell camera section |
| `MC-CMD-001` | A remote session is bounded channel authority, never a Lily conversation or account session. | MC-SM-REMOTE-SESSION + identity contract |
| `MC-CMD-002` | Every external command targets an explicit existing Lily session and enters the sole orchestrator admission seam. | agent bridge command admission |
| `MC-CMD-003` | Command idempotency gives exactly-once durable admission and at most one automatic dispatch attempt. | agent bridge ledger |
| `MC-CMD-004` | Current remote steer deterministically downgrades to the canonical FIFO queue with visible mode fields. | agent bridge concurrency |
| `MC-CMD-005` | Reconnect uses durable epoch/sequence replay or an atomic authorized snapshot cut. | MC-SM-RECONNECT |
| `MC-CMD-006` | Reconnect never trusts a volatile bus cursor or re-dispatches an ambiguous command. | MC-SM-RECONNECT + agent bridge |
| `MC-CMD-007` | Voice capture produces local input; transcript/command patching follows voice and bridge ownership without hidden submission. | voice-input contract + agent bridge |
| `MC-LIVE-001` | Observe/control elevation requires current desktop permission policy and explicit desktop approval where required. | MC-SM-PERMISSION |
| `MC-LIVE-002` | Offer/answer signaling binds the exact remote session, permission, source and generation. | MC-SM-WEBRTC |
| `MC-LIVE-003` | The only ICE candidate discriminator is `webrtc.ice.candidate`; invalid candidates do not end signaling before its deadline. | MC-SM-WEBRTC |
| `MC-LIVE-004` | TURN credentials are short-lived, remote-session-bound and grant no application authority. | WebRTC runbook TURN section |
| `MC-LIVE-005` | Input is source-bounded and permission-checked; pointer may coalesce but ambiguous keyboard input is never replayed. | permission model + DataChannel protocol |
| `MC-LIVE-006` | Clipboard read requires scoped approval and clipboard content never enters telemetry. | permission threat model |
| `MC-LIVE-007` | Background pauses control immediately, revokes control at 10 s and observe at 60 s cumulative. | MC-SM-BACKGROUND |
| `MC-PERM-001` | Approval requests bind action, session, device, resources, expiry and max uses. | MC-SM-APPROVAL |
| `MC-PERM-002` | Desktop approval decisions use first-writer compare-and-set and late decisions cannot grant authority. | MC-SM-APPROVAL |
| `MC-PERM-003` | Approval consumption atomically checks scope/TTL/use count before the sensitive side effect. | MC-SM-APPROVAL |
| `MC-PERM-004` | Revocation/session end invalidates pending and unused approvals before any late consume. | MC-SM-APPROVAL |
| `MC-PERM-005` | L2+ permission is temporary, audited, indicator-gated and restarts disabled until revalidated. | MC-SM-PERMISSION |
| `MC-PERM-006` | Every DataChannel control event is denied unless the exact live grant and source bounds pass desktop policy. | permission threat model |
| `MC-PERM-009` | Device revocation immediately denies reconnect, approval, cancellation, artifact and new command authority. | MC-SM-REVOCATION |
| `MC-FILE-001` | Upload creation binds session/device, size/hash/chunk manifest, expiry and idempotency key. | file-transfer metadata + MC-SM-UPLOAD |
| `MC-FILE-002` | Chunk commit verifies index/hash and treats an exact duplicate as an idempotent read. | file-transfer chunking |
| `MC-FILE-003` | Completion requires every chunk and a verified full-file hash before object sealing. | MC-SM-UPLOAD `verifying→verified` |
| `MC-FILE-004` | Recoverable upload retry resumes only the explicitly persisted `resume_state` checkpoint. | MC-SM-UPLOAD |
| `MC-FILE-005` | Expired/cancelled/revoked upload data never reaches desktop staging or agent attachment. | MC-SM-UPLOAD |
| `MC-FILE-006` | Desktop pull revalidates authority and full hash before using the existing staging adapter. | file-transfer desktop pull |
| `MC-FILE-007` | Agent attachment uses only an opaque staged ID and the exact Lily session/command admission key. | file-transfer + agent bridge |
| `MC-FILE-008` | Artifact metadata derives only from sealed local turn/artifact facts and never exposes local paths. | agent bridge artifact projection |
| `MC-FILE-009` | Artifact download is separately authorized, short-lived and does not alter terminal turn state. | file-transfer download |
| `MC-FILE-010` | Native-shared files enter app temp storage and require explicit Web enqueue/ack before upload. | native shell share section |
| `MC-FILE-011` | Background native upload reports transport only and cannot mark business verification/staging/attachment. | native shell + MC-SM-UPLOAD |
| `MC-OPS-001` | Diagnostics are redacted, consented and exclude screen/input/clipboard/file/prompt bodies. | diagnostics API row + WebRTC telemetry |
| `MC-OPS-002` | Push contains a non-sensitive wake hint only and never grants or restores authority. | native shell push section |
| `MC-PRIV-003` | Clipboard contents and raw input are prohibited from telemetry, audit and push payloads. | permission threat model + WebRTC telemetry |
| `MC-PRIV-004` | Diagnostic collection requires explicit consent and allowlisted redaction. | diagnostics API row |
| `MC-PRIV-005` | Push payloads omit sensitive file names/message content by default and carry opaque correlation only. | native shell push section |
| `MC-REL-003` | Native/PWA background-upload downgrade preserves canonical upload checkpoints and foreground resume. | native shell background upload |
| `MC-REL-004` | Missing/restarted lifecycle reporting fails safe to background/Chat Only without weakening local Lily. | MC-SM-BACKGROUND |

## 3. Ownership And Compatibility

- `file-meta` is not a WebRTC DataChannel. Upload metadata and artifact descriptors travel over authenticated HTTP/WS projection; binary transfer uses authorized HTTP/object storage. DataChannels own only live input/health.
- Artifact download is owned by the file-transfer contract and local artifact adapter, never by native share or the WebRTC runbook.
- Native lifecycle and background transport are owned by the native shell; business state remains in MC-SM-BACKGROUND and MC-SM-UPLOAD.
- Voice capture is a native capability/input adapter; voice transcript/command patch semantics are owned by `mobile-command-voice-input.md` and the agent bridge, not the protocol transport or upload machine.
- Task 6 must add every missing HTTP path/event/method and reuse these schema names. Compatibility is additive within a major version; unknown mandatory semantics return `MC-ERR-PROTOCOL-CLIENT-UPGRADE-REQUIRED` and disable remote mutation.
- Until Task 6, any different route still present in `docs/schemas/mobile-command.openapi.yaml` is a known non-canonical draft, not an alternate endpoint. Implementers MUST use this matrix and MUST NOT combine both route families.
