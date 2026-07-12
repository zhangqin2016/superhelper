-- Mobile Command Phase 1 — pairing data foundation.
--
-- Implements the pairing tables from the frozen data model (MC-SPEC-006 §3.4,
-- §3.5): a desktop shows a short-lived QR challenge, the mobile device claims
-- it, and an approved grant binds the two devices under one account. Only the
-- text-message channel needs these two tables; remote-session/approval/audit
-- tables (§3.6–3.9) land in later phase migrations.
--
-- Additive and reversible: two new tables + one redundant composite unique on
-- user_sessions (its `id` is already the primary key; the extra key exists only
-- so the grant's anti-drift composite FK can reference (id,user_id,device_id)).
-- Nothing existing is rewritten.

-- Composite-FK anchor for grants. `id` alone is already unique (primary key),
-- so this constrains nothing new about user_sessions — it just lets the grant
-- reference the exact (session, account, device) tuple and never drift.
create unique index if not exists user_sessions_id_user_device_uk
  on user_sessions (id, user_id, device_id);

-- §3.4 Pairing challenges: the desktop-issued QR token a mobile device claims.
-- Only the token HASH is stored — the raw token lives in the QR code and is
-- never persisted or returned after creation. TTL is 5 minutes (application
-- sets expires_at); rows purge 24h after they terminate.
create table if not exists mobile_pairing_challenges (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  account_session_id text not null references user_sessions(id) on delete cascade,
  desktop_device_id text not null references devices(id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'pending',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mobile_pairing_challenges_status_ck
    check (status in ('pending', 'consumed', 'expired', 'cancelled')),
  constraint mobile_pairing_challenges_expiry_ck
    check (expires_at > created_at),
  -- consumed_at is set exactly for the terminal states that record a handling
  -- time (consumed / cancelled); pending and expired leave it null.
  constraint mobile_pairing_challenges_consumed_ck
    check ((status in ('consumed', 'cancelled')) = (consumed_at is not null))
);

create index if not exists mobile_pairing_challenges_lookup_idx
  on mobile_pairing_challenges (desktop_device_id, status, expires_at);

-- §3.5 Pairing grants: an approved (or pending) desktop↔mobile binding under
-- one account + license. Approval is a compare-and-set from an unexpired
-- pending_approval row, so two concurrent decisions can never both win.
create table if not exists mobile_pairing_grants (
  id text primary key,
  user_id text not null,
  account_session_id text not null,
  desktop_device_id text not null,
  mobile_device_id text not null,
  license_id text not null,
  status text not null default 'pending_approval',
  approval_expires_at timestamptz not null,
  approved_at timestamptz,
  terminal_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  -- Anti-drift composite FKs: the grant's subject tuple must match an exact
  -- account session and an exact licensed desktop device — no field can drift
  -- to another account/session/device.
  constraint mobile_pairing_grants_session_fk
    foreign key (account_session_id, user_id, mobile_device_id)
    references user_sessions (id, user_id, device_id) on delete cascade,
  constraint mobile_pairing_grants_license_device_fk
    foreign key (license_id, desktop_device_id)
    references license_devices (license_id, device_id),
  constraint mobile_pairing_grants_no_self_pair_ck
    check (desktop_device_id <> mobile_device_id),
  constraint mobile_pairing_grants_status_ck
    check (status in ('pending_approval', 'active', 'denied', 'expired', 'revoked')),
  constraint mobile_pairing_grants_approval_expiry_ck
    check (approval_expires_at > created_at),
  -- active implies an approval time; the terminal states set terminal_at.
  constraint mobile_pairing_grants_approved_ck
    check (status <> 'active' or approved_at is not null),
  constraint mobile_pairing_grants_terminal_ck
    check ((status in ('denied', 'expired', 'revoked')) = (terminal_at is not null)),
  -- revoked_reason is a bounded code, only meaningful on revocation.
  constraint mobile_pairing_grants_reason_ck
    check (revoked_reason is null or status = 'revoked')
);

-- At most one live pairing per desktop↔mobile pair; the cleanup job flips
-- overdue pending rows to expired to release this slot.
create unique index if not exists mobile_pairing_grants_live_pair_uk
  on mobile_pairing_grants (desktop_device_id, mobile_device_id)
  where status in ('pending_approval', 'active');

create index if not exists mobile_pairing_grants_user_status_idx
  on mobile_pairing_grants (user_id, status);
create index if not exists mobile_pairing_grants_mobile_status_idx
  on mobile_pairing_grants (mobile_device_id, status);
create index if not exists mobile_pairing_grants_pending_timeout_idx
  on mobile_pairing_grants (approval_expires_at)
  where status = 'pending_approval';
create index if not exists mobile_pairing_grants_terminal_cleanup_idx
  on mobile_pairing_grants (terminal_at)
  where status in ('denied', 'expired', 'revoked');
