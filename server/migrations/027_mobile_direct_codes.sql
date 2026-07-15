-- Mobile Command — direct-connect codes (TeamViewer/ToDesk-style).
--
-- An alternative to the QR + desktop-approval flow: the desktop generates a
-- SHORT code + a password (both shown on the desktop screen). The phone types
-- both and connects directly — no approval tap. A short code is low-entropy, so
-- the safety comes from: only the HASHES are stored, per-code attempt lockout,
-- a short TTL, and one active code per desktop. This is opt-in; QR + approval
-- stays the default.
--
-- Additive: one new table. Nothing existing is touched.

create table if not exists mobile_direct_codes (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  account_session_id text references user_sessions(id) on delete cascade,
  desktop_device_id text not null references devices(id) on delete cascade,
  code_hash text not null,
  password_hash text not null,
  status text not null default 'active',
  attempt_count integer not null default 0,
  locked_until timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  constraint mobile_direct_codes_status_ck
    check (status in ('active', 'consumed', 'expired', 'revoked'))
);

-- Fast lookup by code hash for the (only) active code, and desktop-scoped mgmt.
create unique index if not exists mobile_direct_codes_active_code_uk
  on mobile_direct_codes (code_hash) where status = 'active';
create index if not exists mobile_direct_codes_desktop_idx
  on mobile_direct_codes (desktop_device_id, status);
