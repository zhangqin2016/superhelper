-- Enterprise seat invitations — assign a seat to staff who have no account yet.
--
-- The gap this closes: POST /api/enterprise/organizations/:id/members accepts
-- `{userId | phoneE164}` and fails with USER_NOT_FOUND (404) when the phone is
-- not registered, because organization_members references users(id). So an
-- enterprise that bought 50 seats had to wait for every employee to sign up
-- first and add them one at a time. There is no way to pre-provision.
--
-- Additive and self-contained: one new table. organization_members is
-- untouched, so every existing membership path behaves exactly as before, and
-- an install that never creates an invitation is byte-identical in behaviour.
--
-- A pending invitation is redeemed at the invitee's next successful login
-- (routes/public/auth.js), AFTER the login transaction commits — login must
-- never depend on redemption succeeding.

create table if not exists organization_invitations (
  id text primary key,
  organization_id text not null references organizations(id) on delete cascade,
  phone_e164 text not null,
  role text not null default 'member',            -- admin | member (never owner)
  status text not null default 'pending',         -- pending | accepted | revoked
  -- Nullable and ON DELETE SET NULL: an invitation must outlive the person who
  -- sent it. Cascading here would silently drop seats when an admin leaves.
  invited_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_user_id text references users(id) on delete set null,
  constraint organization_invitations_role_ck check (role in ('admin', 'member')),
  constraint organization_invitations_status_ck check (status in ('pending', 'accepted', 'revoked'))
);

-- At most one OPEN invitation per (organization, phone). Accepted and revoked
-- rows stay for audit, so the uniqueness is partial rather than a plain key.
create unique index if not exists organization_invitations_pending_uq
  on organization_invitations (organization_id, phone_e164)
  where status = 'pending';

-- Redemption looks up by phone on every login, so this index is the hot path.
create index if not exists organization_invitations_phone_idx
  on organization_invitations (phone_e164)
  where status = 'pending';

-- The org console lists its own pending invitations.
create index if not exists organization_invitations_org_idx
  on organization_invitations (organization_id, status, created_at desc);
