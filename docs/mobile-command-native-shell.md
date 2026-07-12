# Lily Mobile Command Pro Native Capability Shell

## 1. Purpose

The mobile client is Web-first. The native layer is a thin capability shell for iOS and Android. It exposes system capabilities that are unreliable or unavailable in plain PWA, while the Web app owns UI and protocol validation. Lifecycle business state is canonical in [the state machines](mobile-command-state-machines.md), errors/retries in [the error catalog](mobile-command-error-recovery-catalog.md), and method coverage in [the API completeness matrix](mobile-command-api-completeness-matrix.md).

The API completeness matrix is also the sole route/operation authority. Native methods are local capability calls and MUST NOT introduce alternate server routes.

## 2. Non-Negotiable Boundary

Native shell may:

- store device keys in Keychain / Android Keystore
- sign payloads with a non-exportable key
- perform background uploads
- receive push notifications
- receive shared files from the OS share sheet
- open camera or scanner fallback
- read permission status and request permissions
- expose app foreground/background lifecycle

Native shell must not:

- implement chat UI
- store Lily conversation state
- decide permission policy
- build remote protocol envelopes
- bypass Web approval flow
- inject remote input directly
- expose arbitrary command execution
- read desktop screen or clipboard

All native results must pass through typed Web adapters before state changes.

## 3. Supported Platforms

| Platform | Minimum | Required |
|---|---|---|
| iOS | 16+ | WKWebView, Keychain, APNs, background URLSession |
| iPadOS | 16+ | same as iOS, responsive layout |
| Android | 10+ | WebView/Chrome Custom runtime, Keystore, FCM, WorkManager |

Plain PWA remains supported for reduced capability. Native shell improves reliability.

## 4. Bridge Transport

Bridge calls use request/response messages:

```ts
type NativeBridgeRequest<TMethod extends string, TParams> = {
  id: string;
  version: 1;
  method: TMethod;
  params: TParams;
};

type NativeBridgeResponse<TResult> =
  | {
      id: string;
      ok: true;
      result: TResult;
    }
  | {
      id: string;
      ok: false;
      error: NativeBridgeError;
    };

type NativeBridgeError = {
  code: NativeBridgeErrorCode;
  recoverable: boolean;
  messageKey: string;
  details?: Record<string, unknown>;
};
```

Rules:

- Unknown method returns `MC-ERR-NATIVE-METHOD-UNSUPPORTED`.
- Native must validate params.
- Web must enforce timeout per call.
- Native must never return raw stack traces.
- Bridge messages must not contain device private keys.

## 5. Error Codes

The normative native errors are the `MC-ERR-NATIVE-*` rows in [the error recovery catalog](mobile-command-error-recovery-catalog.md). The names below are legacy bridge aliases accepted only at a compatibility adapter; new native implementations return canonical codes and do not invent local recovery policy.

| Legacy alias | Canonical code |
|---|---|
| `NATIVE_METHOD_UNSUPPORTED` | `MC-ERR-NATIVE-METHOD-UNSUPPORTED` |
| `NATIVE_PLATFORM_UNSUPPORTED` | `MC-ERR-NATIVE-METHOD-UNSUPPORTED` |
| `NATIVE_PERMISSION_DENIED` | `MC-ERR-NATIVE-PERMISSION-DENIED` |
| `NATIVE_PERMISSION_RESTRICTED` | `MC-ERR-NATIVE-PERMISSION-DENIED` |
| `NATIVE_KEY_NOT_FOUND` | `MC-ERR-NATIVE-KEY-INVALIDATED` |
| `NATIVE_KEY_INVALIDATED` | `MC-ERR-NATIVE-KEY-INVALIDATED` |
| `NATIVE_KEYSTORE_UNAVAILABLE` | `MC-ERR-NATIVE-KEYSTORE-UNAVAILABLE` |
| `NATIVE_SIGN_FAILED` | `MC-ERR-NATIVE-SIGN-FAILED` |
| `NATIVE_UPLOAD_FAILED` | `MC-ERR-NATIVE-UPLOAD-FAILED` |
| `NATIVE_UPLOAD_CANCELLED` | `MC-ERR-NATIVE-UPLOAD-CANCELLED` |
| `NATIVE_UPLOAD_BACKGROUND_UNAVAILABLE` | `MC-ERR-NATIVE-UPLOAD-FAILED` |
| `NATIVE_PUSH_UNAVAILABLE` | `MC-ERR-NATIVE-METHOD-UNSUPPORTED` |
| `NATIVE_SHARE_NO_FILES` | `MC-ERR-PROTOCOL-INVALID` |
| `NATIVE_FILE_ACCESS_DENIED` | `MC-ERR-NATIVE-PERMISSION-DENIED` |
| `NATIVE_FILE_TOO_LARGE` | `MC-ERR-UPLOAD-TOO-LARGE` |
| `NATIVE_CAMERA_UNAVAILABLE` | `MC-ERR-NATIVE-METHOD-UNSUPPORTED` |
| `NATIVE_SCANNER_FAILED` | `MC-ERR-NATIVE-METHOD-UNSUPPORTED` |
| `NATIVE_TIMEOUT` | `MC-ERR-NATIVE-TIMEOUT` |

This table is exhaustive for accepted native aliases. Each alias has exactly one target; native code emits only canonical values and never applies closest-code inference.

## 6. Secure Key API

### 6.1 Generate Key

```ts
type GenerateDeviceKeyParams = {
  label: string;
  requireBiometric?: boolean;
};

type GenerateDeviceKeyResult = {
  keyHandle: string;
  publicKey: string;
  algorithm: 'Ed25519';
  hardwareBacked?: boolean;
};
```

Method:

```text
secureKey.generateDeviceKey
```

### 6.2 Sign

```ts
type SignParams = {
  keyHandle: string;
  canonicalDigest: string;
  signatureVersion: 1;
};

type SignResult = {
  signature: string;
  algorithm: 'Ed25519';
};
```

Method:

```text
secureKey.sign
```

### 6.3 Delete Key

```ts
type DeleteDeviceKeyParams = {
  keyHandle: string;
};

type DeleteDeviceKeyResult = {
  deleted: boolean;
};
```

Method:

```text
secureKey.deleteDeviceKey
```

Rules:

- Private key is non-exportable.
- Web stores only `keyHandle`.
- Only a permanently invalidated key confirmed by the OS maps to `MC-ERR-NATIVE-KEY-INVALIDATED`, after which Web requires approved rotation or re-pairing. Temporary keystore/system unavailability maps to `MC-ERR-NATIVE-KEYSTORE-UNAVAILABLE`, denies the current sensitive operation, and may be retried only after explicit user action or a foreground/system-state change; it never triggers automatic re-pair. A signature attempt that proves it produced no signature or side effect maps to `MC-ERR-NATIVE-SIGN-FAILED` and may retry at most once with the identical canonical digest; ambiguous or repeated failure stops. Native signs only the versioned canonical digest assembled by the typed Web identity adapter; it never accepts arbitrary remote protocol or script text.

## 7. Background Upload API

### 7.1 Start Upload

```ts
type NativeUploadRequest = {
  uploadId: string;
  uploadHandle: string;
  nativeFileHandle: string;
  sizeBytes: number;
  sha256: string;
  byteRange?: {
    start: number;
    endInclusive: number;
  };
};

type NativeUploadHandle = {
  handle: string;
  uploadId: string;
};
```

Method:

```text
upload.startBackgroundUpload
```

`uploadHandle` is an opaque server-signed capability for exactly one upload. Native, not Web, validates its signature and expiry and requires claims for the pinned Lily service audience, exact desktop/mobile device tuple, exact `uploadId`, and canonical background-upload purpose. Native derives the built-in trusted service origin and canonical upload path after validation. Web cannot mint, parse, or supply the origin, URL, HTTP method, credentials, token, or headers.

`nativeFileHandle` is an opaque reference issued earlier by the current app installation's secure native file registry. The registry binds it to the current mobile device/app installation, immutable file metadata, `purpose=background_upload`, expiry, and exactly one `uploadId`. Web receives no filesystem/content URI and cannot mint or parse a handle. Native resolves it only after both handles validate and atomically consumes or revokes it according to the registry policy.

For a range request, native MUST validate `0 <= start <= endInclusive < sizeBytes` before resolving or reading the file handle. Any mismatch between the request, signed upload claims, registry metadata, actual file size/hash, or range returns `MC-ERR-PROTOCOL-INVALID`; native reads and uploads zero bytes. Ordinary foreground Web uploads use the canonical HTTP upload endpoints directly and do not call this native background API.

### 7.2 Status

```ts
type NativeUploadStatus = {
  handle: string;
  uploadId: string;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  bytesSent: number;
  totalBytes?: number;
  errorCode?: NativeBridgeErrorCode;
};
```

These are native transport states only. They never substitute for MC-SM-UPLOAD or imply `verified`, `staged`, or `terminal_attached`; after Web/native restart the server/desktop checkpoint is reconciled before progress is projected.

Method:

```text
upload.getUploadStatus
```

### 7.3 Cancel

```ts
type CancelUploadParams = {
  handle: string;
};

type CancelUploadResult = {
  cancelled: boolean;
};
```

Method:

```text
upload.cancelUpload
```

Rules:

- Web upload state machine remains source of truth.
- Native reports transport progress only.
- Native cannot mark upload `verified` or `staged`.
- iOS uses background `URLSession`.
- Android uses WorkManager / foreground service as required by OS.
- A user cancellation maps to `MC-ERR-NATIVE-UPLOAD-CANCELLED`, terminalizes the native transport as `cancelled`, and projects canonical MC-SM-UPLOAD cancellation without retry or error escalation; telemetry is informational.

## 8. Push API

### 8.1 Register

```ts
type PushRegisterResult = {
  platform: 'ios' | 'android';
  pushToken: string;
  environment?: 'sandbox' | 'production';
};
```

Method:

```text
push.register
```

### 8.2 Unregister

```ts
type PushUnregisterResult = {
  unregistered: boolean;
};
```

Method:

```text
push.unregister
```

Notification payload must contain only:

```ts
type PushPayload = {
  type:
    | 'approval_required'
    | 'task_completed'
    | 'desktop_offline'
    | 'remote_control_revoked'
    | 'file_ready';
  remoteSessionId?: string;
  lilySessionId?: string;
  artifactId?: string;
  correlationId: string;
};
```

No sensitive file names or message content in push body unless user opts in.

## 9. Share Sheet API

```ts
type SharedFile = {
  shareId: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  nativeFileHandle: string;
  expiresAt: number; // Unix time in milliseconds
};

type GetPendingSharedFilesResult = {
  files: SharedFile[];
};
```

Method:

```text
share.getPendingSharedFiles
```

Rules:

- Native copies shared files into app-accessible temporary storage.
- The secure native file registry issues `nativeFileHandle`; no path, file URI, or content URI crosses the bridge.
- The handle is bound to the current app installation/mobile device, immutable metadata, allowed purpose, and expiry. It is revoked on acknowledgement, TTL expiry, app data reset, device revocation, or source cleanup.
- Web must explicitly enqueue them into upload state machine.
- Before background upload, native exchanges/binds the shared-file handle for `purpose=background_upload` and one exact `uploadId`; Web cannot reuse or retarget it.
- Native deletes temporary shared files and revokes their handles after Web acknowledgement or TTL.

## 10. Permissions API

```ts
type PermissionName =
  | 'camera'
  | 'microphone'
  | 'notifications'
  | 'photos'
  | 'files'
  | 'localNetwork';

type PermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'notDetermined'
  | 'unsupported';
```

Methods:

```text
permissions.getStatus
permissions.request
```

Params:

```ts
type PermissionParams = {
  name: PermissionName;
};
```

## 11. Camera / Scanner API

Native scanner is fallback when Web camera APIs are unavailable.

```ts
type ScanQrResult = {
  text: string;
};
```

Method:

```text
camera.scanQr
```

Rules:

- Native returns QR text only.
- Web validates pairing payload.
- Native does not consume pairing token directly.

## 12. Lifecycle API

Native emits events:

```ts
type NativeLifecycleEvent =
  | { type: 'app.foreground'; timestamp: number }
  | { type: 'app.background'; timestamp: number }
  | { type: 'network.changed'; online: boolean; expensive?: boolean; constrained?: boolean }
  | { type: 'upload.progress'; status: NativeUploadStatus }
  | { type: 'push.opened'; payload: PushPayload };
```

Web uses lifecycle events to pause control, recover uploads, and deep-link notifications.

MC-SM-BACKGROUND owns the resulting permission/WebRTC state. Native owns only monotonic lifecycle observation and background transport. Voice capture methods, when supported, return a local audio descriptor; transcript/voice-command patch semantics remain owned by `mobile-command-voice-input.md` and the agent bridge, not native lifecycle or upload transport.

## 13. Platform Notes

### 13.1 iOS

- Use WKWebView.
- Use Keychain for `keyHandle`.
- Use background URLSession for uploads.
- APNs for push.
- iOS may suspend Web timers in background; native lifecycle must notify on resume.
- Local network access may need user permission.

### 13.2 Android

- Use Android Keystore.
- Use FCM for push.
- Use WorkManager for background uploads.
- Foreground service may be required for long uploads.
- Android native registry resolution supports content-provider sources internally; provider URIs never cross the Web bridge.

## 14. Tests

Required tests:

- `test-mobile-native-bridge-schema.mjs`
  - validates all bridge request/response payloads.
- `test-mobile-native-key-contract.mjs`
  - private key is never returned; invalidated key requires re-pairing.
- `test-mobile-native-upload-contract.mjs`
  - native upload cannot mark server upload verified/staged.
- `test-mobile-native-permission-contract.mjs`
  - unsupported permission degrades to Web fallback.
- `test-mobile-native-share-contract.mjs`
  - shared files enter upload queue only after Web ack.

## 15. Implementation Checklist

- Bridge methods are whitelisted.
- All params are schema-validated.
- Private keys are non-exportable.
- Native upload status is not business upload status.
- Push payload avoids sensitive content.
- Web owns all state machines.
- No arbitrary command or eval bridge exists.
