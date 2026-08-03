-- Enterprise Organizations — organizations, membership, and org-level quotas.
--
-- Additive: two new tables, plus two new nullable columns on existing wallet
-- tables. Nothing existing is touched; personal grants keep
-- `organization_id IS NULL` and behave exactly as before.
--
-- Key decisions (see docs/enterprise-organizations-design.md §5):
-- - `wallet_grants.organization_id` marks an org pool grant. The row's
--   `user_id` holds the org owner's id (not-null constraint on the column),
--   and consumption is filtered by membership + org/member status at runtime.
-- - `organization_members.quota` is the PER-MEMBER cap (units), null = no cap.
-- - `usage_events.organization_id` lets org admins + platform admins aggregate
--   usage by member / by model per organization.

create table if not exists organizations (
  id text primary key,
  name text not null,
  status text not null default 'active',          -- active | disabled
  plan text not null default 'standard',          -- reserved seat plan slot
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_status_ck check (status in ('active', 'disabled'))
);

-- Membership (many-to-many; a user can belong to multiple organizations).
create table if not exists organization_members (
  organization_id text not null references organizations(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'member',            -- owner | admin | member
  status text not null default 'active',          -- active | disabled
  quota integer,                                  -- per-member cap (units); null = unlimited
  joined_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  constraint organization_members_role_ck check (role in ('owner', 'admin', 'member')),
  constraint organization_members_status_ck check (status in ('active', 'disabled'))
);

-- Fast lookup: organizations a user belongs to, and members of an org.
create index if not exists organization_members_user_idx on organization_members (user_id);
create index if not exists organization_members_org_idx on organization_members (organization_id, status);

-- Org-level quota pool (reuses the personal grant structure;
-- organization_id NULL = personal grant).
alter table wallet_grants add column if not exists organization_id text;
create index if not exists wallet_grants_org_idx on wallet_grants (organization_id, status, expires_at);

-- Usage attribution to an org (aggregation dimension for admins).
alter table usage_events add column if not exists organization_id text;
create index if not exists usage_events_org_idx on usage_events (organization_id, created_at desc);
