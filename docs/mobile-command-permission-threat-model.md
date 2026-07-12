# Lily Mobile Command Pro Permission And Threat Model

## 1. Purpose

This document defines the permission policy, approval rules, threat model, fail-safe behavior, and security tests for Lily Mobile Command Pro.

Remote control is safe only if permission failures deny risky actions while ordinary Lily chat remains available.

## 2. Security Invariants

- Authentication facts, credential lifetimes, key rotation, and revocation provenance are owned by [the authentication and identity contract](mobile-command-auth-identity-contract.md); this document consumes them and does not redefine them.
- Default bound-device permission is Chat Only.
- Desktop Control is never granted without explicit desktop-side approval.
- Sensitive Ops are never standing permissions.
- Server authorization is advisory for routing; desktop re-checks all control permissions.
- Mobile-originated mutating events must be signed.
- Permission-policy errors fail closed for control and sensitive actions.
- Remote-control failure must not degrade local Lily sessions, tools, or history.
- Audit failure blocks sensitive actions but does not block ordinary chat.

## 3. Permission Levels

| Level | Name | Standing Session? | Description |
|---|---|---|---|
| 0 | Offline | Yes | No remote session |
| 1 | Chat Only | Yes | Agent messages, upload, artifact view |
| 2 | Observe App | Temporary | View Lily window |
| 3 | Control App | Temporary | Control Lily window |
| 4 | Observe Desktop | Temporary | View selected desktop screen |
| 5 | Control Desktop | Temporary | Control selected desktop screen |
| 6 | Sensitive Ops | No | Scoped approval for one action or short TTL |

## 4. Permission Truth Table

Legend:

- Allow: execute directly.
- Approval: desktop or user approval required.
- Deny: reject with `PERMISSION_DENIED`.
- Sensitive: approval through `approval-service`, audit required.

| Event / Action | L1 Chat | L2 Observe App | L3 Control App | L4 Observe Desktop | L5 Control Desktop | L6 Scoped |
|---|---:|---:|---:|---:|---:|---:|
| `agent.message` | Allow | Allow | Allow | Allow | Allow | Allow |
| upload file to staging | Allow | Allow | Allow | Allow | Allow | Allow |
| view artifact metadata | Allow | Allow | Allow | Allow | Allow | Allow |
| download artifact | Allow | Allow | Allow | Allow | Allow | Allow |
| `screen.subscribe` app | Approval | Allow | Allow | Allow | Allow | Allow |
| `screen.subscribe` desktop | Deny | Deny | Deny | Approval | Allow | Allow |
| pointer in Lily window | Deny | Deny | Allow | Deny | Allow | Allow |
| keyboard in Lily window | Deny | Deny | Allow | Deny | Allow | Allow |
| pointer outside Lily window | Deny | Deny | Deny | Deny | Allow | Allow |
| keyboard outside Lily window | Deny | Deny | Deny | Deny | Allow | Allow |
| clipboard write | Deny | Deny | Allow | Deny | Allow | Allow |
| clipboard read | Sensitive | Sensitive | Sensitive | Sensitive | Sensitive | Allow if scoped |
| switch app screen source | Deny | Approval | Approval | Approval | Approval | Allow if scoped |
| switch desktop screen source | Deny | Deny | Deny | Approval | Approval | Allow if scoped |
| overwrite local file | Sensitive | Sensitive | Sensitive | Sensitive | Sensitive | Allow if scoped |
| delete local file | Sensitive | Sensitive | Sensitive | Sensitive | Sensitive | Allow if scoped |
| external send / submit | Sensitive | Sensitive | Sensitive | Sensitive | Sensitive | Allow if scoped |
| shell command | Sensitive | Sensitive | Sensitive | Sensitive | Sensitive | Allow if scoped |
| software install | Sensitive | Sensitive | Sensitive | Sensitive | Sensitive | Allow if scoped |
| system settings change | Sensitive | Sensitive | Sensitive | Sensitive | Sensitive | Allow if scoped |

## 5. Automatic Revocation

Revoke Level 2+ immediately when:

- WebSocket disconnect exceeds grace period.
- WebRTC disconnect exceeds grace period.
- Mobile app reports background state during active control unless native shell keeps session alive.
- Desktop locks, sleeps, switches user, or loses active OS session.
- Desktop user clicks stop remote control.
- Permission TTL expires.
- Control idle timeout expires.
- Permission policy throws.
- Device is revoked.
- Session is ended by server or desktop.

Grace periods:

| Condition | Grace |
|---|---:|
| WebSocket transient reconnect | 15 seconds |
| WebRTC ICE restart | 20 seconds |
| Mobile app background during Observe | 60 seconds |
| Mobile app background during Control | 10 seconds |
| No control input | 600 seconds |

On revocation, mobile falls back to Chat Only when command channel is still available.

## 6. Approval Model

### 6.1 Approval Types

```ts
type ApprovalActionType =
  | 'desktop_control'
  | 'screen_source_switch'
  | 'clipboard_read'
  | 'file_delete'
  | 'file_overwrite'
  | 'external_send'
  | 'shell_command'
  | 'software_install'
  | 'system_settings'
  | 'high_risk_upload';
```

### 6.2 Approval Scope

```ts
type ApprovalScope = {
  approvalId: string;
  actionType: ApprovalActionType;
  remoteSessionId: string;
  mobileDeviceId: string;
  lilySessionId?: string;
  affectedResourceIds: string[];
  expiresAt: number;
  maxUses: number;
};
```

Rules:

- Default `maxUses` is 1.
- Desktop Control approval may have a short TTL, max 10 minutes.
- Shell/software/system approvals are one-time only.
- Approval cannot be transferred across sessions.
- Approval expires when mobile device disconnects.

### 6.3 Approval UI Requirements

Approval prompt must show:

- Action summary.
- Risk level.
- Affected files/accounts/apps.
- Requesting mobile device.
- Source Lily task.
- Expiration.
- Buttons: allow once, deny. Time-limited allow is shown only for screen/control approvals.

## 7. Threat Model

### 7.1 Threat Actors

| Actor | Capability |
|---|---|
| Malicious mobile device | Has account access or stolen device |
| Stolen pairing token | Scans or leaks QR token |
| Network attacker | Observes or modifies traffic |
| Malicious relay/server | Attempts to inject commands or inspect data |
| Replay attacker | Reuses signed events |
| Compromised old client | Missing new safety checks |
| Malicious file | Uploaded script, macro, zip bomb |
| Local desktop malware | Attempts to abuse helper interfaces |

### 7.2 Threats And Mitigations

| Threat | Mitigation |
|---|---|
| QR token reused | One-time token, hash at rest, short TTL |
| Stolen token binds phone | Desktop-side approval required |
| Event replay | timestamp, nonce, replay cache, idempotency key |
| Server injects control event | Desktop verifies mobile signature and session binding |
| Mobile controls desktop after disconnect | automatic revocation and TTL |
| Permission bypass through DataChannel | all DataChannel events pass permission-policy before adapter |
| Clipboard exfiltration | clipboard read is Sensitive Ops |
| Screen privacy leak | explicit Observe approval, visible desktop indicator |
| File path traversal | desktop generates staging path, ignores mobile path |
| Executable upload abuse | high-risk flag, no auto-execution, approval before run |
| Zip bomb | staging-only extraction, size/file count limits |
| Native bridge abuse | whitelist bridge, no arbitrary command API |
| Old client ignores safety field | server gates by protocol version |
| Audit tampering | local append-only log plus server summary |
| Cross-account pairing | Pairing consume and desktop approval require the same `users.id`; both active `user_devices` rows and the originating `user_sessions.id` are revalidated before grant activation. A phone number or QR possession is insufficient. |
| License/device confusion | `licenses.id` is entitlement only. Remote authority requires an active binding from the selected license to the exact `desktop_device_id`; a mobile binding, same fingerprint, or another desktop's valid license cannot substitute. |
| Replay across desktop devices | Every signed payload binds the exact `desktop_device_id`, remote session, method/event, body hash, timestamp, and nonce. Nonces are scoped to the signing unified `devices.id`; desktop B rejects an envelope for desktop A. |
| Device-key rollback | Key generations increase monotonically; server and paired desktop reject a public key or generation older than the last accepted value. Rotation updates key history and the compatibility key atomically. |
| Revoked mobile reconnect | Reconnect revalidates `user_devices`, active key generation, pairing grant, account session, remote session, and license. Cached grant/token/permission state cannot recreate authority. |
| Approval race | Desktop approval/deny/timeout is a database compare-and-set from `pending`; the unique live-pair constraint and atomic approval use counter allow one terminal result only. Late responses are rejected and audited. |
| Session fixation | Server creates every `mobile_remote_sessions.id`; clients cannot choose it. Reconnect keeps the original full identity tuple, token generation, and expiry, while a replacement device or account requires a new pairing/session. |
| Audit failure | Session start, Level 2+ grant, approval, revoke, key rotation, and sensitive action require durable allowlisted audit before side effect. Failure denies authority and alerts; ordinary Chat Only messages may continue with recoverable diagnostics. |
| Stolen remote token | Mutations require the bound mobile device signature in addition to short-lived token validation. Used refresh-token generation replay revokes the entire token family and remote session. |

## 8. Key Management

Credential issuers, audiences, storage, TTLs, and offline behavior are normative only in [the authentication and identity contract](mobile-command-auth-identity-contract.md). The rules below are permission consequences of that contract.

### 8.1 Mobile Device Key

- Generated on mobile during pairing.
- Public key registered with server and desktop.
- Private key stored in Keychain / Android Keystore through native shell.
- PWA fallback uses WebCrypto non-exportable key when available.
- Key loss requires re-pairing.

### 8.2 Rotation

Rotate when:

- Native keystore reports key invalidated.
- User explicitly refreshes trust.
- Security policy changes require stronger key storage.

Rotation requires the active key to sign the new monotonically increasing generation and the new key to prove possession. If the active key is unavailable, desktop approval or re-pairing is mandatory. A stale backup or the existing key-upsert compatibility path cannot lower the accepted generation.

### 8.3 Revocation

Revocation sources:

- Desktop user removes phone.
- Mobile user logs out and removes binding.
- Server admin risk action.
- Device signature anomalies.
- Account-session logout/revocation or account/device ownership removal.
- License expiration, license disablement, or removal of the exact target desktop binding.

Revocation effects:

- End all remote sessions.
- Invalidate outstanding approvals.
- Reject future signed events.
- Delete server push token association.
- Reject reconnect and refresh using cached tokens or grants.

## 9. Audit Policy

### 9.1 Local Audit

Desktop stores:

- session start/end
- permission grants/revokes
- screen source changes
- remote input mode start/end
- approvals and decisions
- sensitive action summaries
- file upload/download metadata

Do not store:

- screen frames
- raw typed text
- clipboard content
- file body
- prompt private content beyond action summary

### 9.2 Audit Failure Behavior

| Action | Audit Failure |
|---|---|
| agent message | allow, record recoverable diagnostics |
| file upload to staging | allow if non-executable and non-sensitive |
| screen observe/control | deny if session start cannot be audited |
| sensitive action | deny |

## 10. Fail-Safe Rules

| Failure | Result |
|---|---|
| permission-policy exception | deny control/sensitive action, keep Chat Only |
| missing permission state | deny control/sensitive action |
| stale remote session | deny event |
| unknown event type | reject, no fallback execution |
| unknown permission level | deny |
| signature verification unavailable | reject mobile-originated mutating event |
| replay cache unavailable | reject mutating event |
| audit unavailable | deny sensitive action |
| desktop cannot determine active screen | deny desktop observe/control |
| account/license/device tuple mismatch | reject pairing/session/command; do not search for a different identity tuple |
| stale key generation | reject and require approved rotation or re-pairing |
| concurrent approval result | first compare-and-set wins; reject and audit every later result |

## 11. Tests

Required tests:

- `test-remote-session-permissions.mjs`
  - verifies truth table.
- `test-remote-approval-policy.mjs`
  - verifies scoped approval TTL, max uses, session binding.
- `test-remote-threat-replay.mjs`
  - rejects replayed signed event and stale timestamp.
- `test-remote-audit-log.mjs`
  - audit failure blocks sensitive action.
- `test-remote-device-revocation.mjs`
  - revoked device ends sessions and rejects events.
- `test-remote-input-protocol.mjs`
  - DataChannel control events are rejected without permission.
- `test-remote-fail-open.mjs`
  - remote-control failure preserves local Lily chat baseline.

## 12. Review Checklist

- Does every control path call `permission-policy` before side effects?
- Does every sensitive action require scoped approval?
- Does every mobile mutating event verify signature and nonce?
- Does every failure preserve local Lily baseline?
- Are old clients gated by feature/protocol version?
- Can desktop user immediately stop remote control?
- Is no sensitive content stored in audit or telemetry?
