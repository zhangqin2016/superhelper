# Lily Mobile Command Pro Native Capability Shell

## 1. Purpose

The mobile client is Web-first. The native layer is a thin capability shell for iOS and Android. It exposes system capabilities that are unreliable or unavailable in plain PWA, while the Web app owns UI and protocol validation. Lifecycle business state is canonical in [the state machines](mobile-command-state-machines.md), errors/retries in [the error catalog](mobile-command-error-recovery-catalog.md), and method coverage in [the API completeness matrix](mobile-command-api-completeness-matrix.md).

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

- Unknown method returns `NATIVE_METHOD_UNSUPPORTED`.
- Native must validate params.
- Web must enforce timeout per call.
- Native must never return raw stack traces.
- Bridge messages must not contain device private keys.

## 5. Error Codes

The normative native errors are the `MC-ERR-NATIVE-*` rows in [the error recovery catalog](mobile-command-error-recovery-catalog.md). The names below are legacy bridge aliases accepted only at a compatibility adapter; new native implementations return canonical codes and do not invent local recovery policy.

```text
NATIVE_METHOD_UNSUPPORTED
NATIVE_PLATFORM_UNSUPPORTED
NATIVE_PERMISSION_DENIED
NATIVE_PERMISSION_RESTRICTED
NATIVE_KEY_NOT_FOUND
NATIVE_KEY_INVALIDATED
NATIVE_KEYSTORE_UNAVAILABLE
NATIVE_SIGN_FAILED
NATIVE_UPLOAD_FAILED
NATIVE_UPLOAD_CANCELLED
NATIVE_UPLOAD_BACKGROUND_UNAVAILABLE
NATIVE_PUSH_UNAVAILABLE
NATIVE_SHARE_NO_FILES
NATIVE_FILE_ACCESS_DENIED
NATIVE_FILE_TOO_LARGE
NATIVE_CAMERA_UNAVAILABLE
NATIVE_SCANNER_FAILED
NATIVE_TIMEOUT
```

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
- Key invalidation maps to `MC-ERR-NATIVE-KEY-INVALIDATED`, then Web requires approved rotation or re-pairing. Native signs only the versioned canonical digest assembled by the typed Web identity adapter; it never accepts arbitrary remote protocol or script text.

## 7. Background Upload API

### 7.1 Start Upload

```ts
type NativeUploadRequest = {
  uploadId: string;
  method: 'PUT' | 'POST';
  url: string;
  headers: Record<string, string>;
  fileUri: string;
  byteRange?: {
    start: number;
    endInclusive: number;
  };
  sha256?: string;
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
  fileUri: string;
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
- Web must explicitly enqueue them into upload state machine.
- Native deletes temporary shared files after Web ack or TTL.

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
- Android file URIs must be content URI aware.

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
