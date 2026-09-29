-- Enterprise closed loop (2026-09-30). Additive; every existing reader keeps
-- reading organizations.status and keeps its meaning.
--
-- 1. Two-layer switch. The platform's disable used to be reversible by the
--    enterprise's own admin (the same PATCH on the same column). Now:
--      owner_status    — the enterprise's own pause (owner only)
--      platform_status — the platform's freeze (platform admin only)
--      status          — the EFFECTIVE state, derived, enforced by a CHECK so
--                        the three can never disagree.
-- 2. Source: enterprises are opened by the platform; self-serve creation is
--    closed. Existing orgs keep working and are labelled by where they came from.
-- 3. Weekly member budget (like a weekly usage limit): a rolling 7-day window
--    that starts at the member's first charge and resets 7 days later. Per-member
--    override, org default, null = unlimited. The per-request cap (quota) stays.
-- 4. Invitations: phones normalised to E.164 (login stores +86…, invitations
--    stored what was typed, so a typed 138… never redeemed) and an expiry.

alter table organizations add column if not exists owner_status text not null default 'active';
alter table organizations add column if not exists platform_status text not null default 'active';
alter table organizations add column if not exists platform_status_reason text;
alter table organizations add column if not exists platform_status_changed_at timestamptz;
alter table organizations add column if not exists source text not null default 'self_serve';
alter table organizations add column if not exists default_member_weekly_budget bigint;

alter table organizations drop constraint if exists organizations_owner_status_ck;
alter table organizations add constraint organizations_owner_status_ck check (owner_status in ('active', 'disabled'));
alter table organizations drop constraint if exists organizations_platform_status_ck;
alter table organizations add constraint organizations_platform_status_ck check (platform_status in ('active', 'suspended'));
alter table organizations drop constraint if exists organizations_source_ck;
alter table organizations add constraint organizations_source_ck check (source in ('platform', 'self_serve'));
alter table organizations drop constraint if exists organizations_weekly_budget_ck;
alter table organizations add constraint organizations_weekly_budget_ck check (default_member_weekly_budget is null or default_member_weekly_budget >= 0);

-- Orgs the platform admin created are on record in the audit log.
update organizations o set source = 'platform'
where exists (select 1 from audit_logs a where a.action = 'enterprise_org_create' and a.target_type = 'organization' and a.target_id = o.id);

-- A disabled org today may have been disabled by either side; the only switch
-- that existed in a UI was the platform's. Treat it as a platform freeze, so the
-- enterprise cannot lift it on its own — the conservative reading.
update organizations set platform_status = 'suspended', platform_status_changed_at = coalesce(platform_status_changed_at, updated_at)
where status = 'disabled' and platform_status = 'active' and owner_status = 'active';

alter table organizations drop constraint if exists organizations_status_derived_ck;
alter table organizations add constraint organizations_status_derived_ck check (
  status = case when owner_status = 'active' and platform_status = 'active' then 'active' else 'disabled' end
);

create index if not exists organizations_created_idx on organizations (created_at desc);

alter table organization_members add column if not exists weekly_budget bigint;
alter table organization_members add column if not exists weekly_window_started_at timestamptz;
alter table organization_members add column if not exists weekly_used bigint not null default 0;
alter table organization_members drop constraint if exists organization_members_weekly_budget_ck;
alter table organization_members add constraint organization_members_weekly_budget_ck check (weekly_budget is null or weekly_budget >= 0);

alter table organization_invitations add column if not exists expires_at timestamptz;
alter table organization_invitations drop constraint if exists organization_invitations_status_ck;
alter table organization_invitations add constraint organization_invitations_status_ck check (status in ('pending', 'accepted', 'revoked', 'expired'));

-- Normalise pending mainland numbers the way login does (normalizePhoneE164).
-- A number whose normalised form already has a pending invitation for the same
-- org is a duplicate of it: revoke the typed copy instead of colliding.
update organization_invitations i set status = 'revoked'
where i.status = 'pending' and regexp_replace(i.phone_e164, '[\s()-]', '', 'g') ~ '^1[3-9][0-9]{9}$'
  and exists (select 1 from organization_invitations j where j.organization_id = i.organization_id and j.status = 'pending'
    and j.phone_e164 = '+86' || regexp_replace(i.phone_e164, '[\s()-]', '', 'g'));
-- Two typed spellings of one number ("138 1234 5678", "13812345678"): keep the oldest.
update organization_invitations i set status = 'revoked'
where i.status = 'pending' and regexp_replace(i.phone_e164, '[\s()-]', '', 'g') ~ '^1[3-9][0-9]{9}$'
  and exists (select 1 from organization_invitations j where j.organization_id = i.organization_id and j.status = 'pending'
    and j.id <> i.id and regexp_replace(j.phone_e164, '[\s()-]', '', 'g') = regexp_replace(i.phone_e164, '[\s()-]', '', 'g')
    and (j.created_at, j.id) < (i.created_at, i.id));
update organization_invitations set phone_e164 = '+86' || regexp_replace(phone_e164, '[\s()-]', '', 'g')
where status = 'pending' and regexp_replace(phone_e164, '[\s()-]', '', 'g') ~ '^1[3-9][0-9]{9}$';
