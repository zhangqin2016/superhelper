# Lily Mobile Command Pro Canonical State Machines

## 1. Scope And Conventions

This document is the canonical owner of Mobile Command lifecycle state and event names (MC-SPEC-011). Domain contracts may describe payloads and side effects, but MUST reference these identifiers and MUST NOT create local states or transitions. Errors are owned by [the error recovery catalog](mobile-command-error-recovery-catalog.md).

All machines use durable compare-and-set transitions. `initial` marks the creation state; `terminal` means no outgoing transition except an exact idempotent read/repeat. An event not listed for the current state is illegal and returns `MC-ERR-PROTOCOL-ILLEGAL-TRANSITION` without mutation. Exact repeats return the persisted result; same idempotency key with a different canonical payload returns `MC-ERR-PROTOCOL-IDEMPOTENCY-CONFLICT`. Named timeouts use the authority clock and are explicit events in the tables. Device/grant/account/license revocation has precedence over every ordinary event and timeout, immediately applying MC-SM-REVOCATION. Remote failure preserves local Lily; authority uncertainty denies remote action.

## 2. MC-SM-PAIRING — Pairing

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `initial` (initial) | `pairing.start` | signed active desktop, feature enabled | `challenge_created` | persist one-time hashed challenge and expiry | `pairing.challenge.created` | `terminal_rejected` + catalog error |
| `challenge_created` | `pairing.consume` | signed mobile; token, user, license and desktop tuple match | `mobile_proved` | atomically consume token and bind key generation | `pairing.mobile.proved` | `terminal_expired` or `terminal_rejected` |
| `challenge_created` | `pairing.timeout` | authority clock reached expiry | `terminal_expired` (terminal) | invalidate token | `pairing.expired` | — |
| `mobile_proved` | `pairing.approve` | explicit desktop approval; identity tuple still active | `terminal_paired` (terminal) | create grant and audit atomically | `pairing.completed` | `terminal_rejected` |
| `mobile_proved` | `pairing.reject` / `pairing.timeout` | desktop decision or approval expiry | `terminal_rejected` (terminal) | invalidate challenge; no grant | `pairing.rejected` | — |
| `initial` / `challenge_created` / `mobile_proved` | `device.revoked` | either bound desktop/mobile device is durably revoked | `terminal_revoked` (terminal) | invalidate challenge/approval, deny grant creation, cleanup pairing secret, and audit | `pairing.revoked` | reconciliation retries while authority remains denied |

Persistence: challenge, consume result, key generation, approval result and grant are server durable. Restart reloads them; consumed tokens never reopen. Exact start/consume/decision retries return the same record.

## 3. MC-SM-REMOTE-SESSION — Remote Session

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `initial` (initial) | `session.create` | full identity tuple, pairing grant, license, signature and nonce active | `active_chat` | server creates ID/token generation and durable session | `session.created` | `terminal_denied` |
| `active_chat` | `session.permission_changed` | MC-SM-PERMISSION grants L2+ | `active_live` | bind temporary grant | `session.mode.changed` | remain `active_chat` |
| `active_live` | `session.permission_revoked` | any revocation/TTL/disconnect precedence | `active_chat` | stop input/media authority | `session.mode.changed` | — |
| `active_chat` | `session.refresh` | same tuple/token family; signed nonce fresh; presented refresh token is current and unused | `active_chat` | atomically consume the current one-time refresh token, rotate access-token generation, increment refresh-family generation, and persist the next one-time refresh token before returning either token | `session.refreshed` | `terminal_revoked` on used-token replay/theft; no partial token response |
| `active_live` | `session.refresh` | same tuple/token family; signed nonce fresh; presented refresh token is current and unused | `active_live` | atomically consume the current one-time refresh token, rotate access-token generation, increment refresh-family generation, and persist the next one-time refresh token before returning either token | `session.refreshed` | `terminal_revoked` on used-token replay/theft; no partial token response |
| `active_chat` / `active_live` | `session.end` / `session.timeout` | actor authorized or absolute TTL reached | `terminal_ended` (terminal) | revoke token family, permissions and approvals | `session.ended` | — |
| `initial` / `active_chat` / `active_live` | `device.revoked` | MC-SM-REVOCATION wins | `terminal_revoked` (terminal) | cascade revocation | `session.revoked` | — |

Persistence: server session/token generation is durable; desktop permission binding is durable enough to fail safe after restart. Restart never reconstructs L2+ from mobile cache; it returns `active_chat` until revalidated. Exact create/end retries are idempotent.

## 4. MC-SM-PERMISSION — Observe/Control Permission

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `chat_only` (initial) | `permission.request` | active session; requested level known | `pending_desktop` | create bounded desktop request | `permission.requested` | remain `chat_only` |
| `pending_desktop` | `permission.allow` | desktop CAS wins; indicator/audit available | `observe_active` or `control_active` | mint scoped TTL grant | `permission.granted` | `chat_only` |
| `pending_desktop` | `permission.deny` / `permission.timeout` | first terminal CAS | `chat_only` | terminalize request | `permission.denied` / `permission.expired` | — |
| `observe_active` | `permission.elevate` | desktop approval required | `pending_desktop` | pause new control input | `permission.requested` | `chat_only` |
| `observe_active` / `control_active` | `permission.revoke` / `permission.timeout` / `desktop.locked` | any safety trigger | `chat_only` | stop capture/input authority; audit | `permission.revoked` | — |
| `control_active` | `mobile.background` | MC-SM-BACKGROUND control grace starts | `control_suspended` | pause all input | `permission.suspended` | `chat_only` on timeout |
| `control_suspended` | `mobile.foreground` | within 10 s; tuple and WebRTC revalidated | `control_active` | resume input | `permission.resumed` | `chat_only` |
| `chat_only` / `pending_desktop` / `observe_active` / `control_active` / `control_suspended` | `device.revoked` | MC-SM-REVOCATION durable commit wins | `terminal_revoked` (terminal) | invalidate pending request/grant, stop capture/input, cleanup authority, and audit | `permission.revoked` and `device.revoked` | reconciliation retries while authority remains denied |

Persistence: pending request and grant expiry/use scope are desktop durable; live input authorization is volatile and starts disabled after restart. Repeated allow/deny returns the winning CAS. Revocation always beats late allow.

## 5. MC-SM-APPROVAL — Scoped Sensitive Approval

Canonical actions are `desktop_control`, `screen_source_switch`, `clipboard_read`, `file_delete`, `file_overwrite`, `external_send`, `shell_command`, `software_install`, `system_settings`, and `high_risk_upload`.

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `initial` (initial) | `approval.request` | action in canonical set; session/device/resource bound | `pending` | persist scope, expiry and maxUses | `approval.requested` | `terminal_denied` |
| `pending` | `approval.allow_once` / `approval.allow_timed` | desktop CAS wins; timed only for screen/control | `granted` | durable audit before authority | `approval.granted` | `terminal_denied` |
| `pending` | `approval.deny` / `approval.timeout` | first terminal CAS | `terminal_denied` (terminal) | audit denial/expiry | `approval.denied` / `approval.expired` | — |
| `granted` | `approval.consume` | exact action/session/device/resources; uses and TTL valid | `granted` or `terminal_consumed` (terminal) | decrement atomically, then permit side effect | `approval.consumed` | `terminal_revoked` |
| `pending` / `granted` | `permission.revoke` / `device.revoked` / `session.end` | revocation precedence | `terminal_revoked` (terminal) | invalidate unused authority | `approval.revoked` | — |
| `initial` | `device.revoked` | requesting device is durably revoked before request persistence | `terminal_revoked` (terminal) | create no approval, cleanup provisional correlation, and audit | `approval.revoked` and `device.revoked` | reconciliation retries while authority remains denied |

Persistence: all approval states, generations and uses are desktop durable. Restart reloads but does not replay a sensitive side effect. Repeated decisions/consumes return the prior result; payload mismatch conflicts.

## 6. MC-SM-WEBRTC — WebRTC

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `idle` (initial) | `webrtc.start` | active L2+ grant and source allowed | `signaling` | obtain TURN and send offer | `webrtc.offer` | `chat_only` |
| `signaling` | `webrtc.answer` | session/generation match within 10 s | `ice_connecting` | set descriptions | `webrtc.answer.applied` | `chat_only` |
| `signaling` | `webrtc.ice.candidate` | canonical candidate envelope/generation validates and append succeeds before signaling deadline | `signaling` | append candidate idempotently | no second wire event; transport may acknowledge the same event ID | on validation/append failure before deadline: reject candidate, return `MC-ERR-WEBRTC-SIGNALING-FAILED` for the same event ID, remain `signaling`, and keep waiting; no permission change |
| `ice_connecting` | `webrtc.ice.candidate` | canonical candidate envelope/generation validates and append succeeds before ICE deadline | `ice_connecting` | append candidate idempotently | no second wire event; transport may acknowledge the same event ID | on validation/append failure before deadline: reject candidate, return `MC-ERR-WEBRTC-SIGNALING-FAILED` for the same event ID, remain `ice_connecting`, and keep waiting; no permission change |
| `signaling` / `ice_connecting` | `webrtc.timeout` / `webrtc.terminal_failure` | signaling 10 s or ICE 20 s deadline elapsed, or failure is terminal | `chat_only` | close peer/media/data and revoke L2+ | `webrtc.closed` | — |
| `ice_connecting` | `webrtc.connected` | ICE within 20 s, channels/source authorized | `connected` | start permitted media; input still policy-gated | `webrtc.connected` | `chat_only` |
| `connected` | `webrtc.degraded` | quality threshold crossed | `degraded` | reduce bitrate/fps/resolution | `webrtc.degraded` | `restarting_ice` |
| `connected` / `degraded` | `webrtc.disconnected` | session still active | `restarting_ice` | pause input; one ICE restart | `webrtc.reconnecting` | `signaling_reconnecting` |
| `restarting_ice` | `webrtc.restart.failed` | restart exhausted/20 s | `signaling_reconnecting` | one signaling reconnect | `webrtc.reconnecting` | `chat_only` |
| `restarting_ice` | `webrtc.connected` | ICE restart succeeds before 20 s and identity/permission/source all revalidate | `connected` | resume only the still-authorized mode | `webrtc.reconnected` | `signaling_reconnecting` on restart failure/deadline |
| `signaling_reconnecting` | `webrtc.connected` | the single signaling reconnect succeeds before its deadline and identity/permission/source all revalidate | `connected` | resume only the still-authorized mode | `webrtc.reconnected` | `chat_only` on failure/deadline; close media/data and revoke L2+ |
| `idle` / `signaling` / `ice_connecting` / `connected` / `degraded` / `restarting_ice` / `signaling_reconnecting` | `permission.revoke` / `webrtc.timeout` | permission/timeout precedence | `chat_only` | close media/data; revoke L2+ | `webrtc.closed` | — |
| `idle` / `signaling` / `ice_connecting` / `connected` / `degraded` / `restarting_ice` / `signaling_reconnecting` / `chat_only` | `device.revoked` | MC-SM-REVOCATION durable commit wins over every media/session event | `closed` (terminal) | close peer/media/data and release TURN; revoke remote tokens, approvals, push binding, upload/artifact authority; schedule owned temporary cleanup; persist audit/reconciliation | `webrtc.closed` and `device.revoked` | reconciliation retries while all remote authority remains denied |
| `chat_only` | `session.end` | authorized end | `closed` (terminal) | release peer/TURN resources | `webrtc.closed` | — |

Only `closed` is terminal; `chat_only` permits a fresh explicitly approved start. Peer state is volatile. Restart begins `idle`/`chat_only`, never silently restores control. Duplicate candidates are safe by candidate identity; offers/answers require generation idempotency.

## 7. MC-SM-UPLOAD — Upload And Desktop Staging

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `created` (initial) | `upload.chunk.accepted` | signed session; chunk hash/index valid | `uploading` | persist chunk receipt | `upload.progress` | `recoverable` with `resume_state='created'` |
| `uploading` | `upload.chunk.accepted` | duplicate hash matches or new missing chunk | `uploading` | idempotent receipt/update | `upload.progress` | `recoverable` with `resume_state='uploading'` |
| `uploading` | `upload.complete` | all chunks present; same upload idempotency/payload | `verifying` | persist immutable chunk manifest and begin full-hash verification | `upload.verifying` | `recoverable` with `resume_state='uploading'` |
| `verifying` | `upload.verification.passed` | full hash and object seal succeed | `verified` | atomically seal temporary object | `upload.verified` | `recoverable` with `resume_state='verifying'` or `terminal_failed` |
| `verified` | `upload.desktop_pull` | desktop/session/device authorized | `pulling` | stream to desktop temp | `upload.pull.started` | `recoverable` with `resume_state='verified'` |
| `pulling` | `upload.pull.completed` | desktop full hash matches | `staging` | classify risk and invoke existing staging adapter | `upload.pull.completed` | `recoverable` with `resume_state='pulling'` |
| `staging` | `upload.staged` | staging succeeds | `staged` | persist opaque `stagedFileId` | `upload.staged` | `recoverable` with `resume_state='staging'` or `terminal_failed` |
| `staged` | `upload.attach` | same Lily session and command admission | `terminal_attached` (terminal) | attach once through bridge | `upload.attached` | `recoverable` with `resume_state='staged'` |
| `recoverable` | `upload.retry` | `resume_state='created'`; catalog budget/TTL valid; same idempotency/payload | `created` | clear transient error only | `upload.retrying` | `terminal_failed` |
| `recoverable` | `upload.retry` | `resume_state='uploading'`; catalog budget/TTL valid; same idempotency/payload | `uploading` | resume missing chunks only | `upload.retrying` | `terminal_failed` |
| `recoverable` | `upload.retry` | `resume_state='verifying'`; catalog budget/TTL valid; same immutable manifest | `verifying` | rerun full-hash verification, never accept new chunks | `upload.retrying` | `terminal_failed` |
| `recoverable` | `upload.retry` | `resume_state='verified'`; catalog budget/TTL valid; sealed object unchanged | `verified` | await/reissue authorized desktop pull | `upload.retrying` | `terminal_failed` |
| `recoverable` | `upload.retry` | `resume_state='pulling'`; catalog budget/TTL valid; same desktop binding | `pulling` | resume/restart temp pull and re-hash | `upload.retrying` | `terminal_failed` |
| `recoverable` | `upload.retry` | `resume_state='staging'`; catalog budget/TTL valid; same verified temp file | `staging` | retry risk/staging adapter | `upload.retrying` | `terminal_failed` |
| `recoverable` | `upload.retry` | `resume_state='staged'`; catalog budget/TTL valid; same session/command key | `staged` | retry attachment admission only | `upload.retrying` | `terminal_failed` |
| `created` / `uploading` / `verifying` / `verified` / `pulling` / `staging` / `staged` / `recoverable` | `upload.cancel` / `upload.expire` | owner or authority clock | `terminal_cancelled` / `terminal_expired` (terminal) | abort transport and cleanup temp | `upload.cancelled` / `upload.expired` | — |
| `created` / `uploading` / `verifying` / `verified` / `pulling` / `staging` / `staged` / `recoverable` | `device.revoked` | revocation precedence | `terminal_revoked` (terminal) | block attach/download; cleanup by retention | `upload.revoked` | — |

Persistence: the canonical upload record durably stores `state`, nullable `resume_state` constrained to `created|uploading|verifying|verified|pulling|staging|staged`, `error_code`, `retry_count`, `idempotency_key`, canonical payload hash, immutable chunk manifest/hash, expiry, and version for CAS. `resume_state` MUST be non-null iff `state='recoverable'`; entering `recoverable` and recording its source checkpoint is one atomic write, and leaving it clears `resume_state` atomically. Server stores chunk/hash checkpoints; desktop stores pull/staging checkpoint and opaque staged ID. Native transport status is never this machine's state. Restart reads these fields and resumes only through the matching explicit row; it never guesses `verified`, `staged`, or attachment success.

## 8. MC-SM-REVOCATION — Device Revocation

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `active` (initial) | `device.revoke` | authorized desktop/mobile/admin risk actor; row/version current | `revoking` | first atomically CAS `active→revoking`, persist deny intent/revocation actor/reason/time and durable audit intent; only after commit start cascades | `device.revocation.started` | CAS/audit-intent transaction failure leaves `active` with no claimed revocation and returns error; no cascade runs |
| `revoking` | `device.revocation.commit` | durable deny intent exists and every required cascade is durably reconciled | `terminal_revoked` (terminal) | end sessions; invalidate tokens/approvals/push; cancel owned `admitted` queue/uploads; persist completion audit | `device.revoked` | any step failure records step/attempt/audit diagnostic, returns `MC-ERR-REVOCATION-RECONCILIATION-FAILED`, and remains `revoking` with authority denied |
| `revoking` | `device.revoke` | same device revocation is repeated idempotently | `revoking` | return/continue the durable revocation reconciliation; grant no authority | `device.revocation.started` | remain `revoking` with authority denied |
| `terminal_revoked` | any remote authority event | always | `terminal_revoked` | reject; return stored revocation | `device.revoked` | — |

Persistence: `revoking` plus deny intent is the durable authority boundary. Restart finding `revoking` MUST deny all authority and idempotently reconcile each cascade/audit step from persisted checkpoints until `terminal_revoked`; it never rolls back to `active`. Server revocation is permanent unless a new explicit pairing creates a new grant. Already `dispatching`/`engine_accepted` turns may continue locally, but the device gets no further control, answer, cancellation, artifact or reconnect authority.

## 9. MC-SM-RECONNECT — Projection/Command Reconnect

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `disconnected` (initial) | `reconnect.request` | full tuple revalidated; cursor supplied | `validating_cursor` | acquire per-session projection/admission lock | `reconnect.validating` | `terminal_denied` |
| `validating_cursor` | `reconnect.cursor.valid` | epoch matches and journal range contiguous | `replaying` | replay allowlisted journal after cursor | `reconnect.replay.started` | `snapshotting` |
| `validating_cursor` | `reconnect.cursor.gap` / `reconnect.epoch.mismatch` | gap, restart or unknown cursor | `snapshotting` | discard incremental assumption | `reconnect.snapshot.required` | `terminal_denied` |
| `snapshotting` | `reconnect.snapshot.cut` | authorized atomic snapshot/high-water captured | `subscribing` | send snapshot then subscribe after cut | `reconnect.snapshot` | `disconnected` |
| `replaying` / `subscribing` | `reconnect.ack` | client acknowledges current epoch/seq | `connected` | persist delivery cursor optimization | `reconnect.completed` | `disconnected` |
| `disconnected` / `validating_cursor` / `replaying` / `snapshotting` / `subscribing` / `connected` | `device.revoked` | revocation precedence | `terminal_denied` (terminal) | disclose no snapshot/events | `reconnect.denied` | — |

Projection journal/epoch are desktop durable; relay cursors are delivery hints only. Restart rotates or proves the epoch and uses a snapshot. Repeat reconnects are read-idempotent. A reconnect never re-dispatches a command in `dispatching`/`dispatch_unknown`.

## 10. MC-SM-BACKGROUND — Mobile Foreground/Background

| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
| `foreground` (initial) | `mobile.background` | native/web lifecycle event monotonic | `background_grace` | pause control input immediately; persist timestamp | `mobile.backgrounded` | `chat_only_background` |
| `background_grace` | `background.observe.timeout` | 60 s cumulative elapsed from persisted `backgroundedAt` before the control timer was observed | `chat_only_background` | close WebRTC/revoke L2+ | `webrtc.closed` and `permission.revoked` | — |
| `background_grace` | `background.control.timeout` | 10 s elapsed from persisted `backgroundedAt`; observe permission/media remains valid | `observe_background` | revoke control; keep observe only for the remaining 50 s | `permission.revoked` | `chat_only_background` if observe is not valid |
| `observe_background` | `background.observe.timeout` | 60 s cumulative elapsed from the original persisted `backgroundedAt` (not 60 s after entering this state) | `chat_only_background` | close WebRTC and revoke observe/L2+ | `webrtc.closed` and `permission.revoked` | — |
| `background_grace` | `mobile.foreground` | event is newer than `backgroundedAt`, elapsed time is under 10 s, and tuple/session/network plus exact retained permission/WebRTC generation all revalidate | `foreground` | run reconnect/snapshot and resume the still-valid retained observe/control level | `mobile.foregrounded` | `chat_only_background` |
| `observe_background` | `mobile.foreground` | event is newer than `backgroundedAt`, cumulative elapsed time is at least 10 s but under 60 s, and tuple/session/network plus retained observe permission/WebRTC generation all revalidate | `foreground` | run reconnect/snapshot and resume observe only; control requires a new grant | `mobile.foregrounded` | `chat_only_background` |
| `foreground` / `background_grace` / `observe_background` / `chat_only_background` | `mobile.locked` | mobile lock safety precedence | `chat_only_background` | close WebRTC and revoke L2+ | `webrtc.closed` | — |
| `foreground` / `background_grace` / `observe_background` / `chat_only_background` | `device.revoked` | MC-SM-REVOCATION durable commit wins | `terminal_ended` (terminal) | close WebRTC; revoke tokens/permissions/approvals/push/upload/artifact authority; cleanup and audit | `webrtc.closed` and `device.revoked` | reconciliation retries while authority remains denied |
| `foreground` / `background_grace` / `observe_background` / `chat_only_background` | `session.end` | authorized session end | `terminal_ended` (terminal) | close WebRTC and revoke L2+ | `webrtc.closed` | — |

Lifecycle state/timestamp is native-local durable enough to report after resume; remote authority uses desktop/server clocks. Process restart or missing lifecycle signal assumes background/chat-only. Exact repeated lifecycle events are ignored by timestamp/sequence.

## 11. Compatibility Rule

Unknown optional fields/events may be ignored only when explicitly additive. Unknown mandatory event, state, approval action, redaction rule, signature version or permission semantic returns `MC-ERR-PROTOCOL-CLIENT-UPGRADE-REQUIRED` and disables remote mutation while local Lily remains unchanged. State names are never translated heuristically.
