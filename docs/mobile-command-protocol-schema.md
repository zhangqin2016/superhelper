# Lily Mobile Command Pro Protocol Schema

## 1. Purpose

This document defines human-readable field-level protocol details for Lily Mobile Command Pro. Operation and route authority is owned by [the API completeness matrix](mobile-command-api-completeness-matrix.md), lifecycle names by [the canonical state machines](mobile-command-state-machines.md), and error/retry semantics by [the error recovery catalog](mobile-command-error-recovery-catalog.md). Task 6 will reconcile the machine schemas with those owners; this prose MUST NOT be treated as evidence that a route already exists.

No implementation should invent fields outside this contract. Additive fields are allowed only when they preserve old-client behavior.

## 2. Shared Types

### 2.1 IDs

```ts
type UserId = string; // users.id
type DesktopDeviceId = string; // unified devices.id, role desktop
type MobileDeviceId = string; // unified devices.id, role mobile
type LilySessionId = string;
type RemoteSessionId = `rs_${string}`;
type PairingId = string; // mobile_pairing_challenges.id or grant id by field name
type ApprovalId = `appr_${string}`;
type UploadId = `upl_${string}`;
type ArtifactId = `art_${string}`;
type EventId = `evt_${string}`;
type IdempotencyKey = `idem_${string}`;
type CorrelationId = `corr_${string}`;
```

IDs are opaque. Clients must not parse meaning from suffixes.

### 2.2 Timestamps

All timestamps are Unix milliseconds:

```ts
type UnixMs = number;
```

Servers must tolerate clock skew. Security TTLs are evaluated on the server or desktop authority that grants the capability.

### 2.3 Permission Levels

```ts
enum PermissionLevel {
  Offline = 0,
  ChatOnly = 1,
  ObserveApp = 2,
  ControlApp = 3,
  ObserveDesktop = 4,
  ControlDesktop = 5,
  SensitiveOps = 6
}
```

Level 6 is not a standing session permission. It is granted only for a scoped approval.

### 2.4 Signature

All mobile-originated mutating requests and events must include:

```ts
type SignedEnvelopeFields = {
  mobileDeviceId: MobileDeviceId;
  timestamp: UnixMs;
  nonce: string;
  signature: string;
};
```

Signature payload:

```text
METHOD_OR_EVENT_TYPE + "\n" +
PATH_OR_REMOTE_SESSION_ID + "\n" +
timestamp + "\n" +
nonce + "\n" +
sha256(canonicalJson(bodyOrPayload))
```

Rules:

- `nonce` must be unique per mobile device for at least 10 minutes.
- Desktop and server must keep a bounded replay cache.
- Requests outside allowed clock skew return `MC-ERR-AUTH-CLOCK-SKEW`.
- Signature verification failure returns `MC-ERR-AUTH-SIGNATURE-INVALID`.
- The signed canonical input binds method/event type, exact path or remote session, desktop and mobile device IDs, protocol/signature version, timestamp, nonce, and canonical body hash as specified by the identity contract. A signature authenticates only the active device key generation; authorization still revalidates the full identity tuple.

### 2.5 Idempotency

Mutating operations must include `Idempotency-Key` header or envelope `idempotencyKey`.

Idempotent operations:

- pairing consume
- remote session create
- permission request
- upload create
- chunk commit
- approval grant/deny
- agent message submit

Retrying the same key returns the original terminal result or current operation status. It must not create duplicate messages, uploads, sessions, approvals, or files. Mutating requests without an idempotency key are never retried automatically. Same key plus a different canonical payload returns `MC-ERR-PROTOCOL-IDEMPOTENCY-CONFLICT`.

## 3. Error Model

```ts
type ApiError = {
  error: {
    code: MobileCommandErrorCode;
    category:
      | 'auth'
      | 'network'
      | 'permission'
      | 'desktop'
      | 'webrtc'
      | 'upload'
      | 'server'
      | 'protocol';
    recoverable: boolean;
    userMessageKey: string;
    retryAfterMs?: number;
    correlationId: CorrelationId;
    details?: Record<string, unknown>;
  };
};
```

### 3.1 Error Codes

The normative code set and every count/backoff/jitter/terminal policy are in [the error recovery catalog](mobile-command-error-recovery-catalog.md). The unprefixed names retained below are pre-canonical compatibility aliases only; adapters map them one-to-one to `MC-ERR-*`, and new clients/servers emit only catalog codes.

```text
AUTH_REQUIRED
ACCOUNT_NOT_ALLOWED
FEATURE_DISABLED
CONFIG_UNAVAILABLE

PAIRING_TOKEN_EXPIRED
PAIRING_TOKEN_CONSUMED
PAIRING_TOKEN_INVALID
PAIRING_DESKTOP_OFFLINE
PAIRING_DESKTOP_REJECTED

DEVICE_NOT_FOUND
DEVICE_REVOKED
DEVICE_SIGNATURE_INVALID
DEVICE_KEY_ROTATION_REQUIRED

REMOTE_SESSION_NOT_FOUND
REMOTE_SESSION_EXPIRED
REMOTE_SESSION_CONFLICT
REMOTE_SESSION_STALE
REMOTE_SESSION_ENDED

PERMISSION_DENIED
PERMISSION_APPROVAL_REQUIRED
PERMISSION_APPROVAL_EXPIRED
PERMISSION_POLICY_FAILED

AGENT_SESSION_NOT_FOUND
AGENT_BRIDGE_BUSY
AGENT_BRIDGE_FAILED
AGENT_MESSAGE_DUPLICATE

WEBRTC_SIGNALING_FAILED
WEBRTC_TURN_UNAVAILABLE
WEBRTC_ICE_FAILED
WEBRTC_DATA_CHANNEL_CLOSED
WEBRTC_SOURCE_UNAVAILABLE

INPUT_NOT_AUTHORIZED
INPUT_INJECTION_FAILED
SCREEN_CAPTURE_PERMISSION_MISSING
SCREEN_SOURCE_CHANGED

UPLOAD_TOO_LARGE
UPLOAD_QUOTA_EXCEEDED
UPLOAD_CHUNK_MISSING
UPLOAD_CHUNK_HASH_MISMATCH
UPLOAD_FILE_HASH_MISMATCH
UPLOAD_EXPIRED
UPLOAD_DESKTOP_PULL_FAILED
UPLOAD_STAGING_FAILED
UPLOAD_RISK_APPROVAL_REQUIRED

ARTIFACT_NOT_FOUND
ARTIFACT_EXPIRED
ARTIFACT_DOWNLOAD_DENIED

REQUEST_INVALID
REQUEST_CLOCK_SKEW
REQUEST_REPLAY_DETECTED
REQUEST_IDEMPOTENCY_CONFLICT
SERVER_RATE_LIMITED
SERVER_UNAVAILABLE
```

Every UI-visible error maps to an i18n key. Protocol handlers must never return raw exception text to the mobile client.

## 4. HTTP API

Canonical routes are written as absolute application paths below and include the `/public` prefix exactly as owned by the API completeness matrix.

### 4.1 Start Pairing

`POST /public/mobile/pairing/start`

Desktop-originated.

Request:

```ts
type StartPairingRequest = {
  desktopDeviceId: DesktopDeviceId;
  desktopName: string;
  supportedProtocolVersions: number[];
};
```

Response:

```ts
type StartPairingResponse = {
  pairingId: PairingId;
  qrPayload: string;
  expiresAt: UnixMs;
  protocolVersion: 1;
};
```

Failure:

- `FEATURE_DISABLED`
- `ACCOUNT_NOT_ALLOWED`
- `CONFIG_UNAVAILABLE`

### 4.2 Consume Pairing

`POST /public/mobile/pairing/consume`

Mobile-originated, signed.

Request:

```ts
type ConsumePairingRequest = SignedEnvelopeFields & {
  pairingToken: string;
  mobileDeviceName: string;
  mobilePlatform: 'ios' | 'android' | 'web';
  mobilePublicKey: string;
  appVersion: string;
  supportedProtocolVersions: number[];
};
```

Response:

```ts
type ConsumePairingResponse = {
  mobileDeviceId: MobileDeviceId;
  desktopDeviceId: DesktopDeviceId;
  requiresDesktopApproval: true;
  approvalExpiresAt: UnixMs;
  protocolVersion: 1;
};
```

Failure:

- `PAIRING_TOKEN_EXPIRED`
- `PAIRING_TOKEN_CONSUMED`
- `PAIRING_TOKEN_INVALID`
- `PAIRING_DESKTOP_OFFLINE`
- `DEVICE_SIGNATURE_INVALID`

### 4.3 List Devices

`GET /public/mobile/devices`

Response:

```ts
type ListDevicesResponse = {
  devices: Array<{
    desktopDeviceId: DesktopDeviceId;
    desktopName: string;
    online: boolean;
    lilyRunning: boolean;
    lastSeenAt?: UnixMs;
    supportedFeatures: string[];
    mobileDevices: Array<{
      mobileDeviceId: MobileDeviceId;
      mobileDeviceName: string;
      platform: 'ios' | 'android' | 'web';
      trustedAt: UnixMs;
      lastSeenAt?: UnixMs;
      revokedAt?: UnixMs;
    }>;
  }>;
};
```

### 4.4 Revoke Device

`DELETE /public/mobile/devices/{mobileDeviceId}`

Response:

```ts
type RevokeDeviceResponse = {
  revoked: true;
  endedRemoteSessionIds: RemoteSessionId[];
};
```

### 4.5 Create Remote Session

`POST /public/mobile/sessions`

Mobile-originated, signed.

Request:

```ts
type CreateRemoteSessionRequest = SignedEnvelopeFields & {
  desktopDeviceId: DesktopDeviceId;
  mobileDeviceId: MobileDeviceId;
  requestedLevel: PermissionLevel.ChatOnly;
  preferredLilySessionId?: LilySessionId;
};
```

Response:

```ts
type CreateRemoteSessionResponse = {
  remoteSessionId: RemoteSessionId;
  desktopDeviceId: DesktopDeviceId;
  mobileDeviceId: MobileDeviceId;
  lilySessionId?: LilySessionId;
  permissionLevel: PermissionLevel.ChatOnly;
  expiresAt: UnixMs;
  commandWsUrl: string;
};
```

### 4.6 Refresh Remote Session

`POST /public/mobile/sessions/{remoteSessionId}/refresh`

Mobile-originated and signed. The request presents the current one-time remote refresh token and observed family generation. Success atomically consumes it, rotates `access_token_generation`, advances the refresh-family generation, and returns both the next one-time refresh token and the new access token. A lost success response is not automatically retried with the old token; used-token replay revokes the family/session.

### 4.7 Request Permission

`POST /public/mobile/sessions/{remoteSessionId}/permissions`

Mobile-originated, signed.

Request:

```ts
type RequestPermissionRequest = SignedEnvelopeFields & {
  requestedLevel: PermissionLevel;
  reason: string;
  ttlSeconds: number;
  screenSourceId?: string;
};
```

Response:

```ts
type RequestPermissionResponse =
  | {
      status: 'granted';
      permissionLevel: PermissionLevel;
      expiresAt: UnixMs;
    }
  | {
      status: 'pending_desktop_approval';
      approvalId: ApprovalId;
      expiresAt: UnixMs;
    }
  | {
      status: 'denied';
      reasonCode: MobileCommandErrorCode;
    };
```

### 4.8 End Remote Session

`DELETE /public/mobile/sessions/{remoteSessionId}`

Request:

```ts
type EndRemoteSessionRequest = SignedEnvelopeFields & {
  reason: 'user_exit' | 'desktop_revoked' | 'mobile_logout' | 'error';
};
```

Response:

```ts
type EndRemoteSessionResponse = {
  ended: true;
  endedAt: UnixMs;
};
```

### 4.9 TURN Credentials

`POST /public/mobile/sessions/{remoteSessionId}/turn-credentials`

Request:

```ts
type TurnCredentialRequest = SignedEnvelopeFields & {
  remoteSessionId: RemoteSessionId;
};
```

Response:

```ts
type TurnCredentialSet = {
  iceServers: Array<{
    urls: string[];
    username?: string;
    credential?: string;
  }>;
  expiresAt: UnixMs;
};
```

## 5. WebSocket Protocol

Command and signaling WebSockets use the same envelope.

```ts
type WsEnvelope<TType extends string, TPayload> = {
  version: 1;
  id: EventId;
  idempotencyKey?: IdempotencyKey;
  type: TType;
  remoteSessionId: RemoteSessionId;
  desktopDeviceId: DesktopDeviceId;
  mobileDeviceId?: MobileDeviceId;
  lilySessionId?: LilySessionId;
  timestamp: UnixMs;
  correlationId: CorrelationId;
  payload: TPayload;
  signature?: string;
};
```

### 5.1 Agent Events

```ts
type AgentMessagePayload = {
  text: string;
  attachments?: Array<{
    uploadId: UploadId;
    stagedFileId?: string;
  }>;
  clientMessageId: string;
};

type AgentStreamDeltaPayload = {
  assistantMessageId: string;
  delta: string;
};

type AgentToolProgressPayload = {
  toolCallId: string;
  name: string;
  phase: string;
  percent?: number;
  summary?: string;
};

type AgentArtifactCreatedPayload = {
  artifactId: ArtifactId;
  name: string;
  mimeType: string;
  sizeBytes?: number;
};
```

### 5.2 Approval Events

```ts
type ApprovalRequiredPayload = {
  approvalId: ApprovalId;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  actionType:
    | 'file_delete'
    | 'file_overwrite'
    | 'external_send'
    | 'shell_command'
    | 'software_install'
    | 'clipboard_read'
    | 'desktop_control'
    | 'screen_source_switch'
    | 'system_settings'
    | 'high_risk_upload';
  summary: string;
  affectedResources: string[];
  expiresAt: UnixMs;
};

type ApprovalDecisionPayload = {
  approvalId: ApprovalId;
  decision: 'granted' | 'denied';
  grantTtlSeconds?: number;
};
```

### 5.3 Signaling Events

```ts
type WebRtcOfferPayload = {
  sdp: string;
  sourceMode: 'app' | 'desktop';
};

type WebRtcAnswerPayload = {
  sdp: string;
};

type WebRtcIceCandidatePayload = {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
};
```

The exact candidate event discriminator is `webrtc.ice.candidate`; `ice.candidate` is invalid.

## 6. DataChannel Protocol

DataChannel messages use compact JSON envelopes:

```ts
type DataChannelEnvelope<TType extends string, TPayload> = {
  v: 1;
  id: EventId;
  t: TType;
  ts: UnixMs;
  p: TPayload;
};
```

### 6.1 Pointer

```ts
type PointerPayload = {
  surfaceId: string;
  x: number; // 0..1
  y: number; // 0..1
  button?: 'left' | 'right' | 'middle';
  pointerType: 'touch' | 'mouse' | 'pen';
  modifiers?: Array<'shift' | 'ctrl' | 'alt' | 'meta'>;
};
```

Events:

```text
control.pointer.move
control.pointer.down
control.pointer.up
```

### 6.2 Scroll

```ts
type ScrollPayload = {
  surfaceId: string;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
};
```

Event:

```text
control.pointer.scroll
```

### 6.3 Keyboard

```ts
type KeyboardTypePayload = {
  text: string;
};

type KeyboardShortcutPayload = {
  keys: Array<'ctrl' | 'shift' | 'alt' | 'meta' | 'enter' | 'escape' | 'tab' | 'backspace' | string>;
};
```

Events:

```text
control.keyboard.type
control.keyboard.shortcut
```

### 6.4 Clipboard

```ts
type ClipboardReadRequestPayload = {
  maxBytes: number;
};

type ClipboardWriteRequestPayload = {
  text: string;
};
```

Clipboard read always requires approval. Clipboard write requires current control permission.

### 6.5 Health

```ts
type HealthStatsPayload = {
  rttMs?: number;
  packetLoss?: number;
  fps?: number;
  bitrateKbps?: number;
  dataChannelBufferedAmount?: number;
};
```

## 7. Upload Protocol

These payload sketches defer all status names and transitions to MC-SM-UPLOAD. Upload and artifact metadata use authenticated HTTP/WS projection, not a `file-meta` DataChannel. Artifact materialization/download is owned by [the file transfer contract](mobile-command-file-transfer-contract.md).

### 7.1 Create Upload

`POST /public/mobile/uploads`

```ts
type CreateUploadRequest = SignedEnvelopeFields & {
  remoteSessionId: RemoteSessionId;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  chunkSize: number;
  exifPolicy?: 'strip_location' | 'preserve';
};

type CreateUploadResponse = {
  uploadId: UploadId;
  status: UploadStatus;
  acceptedChunkSize: number;
  uploadedChunks: number[];
  expiresAt: UnixMs;
};
```

### 7.2 Commit Chunk

`PUT /public/mobile/uploads/{uploadId}/chunks/{chunkIndex}`

Headers:

```text
Content-Type: application/octet-stream
X-Chunk-Sha256: ...
Idempotency-Key: ...
```

Response:

```ts
type CommitChunkResponse = {
  uploadId: UploadId;
  chunkIndex: number;
  status: UploadStatus;
  uploadedChunks: number[];
};
```

### 7.3 Complete Upload

`POST /public/mobile/uploads/{uploadId}/complete`

Response:

```ts
type CompleteUploadResponse = {
  uploadId: UploadId;
  status: 'verified' | 'recoverable' | 'terminal_failed';
  desktopPullRequired: true;
};
```

### 7.4 Upload Status

`GET /public/mobile/uploads/{uploadId}`

```ts
type UploadStatus =
  | 'created'
  | 'uploading'
  | 'verifying'
  | 'verified'
  | 'pulling'
  | 'staging'
  | 'staged'
  | 'recoverable'
  | 'terminal_attached'
  | 'terminal_failed'
  | 'terminal_cancelled'
  | 'terminal_expired'
  | 'terminal_revoked';
```

## 8. Versioning

- Current protocol major version: `1`.
- Unknown major version is rejected.
- Unknown explicitly optional additive fields/events may be ignored.
- Required field removal requires version `2`.
- Changed meaning of an existing enum value requires version `2`.
- A new mandatory event, state, approval action, signature version, redaction rule, or permission semantic requires coordinated compatibility support. An unsupported mandatory semantic returns `MC-ERR-PROTOCOL-CLIENT-UPGRADE-REQUIRED`, disables remote mutation, and may retain read-only projection only when proven safe. Local Lily remains unchanged.
- Compatibility aliases may be accepted at an older boundary but are normalized before domain logic; they are never emitted by new implementations.

## 9. Acceptance Tests

Required tests:

- `test-mobile-protocol-schema.mjs`: validates sample payloads against schema.
- `test-mobile-idempotency.mjs`: duplicate mutating requests do not duplicate side effects.
- `test-mobile-signature-replay.mjs`: stale timestamp, reused nonce, and bad signature are rejected.
- `test-mobile-error-contract.mjs`: all thrown protocol errors return `ApiError`.
- `test-mobile-datachannel-protocol.mjs`: unauthorized or malformed control events are rejected before input injection.
