# Lily Mobile Command Pro Data Model

## 1. Authority And Scope

This document is the canonical logical and physical persistence contract for Mobile Command. It is grounded in PostgreSQL migrations `001_initial.sql`, `007_client_config_profiles.sql`, and `022_account_wallet.sql` and in `server/src/services/device-identity.js` and `server/src/routes/public/auth.js`.

The SQL in Appendix A is normative design input for a future numbered migration. It is not an executable migration in this specification phase and must not be applied by documentation tooling.

Identity vocabulary is exact:

- `user_id` is `users.id`.
- `device_id`, `desktop_device_id`, and `mobile_device_id` all reference the existing unified `devices.id`; the latter two names describe a role at a relation boundary, not a second ID namespace.
- `license_id` is `licenses.id`; `license_devices` supplies entitlement context and never proves user identity.
- `account_session_id` is `user_sessions.id`.
- `remote_session_id` is `mobile_remote_sessions.id`. A remote session is never inserted into, encoded as, or described as a `user_sessions` row.

All persisted instants use PostgreSQL `timestamptz`. Database expiry and cleanup comparisons use `transaction_timestamp()`/`now()`; signed-envelope skew is checked against server wall clock and stored nonce time. API serialization may use RFC 3339 or Unix milliseconds, but wire representation does not change the SQL type.

## 2. Existing Tables Reused Without Reinterpretation

### 2.1 `users`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | retain while account exists; opaque in logs |
| `phone_e164` | `text` | no | none | unique | account workflow only | restricted PII; mask outside auth/admin |
| `status` | `text` | no | `'active'` | none | account workflow | retain with account |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | retain with account |
| `last_login_at` | `timestamptz` | yes | none | none | login workflow | retain with account |

Existing exact constraint: primary key `(id)` and unique constraint `(phone_e164)`. Account deletion cascades through existing `user_sessions`/`user_devices` and the new user-owned relations below.

### 2.2 `devices`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | retain while referenced; opaque in logs |
| `fingerprint_hash` | `text` | yes | none | none | registration/recovery only | secret-derived identifier; never return to mobile or log raw |
| `platform` | `text` | yes | none | none | registration | retain while device exists |
| `arch` | `text` | yes | none | none | registration | retain while device exists |
| `app_version` | `text` | yes | none | none | registration | retain while device exists |
| `first_seen_at` | `timestamptz` | no | `now()` | none | immutable | retain while device exists |
| `last_seen_at` | `timestamptz` | no | `now()` | none | heartbeat | retain while device exists |

Existing exact constraint: primary key `(id)`. Desktop/mobile role is held in `mobile_device_roles`; no parallel base device table is permitted.

### 2.3 `user_devices`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `user_id` | `text` | no | none | `users(id) ON DELETE CASCADE` | immutable per row | delete with user |
| `device_id` | `text` | no | none | `devices(id) ON DELETE CASCADE` | immutable per row | delete with device |
| `first_seen_at` | `timestamptz` | no | `now()` | none | immutable | delete with row |
| `last_seen_at` | `timestamptz` | no | `now()` | none | heartbeat | delete with row |
| `status` | `text` | no | `'active'` | none | auth/admin workflow | retain revoked row while account/device exists |

Existing exact constraint: primary key `(user_id, device_id)`. A pairing grant requires an active row for both the desktop and mobile device under the same `user_id`; it must not create cross-account ownership.

### 2.4 `user_sessions`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | retain through account-session audit window |
| `user_id` | `text` | no | none | `users(id) ON DELETE CASCADE` | immutable | delete with user |
| `device_id` | `text` | no | none | `devices(id) ON DELETE CASCADE` | immutable | delete with device |
| `refresh_token_hash` | `text` | no | none | unique | rotate by replacing/versioning | hash only; never log or return |
| `refresh_token_version` | `integer` | no | `1` | none | increment on rotation | retain with session |
| `expires_at` | `timestamptz` | no | none | none | sliding extension | purge 30 days after expiry/revocation |
| `revoked_at` | `timestamptz` | yes | none | none | null to timestamp once | retain through audit window |
| `revoked_reason` | `text` | yes | none | none | set with revocation | redact free text; use bounded codes |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | retain with session |
| `last_seen_at` | `timestamptz` | no | `now()` | none | refresh workflow | retain with session |

Existing exact constraints/indexes: primary key `(id)`, unique `(refresh_token_hash)`, `user_sessions_user_idx (user_id, created_at DESC)`, and `user_sessions_device_idx (device_id, created_at DESC)`. Mobile remote authority references this row at grant creation but uses its own lifecycle. Sign-out revokes the account session and all grants issued from it; it does not turn a remote session into an account session.

The proposed appendix additively declares unique `(id,user_id,device_id)` over existing columns so a composite grant FK can enforce ownership. It changes no current row or current account-session semantics.

### 2.5 `licenses` and `license_devices`

| Table.Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `licenses.id` | `text` | no | none | primary key | immutable | retain per commercial record policy |
| `licenses.license_key_hash` | `text` | no | none | unique | immutable | hash only; never return or log |
| `licenses.customer_name` | `text` | yes | none | none | licensing workflow | restricted commercial PII |
| `licenses.plan` | `text` | no | `'pro'` | none | licensing workflow | retain per commercial policy |
| `licenses.seats` | `integer` | no | `1` | none | licensing workflow | retain per commercial policy |
| `licenses.expires_at` | `timestamptz` | no | none | none | renewal workflow | retain per commercial record policy |
| `licenses.status` | `text` | no | `'active'` | none | licensing workflow | retain per commercial record policy |
| `licenses.features` | `jsonb` | no | `'[]'` | none | licensing workflow | return only authorized feature identifiers |
| `licenses.created_at` | `timestamptz` | no | `now()` | none | immutable | retain per commercial policy |
| `licenses.updated_at` | `timestamptz` | no | `now()` | none | licensing workflow | retain per commercial policy |
| `license_devices.id` | `text` | no | none | primary key | immutable | retain binding history |
| `license_devices.license_id` | `text` | no | none | `licenses(id)` | immutable | retain binding history |
| `license_devices.device_id` | `text` | no | none | `devices(id)` | immutable | retain binding history |
| `license_devices.activated_at` | `timestamptz` | no | `now()` | none | immutable | retain binding history |
| `license_devices.last_seen_at` | `timestamptz` | no | `now()` | none | heartbeat | retain binding history |
| `license_devices.status` | `text` | no | `'active'` | none | licensing workflow | retain binding history |

Existing exact constraints: primary keys on both `id` columns, unique `licenses.license_key_hash`, and unique `(license_id, device_id)`. The current FK uses the repository default `NO ACTION`; the normative appendix does not alter it. Remote authorization snapshots `license_id`, but every connect/refresh/control grant revalidates current binding status, license status, and `expires_at > now()`.

### 2.6 `device_public_keys` and `request_nonces`

| Table.Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `device_public_keys.device_id` | `text` | no | none | `devices(id) ON DELETE CASCADE`; primary key | immutable | delete with device |
| `device_public_keys.public_key` | `text` | no | none | none | current implementation replaces in place | public material, but omit from routine logs |
| `device_public_keys.key_alg` | `text` | no | `'ed25519'` | none | with approved rotation | retain with key |
| `device_public_keys.created_at` | `timestamptz` | no | `now()` | none | immutable | retain with key |
| `device_public_keys.updated_at` | `timestamptz` | no | `now()` | none | rotation | retain with key |
| `request_nonces.device_id` | `text` | no | none | `devices(id) ON DELETE CASCADE` | immutable | delete after 10 minutes |
| `request_nonces.nonce` | `text` | no | none | composite primary key | immutable | sensitive request metadata; never log |
| `request_nonces.created_at` | `timestamptz` | no | `now()` | none | immutable | delete after 10 minutes |

Existing exact constraints: `device_public_keys` primary key `(device_id)`; `request_nonces` primary key `(device_id, nonce)`. Current verification accepts at most five minutes of clock skew and deletes nonce rows older than ten minutes before insert. Mobile Command preserves those windows. `mobile_device_key_history` supplies monotonic generation and rollback defense without destructively changing this compatibility table.

## 3. Additive Mobile Command Tables

### 3.1 `user_session_refresh_token_history`

This minimal tombstone table makes planned Mobile refresh-token replay detection queryable after `user_sessions.refresh_token_hash` has been replaced. It stores hashes only, never plaintext tokens.

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `bigserial` | no | sequence | primary key | immutable | purge at `expires_at`; never expose externally |
| `session_id` | `text` | no | none | `user_sessions(id) ON DELETE CASCADE` | immutable | purge with session or at `expires_at` |
| `token_hash` | `text` | no | none | unique | immutable | HMAC hash only; never log, return, or store plaintext |
| `token_version` | `integer` | no | none | check; unique with session | immutable | purge at `expires_at` |
| `invalidated_at` | `timestamptz` | no | `now()` | none | immutable | rotation/revocation clock anchor; retain until `expires_at` |
| `expires_at` | `timestamptz` | no | none | check | immutable | cleanup anchor; original token/session validity limit |
| `reason` | `text` | no | `'rotated'` | check | immutable | fixed bounded code; purge with tombstone |

Exact constraints/indexes: primary key `(id)`, unique `(token_hash)`, unique `(session_id, token_version)`, check `token_version > 0`, check `expires_at > invalidated_at`, check `reason = 'rotated'`, lookup index `(token_hash, expires_at)`, and cleanup index `(expires_at)`. Replay outcome is recorded in the remote audit owner rather than mutating the tombstone. Hash lookup uses the same HMAC/pepper as current `hashRefreshToken`; a raw token or reversible encryption is prohibited.

On a planned Mobile refresh, the server locks the `user_sessions` row and in one database transaction: (1) verifies the current old hash/version; (2) inserts that old hash/version into this table with `invalidated_at=now()` and `expires_at` equal to the pre-rotation session expiry; (3) compare-and-sets the current row to the new hash/version and sliding 30-day expiry; and (4) commits before returning either new token. A request whose hash does not match a current session queries this table for `token_hash` with `expires_at > now()`; a match locates `session_id` and triggers account-session and paired-grant revocation. Concurrent duplicate rotation loses on the unique tombstone/CAS and follows the replay path.

### 3.2 `mobile_device_roles`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `device_id` | `text` | no | none | `devices(id) ON DELETE CASCADE`; primary key | immutable | delete with device |
| `device_role` | `text` | no | none | check | immutable; replacement creates device | retain with device |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | retain with device |

Check: `device_role IN ('desktop','mobile')`. A device has one role for this feature.

### 3.3 `mobile_device_key_history`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | active: retain; rotated/revoked: purge 365 days after `terminal_at` |
| `device_id` | `text` | no | none | `devices(id) ON DELETE CASCADE` | immutable | active: retain; rotated/revoked: purge 365 days after `terminal_at`, or delete with device |
| `generation` | `integer` | no | none | unique with device; check | immutable, strictly increasing | active: retain; rotated/revoked: purge 365 days after `terminal_at` |
| `public_key` | `text` | no | none | none | immutable | omit from routine logs; rotated/revoked: purge 365 days after `terminal_at` |
| `key_alg` | `text` | no | `'ed25519'` | check | immutable | active: retain; rotated/revoked: purge 365 days after `terminal_at` |
| `status` | `text` | no | `'active'` | check | active to rotated/revoked only | state anchor; rotated/revoked row purges 365 days after `terminal_at` |
| `activated_at` | `timestamptz` | no | `now()` | none | immutable | active: retain; rotated/revoked: purge 365 days after `terminal_at` |
| `terminal_at` | `timestamptz` | yes | none | none | null to timestamp once when rotated/revoked | cleanup anchor: purge 365 days after terminal state |

Unique `(device_id, generation)` and partial unique index on `(device_id) WHERE status='active'`; cleanup index `(terminal_at) WHERE status IN ('rotated','revoked')`. Checks: `generation > 0`, `key_alg='ed25519'`, valid status, and `terminal_at` is null exactly for active rows and non-null for both rotated and revoked rows. Rotation sets the old row to `rotated` and `terminal_at=now()`; revocation sets the active row to `revoked` and `terminal_at=now()`. The compatibility `device_public_keys` row must equal the active history key in the same rotation transaction and is deleted/disabled when the key is revoked.

### 3.4 `mobile_pairing_challenges`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | purge 24 hours after terminal/expiry |
| `user_id` | `text` | no | none | `users(id) ON DELETE CASCADE` | immutable | opaque in logs |
| `account_session_id` | `text` | no | none | `user_sessions(id) ON DELETE CASCADE` | immutable | purge with challenge |
| `desktop_device_id` | `text` | no | none | `devices(id) ON DELETE CASCADE` | immutable | opaque in logs |
| `token_hash` | `text` | no | none | unique | immutable | hash only; never log or return after creation |
| `status` | `text` | no | `'pending'` | check | one-way terminal transition | purge after terminal window |
| `expires_at` | `timestamptz` | no | none | check | immutable | purge after terminal window |
| `consumed_at` | `timestamptz` | yes | none | none | null to terminal timestamp once for consumed/cancelled | purge after terminal window |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | purge after terminal window |

Unique `token_hash`; lookup index `(desktop_device_id, status, expires_at)`; status check `pending/consumed/expired/cancelled`; `expires_at > created_at`; `consumed_at` is present exactly for `consumed` or `cancelled` as their terminal handling time. Challenge TTL is five minutes.

### 3.5 `mobile_pairing_grants`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | by `status`/`terminal_at`: expired 24 h, denied 30 d, revoked 365 d; active retained |
| `user_id` | `text` | no | none | with account/mobile IDs → `user_sessions(id,user_id,device_id) ON DELETE CASCADE` | immutable | same state retention; opaque in logs; delete through account session |
| `account_session_id` | `text` | no | none | with `user_id,mobile_device_id` → `user_sessions(id,user_id,device_id) ON DELETE CASCADE` | immutable | same state retention; revoke on session revocation; delete with session |
| `desktop_device_id` | `text` | no | none | with `license_id` → `license_devices(license_id,device_id)` | immutable | same state retention; opaque in logs; exact binding required |
| `mobile_device_id` | `text` | no | none | with account/user IDs → `user_sessions(id,user_id,device_id)` | immutable | same state retention; opaque in logs; exact session device required |
| `license_id` | `text` | no | none | with `desktop_device_id` → `license_devices(license_id,device_id)` | immutable snapshot | same state retention; commercial identifier redacted |
| `status` | `text` | no | `'pending_approval'` | check | state machine only | controls State Retention Closure matrix: expired 24 h, denied 30 d, revoked 365 d, active retained |
| `approval_expires_at` | `timestamptz` | no | none | none | immutable | pending timeout anchor; after transition, state retention uses `terminal_at` |
| `approved_at` | `timestamptz` | yes | none | none | null to timestamp once | same state retention; active retained until revoked |
| `terminal_at` | `timestamptz` | yes | none | none | null to timestamp once for denied/revoked/expired | cleanup anchor: expired 24 h, denied 30 d, revoked 365 d |
| `revoked_reason` | `text` | yes | none | none | set with revoke | bounded code; same state retention, no free-form secrets |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | same state retention; pending bounded by `approval_expires_at` |

Partial unique `(desktop_device_id, mobile_device_id) WHERE status IN ('pending_approval','active')`; lookup indexes `(user_id,status)`, `(mobile_device_id,status)`, `(approval_expires_at) WHERE status='pending_approval'`, and `(terminal_at) WHERE status IN ('denied','revoked','expired')`. Checks forbid self-pairing, constrain status, require `approval_expires_at > created_at`, and require timestamps consistent with each state. Approval is a compare-and-set from unexpired `pending_approval`; concurrent decisions cannot both win.

Grant retention is closed by state:

| State | Transition/anchor | Retention and cleanup |
|---|---|---|
| `pending_approval` | created with `approval_expires_at = created_at + 2 minutes` | cleanup job atomically changes overdue rows to `expired`, sets `terminal_at=now()`, and thereby releases the partial unique live-pair slot; abandoned pending rows cannot persist indefinitely |
| `active` | `approved_at` set by desktop compare-and-set; `terminal_at` null | retained while authority is active; it must transition to `revoked` before deletion |
| `denied` | desktop denial sets `terminal_at=now()` | purge 30 days after `terminal_at` |
| `expired` | approval timeout job sets `terminal_at=now()` | purge 24 hours after `terminal_at` |
| `revoked` | account/device/license/risk/user action sets `terminal_at=now()` and bounded `revoked_reason` | purge 365 days after `terminal_at` |

The timeout transition runs at least every minute, before creation of a new grant for the same pair, using `FOR UPDATE SKIP LOCKED` in bounded batches. An approval update must include `status='pending_approval' AND approval_expires_at > now()`; otherwise it loses to expiry/deny and creates no active grant.

### 3.6 `mobile_remote_sessions`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | purge 90 days after end/expiry |
| `pairing_grant_id` | `text` | no | none | part of composite FK to exact grant tuple, `ON DELETE CASCADE` | immutable | purge with grant |
| `user_id` | `text` | no | none | part of composite FK to exact grant tuple | immutable | opaque in logs |
| `account_session_id` | `text` | no | none | part of composite FK to exact grant tuple | immutable | session is auth provenance only |
| `desktop_device_id` | `text` | no | none | part of composite FK to exact grant tuple | immutable | opaque in logs |
| `mobile_device_id` | `text` | no | none | part of composite FK to exact grant tuple; unique with session `id` | immutable | opaque in logs |
| `license_id` | `text` | no | none | part of composite FK to exact grant tuple | immutable snapshot | redact in logs |
| `status` | `text` | no | `'active'` | check | active to ended/revoked/expired | retain terminal state |
| `permission_level` | `smallint` | no | `1` | check | policy-controlled; never above 5 standing | retain with session |
| `access_token_generation` | `integer` | no | `1` | check | atomic increment revokes all access tokens of prior generation | retain with session; never exposed except as signed token claim |
| `expires_at` | `timestamptz` | no | none | none | bounded extension on refresh | purge after terminal window |
| `last_seen_at` | `timestamptz` | no | `now()` | none | heartbeat | retain with session |
| `ended_at` | `timestamptz` | yes | none | none | null to timestamp once | retain with session |
| `end_reason` | `text` | yes | none | none | set with terminal transition | bounded code |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | retain with session |

The grant has unique key `(id,user_id,account_session_id,desktop_device_id,mobile_device_id,license_id)`. This table has a composite FK over `(pairing_grant_id,user_id,account_session_id,desktop_device_id,mobile_device_id,license_id)` to that exact grant key, so none of the redundant subject fields can drift. It also has unique `(id,mobile_device_id)` for approval references. Partial unique `(pairing_grant_id) WHERE status='active'`; lookup indexes `(desktop_device_id,status,last_seen_at DESC)`, `(mobile_device_id,status,last_seen_at DESC)`, and `(expires_at) WHERE status='active'`. Checks constrain status/permission, `access_token_generation > 0`, and terminal timestamps. Remote session TTL is 30 minutes with activity refresh, capped at 12 hours from `created_at`; reconnect never changes its identities.

Remote-session creation is one transaction. It locks the active pairing grant, account session, both `user_devices`, both role rows, selected license, and exact desktop `license_devices` row with `SELECT ... FOR UPDATE`; asserts active/unrevoked/unexpired states and correct roles; updates every existing row for that grant with `status='active' AND expires_at<=now()` to `status='expired', ended_at=now(), end_reason='expired_before_recreate'`; then inserts the new session. The immediate update precedes the insert and releases the partial unique slot without waiting for the 15-minute cleanup fallback. Any missing/mismatched/changed row rolls back the whole transaction.

### 3.7 `mobile_remote_tokens`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | purge 30 days after expiry/revocation |
| `remote_session_id` | `text` | no | none | `mobile_remote_sessions(id) ON DELETE CASCADE` | immutable | purge with session |
| `token_hash` | `text` | no | none | unique | immutable | hash only; never log/return after issuance |
| `generation` | `integer` | no | `1` | unique with session; check | immutable | retain for replay evidence |
| `expires_at` | `timestamptz` | no | none | none | immutable | purge after window |
| `used_at` | `timestamptz` | yes | none | none | null to timestamp once | retain with token |
| `revoked_at` | `timestamptz` | yes | none | none | null to timestamp once | retain with token |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | retain with token |

Unique `token_hash` and `(remote_session_id,generation)`; index `(remote_session_id,expires_at)`. Refresh tokens are opaque, one-time, 30-minute credentials; atomic consume issues the next generation and marks `used_at`. Reuse revokes the remote session and every token in its family.

### 3.8 `mobile_remote_approvals`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `text` | no | none | primary key | immutable | purge/redact resource summary after 365 days |
| `remote_session_id` | `text` | no | none | composite FK with mobile device to `mobile_remote_sessions` | immutable | purge with session |
| `mobile_device_id` | `text` | no | none | `(remote_session_id,mobile_device_id)` references session pair | immutable | opaque in logs |
| `action_type` | `text` | no | none | bounded application enum | immutable | retain category only |
| `resource_summary` | `jsonb` | no | `'{}'` | none | immutable | allowlisted/redacted; no content, path secrets, typed text |
| `status` | `text` | no | `'pending'` | check | compare-and-set once | retain decision evidence |
| `max_uses` | `integer` | no | `1` | check | immutable | retain |
| `use_count` | `integer` | no | `0` | check | atomic increment | retain |
| `expires_at` | `timestamptz` | no | none | none | immutable | retain through audit window |
| `decided_at` | `timestamptz` | yes | none | none | null to timestamp once | retain |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | retain |

Composite FK `(remote_session_id,mobile_device_id)` references `mobile_remote_sessions(id,mobile_device_id)`, proving the approval's requesting device belongs to that session. Index `(remote_session_id,status,expires_at)`. Checks constrain `max_uses > 0`, bounds, and state consistency: pending has no decision and zero use; approved has a decision and is below its use cap; denied has a decision and zero use; expired has a decision and is below its cap; consumed has a decision and exactly `max_uses`; revoked has a decision. Approval consumption is atomic and bound to the stored session/device/action/resource digest.

Every transition to `approved`, `denied`, `expired`, `consumed`, or `revoked` sets `decided_at` if it is still null in the same compare-and-set transaction. Expiry processing therefore changes overdue pending/approved rows to `expired` with `decided_at=now()` before cleanup; consumption atomically increments `use_count` and changes to `consumed` exactly at `max_uses`.

### 3.9 `mobile_remote_audit_events`

| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---:|---|---|---|---|
| `id` | `bigserial` | no | sequence | primary key | immutable/append-only | retain 365 days, then delete by partition/job |
| `event_id` | `text` | no | none | unique | immutable | opaque in logs |
| `user_id` | `text` | yes | none | `users(id) ON DELETE SET NULL` | immutable | pseudonymize on account deletion |
| `remote_session_id` | `text` | yes | none | no FK by design | immutable | preserve terminal evidence after cleanup |
| `desktop_device_id` | `text` | yes | none | no FK by design | immutable | keyed-hash after 90 days |
| `mobile_device_id` | `text` | yes | none | no FK by design | immutable | keyed-hash after 90 days |
| `event_type` | `text` | no | none | bounded application enum | immutable | retain |
| `outcome` | `text` | no | none | check | immutable | retain |
| `metadata` | `jsonb` | no | `'{}'` | none | immutable | allowlist only; no tokens/signatures/content/clipboard/typed text |
| `created_at` | `timestamptz` | no | `now()` | none | immutable | retain 365 days |

Unique `event_id`; indexes `(remote_session_id,created_at DESC)` and `(event_type,created_at DESC)`; check `outcome IN ('allowed','denied','revoked','failed')`. It is intentionally append-only and does not cascade away with operational rows.

## 4. State Retention Closure

Every stateful additive table has an explicit terminal transition and cleanup anchor:

| Table | Non-terminal states | Terminal states and anchor | Cleanup |
|---|---|---|---|
| `user_session_refresh_token_history` | none; each row is an invalidated-token tombstone | `invalidated_at`; queryable until original validity `expires_at` | purge at `expires_at`; cascade with account session |
| `mobile_device_roles` | role row while device exists | device deletion | `ON DELETE CASCADE`; no independent timer |
| `mobile_device_key_history` | `active` | `rotated`/`revoked` at `terminal_at` | 365 days after `terminal_at` |
| `mobile_pairing_challenges` | `pending` until `expires_at` | `consumed` at `consumed_at`; `expired` at `expires_at`; `cancelled` uses cancellation time recorded in `consumed_at` as the existing terminal-time column | 24 hours after `coalesce(consumed_at, expires_at)`; pending rows are first transitioned to `expired` |
| `mobile_pairing_grants` | `pending_approval`, `active` | `denied`/`expired`/`revoked` at `terminal_at` | respectively 30 days/24 hours/365 days after `terminal_at` |
| `mobile_remote_sessions` | `active` until `expires_at` | `ended`/`revoked`/`expired` at `ended_at` | 90 days after `ended_at`; overdue active rows first transition to `expired` |
| `mobile_remote_tokens` | unused and unrevoked before `expires_at` | used at `used_at`, revoked at `revoked_at`, otherwise expired at `expires_at` | 30 days after `coalesce(revoked_at, used_at, expires_at)` |
| `mobile_remote_approvals` | `pending`/`approved` before `expires_at` and use limit | `denied`/`revoked` at `decided_at`; `expired` at `expires_at`; `consumed` when `use_count=max_uses` | 365 days after `coalesce(decided_at, expires_at)` or earlier with owning session cascade; expired/consumed transitions are audited before purge |
| `mobile_remote_audit_events` | append-only; no mutable state | `created_at` is retention anchor | purge 365 days after `created_at` after required pseudonymization |

For challenge cancellation, `consumed_at` means the terminal handling time for both `consumed` and `cancelled`; it is not evidence that a cancelled token was consumed. The DDL check below enforces a terminal timestamp for both. All expiry transitions use database `now()` and bounded `FOR UPDATE SKIP LOCKED` batches.

## 5. Ownership, Revocation, Deletion, And Cleanup

| Trigger | Transactional effect | Asynchronous effect | Local baseline |
|---|---|---|---|
| account session logout/revoke/expiry | revoke grants whose `account_session_id` matches; end their active remote sessions; revoke token families and pending approvals | remove push association and transport routes | local conversations and license remain unchanged |
| mobile device revoke | set `user_devices.status='revoked'`; revoke all its grants, sessions, tokens, approvals, and active key | notify desktop and remove push association | desktop local use remains unchanged |
| desktop device replacement/revoke | revoke grants and sessions for old `desktop_device_id`; replacement is a new `devices.id` and requires pairing | clean old ephemeral signaling state | no grant transfers by fingerprint/license |
| license/binding disabled or expired | deny new remote authority and end affected active remote sessions | notify both peers | local license manager keeps its existing fallback rules; remote authority never borrows another device's binding |
| user deletion | existing/new user-owned FKs cascade operational rows; audit `user_id` becomes null | redact/pseudonymize audit identifiers | destructive account operation is explicit |
| device deletion | device-owned operational/key rows cascade; audit IDs remain pseudonymized evidence | clean transport/push state | no cross-device reassignment |

General cleanup runs at least every 15 minutes under a single advisory lock and deletes in bounded batches: refresh-token tombstones at `expires_at`; nonces older than ten minutes; challenges 24 hours after terminal/expiry; denied grants 30 days, expired grants 24 hours, and revoked grants 365 days after `terminal_at`; rotated or revoked key-history rows 365 days after `terminal_at`; remote tokens 30 days after expiry/revoke; remote sessions 90 days after terminal/expiry; and audit after 365 days. The separate grant-timeout transition runs at least every minute so stale `pending_approval` rows release their live-pair uniqueness promptly. Active grants and active keys have no cleanup deadline and must first enter an explicit terminal state. Cleanup failure must alert and deny authority if replay or audit storage cannot be safely maintained; it must not block local Lily chat.

## 6. Migration Compatibility

The future migration is additive and lexically ordered after the current latest migration. It does not rename, delete, reinterpret, or backfill `devices`, `users`, `user_devices`, `user_sessions`, `licenses`, `license_devices`, `device_public_keys`, or `request_nonces`. Existing desktop IDs, account sessions, keys, and licenses remain valid. No historical row is assigned a desktop/mobile role automatically; role is created only by a verified feature enrollment. Rollback disables Mobile Command routes first and may leave additive tables dormant; it must not drop them while a deployed client could still reference them.

The appendix adds `user_sessions(id,user_id,device_id)` as an explicit composite unique key without changing existing values, enabling the grant FK to prove account-session ownership. `license_devices` already has unique `(license_id,device_id)`. PostgreSQL FKs enforce tuple equality and deletion propagation; mutable predicates (`status='active'`, expiry, correct role, valid license status) cannot be represented by ordinary FKs and are therefore mandatory locked assertions in the same transaction that creates/refreshes authority. No authority row is committed if any assertion fails.

## Appendix A — Normative PostgreSQL DDL (Not Applied)

```sql
-- NORMATIVE APPENDIX ONLY. A future migration must receive the next repository number.
alter table user_sessions
  add constraint user_sessions_identity_tuple_unique unique (id, user_id, device_id);

create table if not exists user_session_refresh_token_history (
  id bigserial primary key,
  session_id text not null references user_sessions(id) on delete cascade,
  token_hash text not null unique,
  token_version integer not null check (token_version > 0),
  invalidated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reason text not null default 'rotated' check (reason = 'rotated'),
  unique (session_id, token_version),
  check (expires_at > invalidated_at)
);
create index if not exists user_session_refresh_token_history_lookup_idx
  on user_session_refresh_token_history (token_hash, expires_at);
create index if not exists user_session_refresh_token_history_cleanup_idx
  on user_session_refresh_token_history (expires_at);

create table if not exists mobile_device_roles (
  device_id text primary key references devices(id) on delete cascade,
  device_role text not null check (device_role in ('desktop', 'mobile')),
  created_at timestamptz not null default now()
);

create table if not exists mobile_device_key_history (
  id text primary key,
  device_id text not null references devices(id) on delete cascade,
  generation integer not null check (generation > 0),
  public_key text not null,
  key_alg text not null default 'ed25519' check (key_alg = 'ed25519'),
  status text not null default 'active' check (status in ('active', 'rotated', 'revoked')),
  activated_at timestamptz not null default now(),
  terminal_at timestamptz,
  unique (device_id, generation),
  check ((status = 'active' and terminal_at is null) or (status in ('rotated', 'revoked') and terminal_at is not null))
);
create unique index if not exists mobile_device_key_history_active_unique
  on mobile_device_key_history (device_id) where status = 'active';
create index if not exists mobile_device_key_history_cleanup_idx
  on mobile_device_key_history (terminal_at) where status in ('rotated', 'revoked');

create table if not exists mobile_pairing_challenges (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  account_session_id text not null references user_sessions(id) on delete cascade,
  desktop_device_id text not null references devices(id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'consumed', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((status in ('consumed', 'cancelled') and consumed_at is not null)
      or (status in ('pending', 'expired') and consumed_at is null))
);
create index if not exists mobile_pairing_challenges_lookup_idx
  on mobile_pairing_challenges (desktop_device_id, status, expires_at);

create table if not exists mobile_pairing_grants (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  account_session_id text not null,
  desktop_device_id text not null references devices(id) on delete cascade,
  mobile_device_id text not null references devices(id) on delete cascade,
  license_id text not null,
  status text not null default 'pending_approval' check (status in ('pending_approval', 'active', 'denied', 'revoked', 'expired')),
  approval_expires_at timestamptz not null,
  approved_at timestamptz,
  terminal_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  check (desktop_device_id <> mobile_device_id),
  check (approval_expires_at > created_at),
  check ((status = 'pending_approval' and approved_at is null and terminal_at is null)
      or (status = 'active' and approved_at is not null and terminal_at is null)
      or (status in ('denied', 'revoked', 'expired') and terminal_at is not null)),
  unique (id, user_id, account_session_id, desktop_device_id, mobile_device_id, license_id),
  foreign key (account_session_id, user_id, mobile_device_id)
    references user_sessions(id, user_id, device_id) on delete cascade,
  foreign key (license_id, desktop_device_id)
    references license_devices(license_id, device_id)
);
create unique index if not exists mobile_pairing_grants_live_pair_unique
  on mobile_pairing_grants (desktop_device_id, mobile_device_id)
  where status in ('pending_approval', 'active');
create index if not exists mobile_pairing_grants_user_status_idx on mobile_pairing_grants (user_id, status);
create index if not exists mobile_pairing_grants_mobile_status_idx on mobile_pairing_grants (mobile_device_id, status);
create index if not exists mobile_pairing_grants_pending_expiry_idx
  on mobile_pairing_grants (approval_expires_at) where status = 'pending_approval';
create index if not exists mobile_pairing_grants_cleanup_idx
  on mobile_pairing_grants (terminal_at) where status in ('denied', 'revoked', 'expired');

create table if not exists mobile_remote_sessions (
  id text primary key,
  pairing_grant_id text not null,
  user_id text not null,
  account_session_id text not null,
  desktop_device_id text not null,
  mobile_device_id text not null,
  license_id text not null,
  status text not null default 'active' check (status in ('active', 'ended', 'revoked', 'expired')),
  permission_level smallint not null default 1 check (permission_level between 1 and 5),
  access_token_generation integer not null default 1 check (access_token_generation > 0),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((status = 'active' and ended_at is null) or (status <> 'active' and ended_at is not null)),
  unique (id, mobile_device_id),
  foreign key (pairing_grant_id, user_id, account_session_id, desktop_device_id, mobile_device_id, license_id)
    references mobile_pairing_grants(id, user_id, account_session_id, desktop_device_id, mobile_device_id, license_id)
    on delete cascade
);
create unique index if not exists mobile_remote_sessions_active_grant_unique
  on mobile_remote_sessions (pairing_grant_id) where status = 'active';
create index if not exists mobile_remote_sessions_desktop_lookup_idx
  on mobile_remote_sessions (desktop_device_id, status, last_seen_at desc);
create index if not exists mobile_remote_sessions_mobile_lookup_idx
  on mobile_remote_sessions (mobile_device_id, status, last_seen_at desc);
create index if not exists mobile_remote_sessions_expiry_idx
  on mobile_remote_sessions (expires_at) where status = 'active';

create table if not exists mobile_remote_tokens (
  id text primary key,
  remote_session_id text not null references mobile_remote_sessions(id) on delete cascade,
  token_hash text not null unique,
  generation integer not null default 1 check (generation > 0),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (remote_session_id, generation),
  check (expires_at > created_at)
);
create index if not exists mobile_remote_tokens_session_expiry_idx
  on mobile_remote_tokens (remote_session_id, expires_at);

create table if not exists mobile_remote_approvals (
  id text primary key,
  remote_session_id text not null,
  mobile_device_id text not null,
  action_type text not null,
  resource_summary jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired', 'consumed', 'revoked')),
  max_uses integer not null default 1 check (max_uses > 0),
  use_count integer not null default 0 check (use_count >= 0 and use_count <= max_uses),
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((status = 'pending' and decided_at is null and use_count = 0)
      or (status = 'approved' and decided_at is not null and use_count < max_uses)
      or (status = 'denied' and decided_at is not null and use_count = 0)
      or (status = 'expired' and decided_at is not null and use_count < max_uses)
      or (status = 'consumed' and decided_at is not null and use_count = max_uses)
      or (status = 'revoked' and decided_at is not null)),
  foreign key (remote_session_id, mobile_device_id)
    references mobile_remote_sessions(id, mobile_device_id) on delete cascade
);
create index if not exists mobile_remote_approvals_lookup_idx
  on mobile_remote_approvals (remote_session_id, status, expires_at);

create table if not exists mobile_remote_audit_events (
  id bigserial primary key,
  event_id text not null unique,
  user_id text references users(id) on delete set null,
  remote_session_id text,
  desktop_device_id text,
  mobile_device_id text,
  event_type text not null,
  outcome text not null check (outcome in ('allowed', 'denied', 'revoked', 'failed')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists mobile_remote_audit_session_idx
  on mobile_remote_audit_events (remote_session_id, created_at desc);
create index if not exists mobile_remote_audit_type_idx
  on mobile_remote_audit_events (event_type, created_at desc);
```
