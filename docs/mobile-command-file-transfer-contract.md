# Lily Mobile Command Pro File Transfer Contract

## 1. Purpose

This document defines mobile-to-desktop uploads, desktop-to-mobile artifact downloads, staging, deduplication, retry, risk handling, cleanup, and tests.

Files must enter Lily through existing staging/attachment/artifact mechanisms. Mobile paths or temporary object paths must never be injected directly into the model.

## 2. Invariants

- Every upload has `uploadId`, `idempotencyKey`, full-file sha256, and chunk sha256.
- Server temporary storage is not the source of truth for Lily execution.
- Desktop revalidates hash after pull.
- Desktop staging is required before agent access.
- Files are never written directly into user target directories from mobile.
- Executables, scripts, macros, and risky archives are marked high risk.
- Cleanup cannot delete user-saved files or artifact registry outputs.

## 3. Upload State Machine

```text
created
uploading
uploaded
verified
desktop_pull_pending
desktop_pulled
staged
attached_to_turn
failed_recoverable
failed_final
expired
```

Allowed transitions:

| From | To | Authority |
|---|---|---|
| created | uploading | mobile |
| uploading | uploaded | server |
| uploaded | verified | server |
| verified | desktop_pull_pending | server |
| desktop_pull_pending | desktop_pulled | desktop |
| desktop_pulled | staged | desktop |
| staged | attached_to_turn | agent bridge |
| any non-terminal | failed_recoverable | current authority |
| any non-terminal | failed_final | current authority |
| created/uploading/uploaded/verified | expired | cleanup job |

Terminal states:

- `attached_to_turn`
- `failed_final`
- `expired`

## 4. Upload Metadata

```ts
type UploadRecord = {
  uploadId: string;
  remoteSessionId: string;
  lilySessionId?: string;
  mobileDeviceId: string;
  originalName: string;
  displayName: string;
  mimeType: string;
  sniffedMimeType?: string;
  sizeBytes: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  uploadedChunks: number[];
  status: UploadStatus;
  risk: FileRisk;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

type FileRisk = {
  level: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  requiresApproval: boolean;
};
```

## 5. Chunking

Default chunk size:

- small files under 20 MB: 5 MB
- large files: 10 MB
- maximum chunk size: 25 MB

Rules:

- Last chunk may be smaller.
- Chunks are addressed by zero-based index.
- Each chunk has sha256.
- Server rejects duplicate chunk with different hash.
- Server accepts duplicate chunk with same hash and returns current status.

## 6. Idempotency

Idempotency scope:

| Operation | Key Scope |
|---|---|
| create upload | mobile device + file sha256 + remote session + idempotency key |
| commit chunk | upload id + chunk index + idempotency key |
| complete upload | upload id + idempotency key |
| desktop pull | upload id + desktop device id |
| attach to turn | upload id + lily session id + client message id |

Conflict returns `REQUEST_IDEMPOTENCY_CONFLICT`.

## 7. Mobile Flow

1. User selects file, takes photo, or shares file.
2. Mobile records local upload draft.
3. Mobile computes file sha256.
4. Mobile calls create upload.
5. Mobile uploads missing chunks.
6. Mobile calls complete upload.
7. Mobile waits for desktop pull/staging.
8. Mobile attaches upload to agent message only after `staged`.

If mobile goes offline, it resumes from server upload status.

## 8. Desktop Pull Flow

1. Desktop receives `upload.verified`.
2. Desktop confirms remote session and device trust.
3. Desktop downloads object to remote staging temp.
4. Desktop verifies full sha256.
5. Desktop runs risk classification.
6. Desktop moves file into Lily file staging.
7. Desktop returns `stagedFileId`.
8. Agent bridge attaches `stagedFileId` to user turn.

Desktop must delete temp file on hash failure.

## 9. Risk Classification

High risk extensions:

```text
.exe .msi .bat .cmd .ps1 .sh .app .dmg .pkg .deb .rpm .jar .vbs .js
.docm .xlsm .pptm
```

Archive risk:

- zip/7z/rar/tar are medium by default.
- archive with executable content is high.
- zip bomb indicators are critical.

Rules:

- High/critical risk cannot be auto-executed.
- Office macro files are analyzed as files; macros are not executed.
- Archive extraction goes to staging only.
- Extraction limits: 2 GB expanded size, 10k files, max depth 20.

## 10. EXIF Policy

Photos:

- Default `strip_location`.
- Preserve orientation.
- Preserve timestamp only if needed for user task.
- User can choose preserve metadata per upload.

## 11. Quotas

Defaults:

| Limit | Value |
|---|---:|
| single file | 500 MB |
| total per task | 2 GB |
| mobile device daily | 10 GB |
| account daily | 50 GB |
| temp object TTL | 24 hours |
| unclaimed desktop staged TTL | 2 hours |

Exceeding quota returns:

- `UPLOAD_TOO_LARGE`
- `UPLOAD_QUOTA_EXCEEDED`

## 12. Downloads

### 12.1 Artifact Metadata

```ts
type ArtifactDownloadRecord = {
  artifactId: string;
  remoteSessionId: string;
  lilySessionId: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  sha256?: string;
  availableFrom: 'desktop' | 'temporary_object';
  expiresAt?: number;
};
```

### 12.2 Desktop Local Artifact

If artifact exists only on desktop:

1. Mobile requests download.
2. Desktop verifies mobile/session permission.
3. Desktop uploads artifact to temporary object storage or streams through relay if small.
4. Server returns short-lived URL.
5. Temporary object is deleted after TTL.

### 12.3 Server Temporary Artifact

Download URL:

- short TTL, default 15 minutes
- bound to account, mobile device, artifact id
- no original path in URL
- content-disposition uses sanitized display name

## 13. Cleanup

Server cleanup:

- expired upload chunks
- failed uploads past TTL
- unclaimed temporary artifacts
- orphaned idempotency records after retention

Desktop cleanup:

- failed pull temp files
- unclaimed staged remote files
- old risk scan temp extraction folders

Cleanup must not remove:

- artifact registry files
- files saved by user
- files attached to sealed Lily turns

## 14. Failure Behavior

| Failure | Behavior |
|---|---|
| chunk upload network failure | recoverable, resume missing chunk |
| chunk hash mismatch | reject chunk, recoverable |
| file hash mismatch | delete temp, failed_recoverable |
| quota exceeded | failed_final for current upload |
| desktop offline | stay verified, wait until TTL |
| desktop pull failed | failed_recoverable |
| staging failed | failed_recoverable unless unsupported file |
| high-risk file | approval required before risky action |
| cleanup failed | retry and audit summary |

## 15. Tests

Required tests:

- `test-remote-file-transfer.mjs`
  - end-to-end upload state transitions.
- `test-remote-upload-idempotency.mjs`
  - retry does not duplicate uploads/chunks.
- `test-remote-upload-hash.mjs`
  - chunk and file hash mismatch handling.
- `test-remote-upload-quota.mjs`
  - file/task/device quotas.
- `test-remote-upload-risk.mjs`
  - executable, macro, and archive risk detection.
- `test-remote-upload-staging.mjs`
  - file enters Lily staging before agent attachment.
- `test-remote-artifact-download.mjs`
  - desktop local artifact gets short-lived mobile URL.
- `test-remote-file-cleanup.mjs`
  - cleanup preserves user-saved and artifact files.

## 16. Acceptance Criteria

- Upload resumes after mobile network loss.
- Duplicate chunk retry is safe.
- Desktop hash verification catches corrupt object.
- Agent never receives raw temporary object path.
- High-risk files cannot be executed without approval.
- Expired temporary objects are cleaned.
- Artifact downloads do not expose local desktop paths.
