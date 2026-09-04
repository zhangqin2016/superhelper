-- Enterprise-issued accounts — a company generates dedicated accounts for its
-- staff instead of waiting for each person to self-register by SMS.
--
-- Identity was phone-only: users.phone_e164 NOT NULL UNIQUE, and the only login
-- was /api/auth/sms/*. So "the company creates the account" was impossible — a
-- user row could not exist without a phone the person personally controls.
--
-- This adds a second identity: a login name plus a password the company issues
-- once and the employee must change on first login. Accounts created this way
-- are OWNED by the organization (provisioned_organization_id): removing them
-- from the org disables the login, which is what "dedicated" means.
--
-- Backward compatibility, and the reason each choice is made the way it is:
--   - phone_e164 becomes nullable. Every existing row has a phone, so nothing
--     changes for them; only enterprise-issued rows are phone-less.
--   - a row must still have SOME identity (check constraint), so a user can
--     never exist that nobody can log in as.
--   - login_name is UNIQUE but nullable: phone-only users simply have none.
--   - the password hash is scrypt with a per-user salt (see
--     services/enterprise-accounts.js); the initial password is never stored.

alter table users alter column phone_e164 drop not null;

alter table users add column if not exists login_name text;
alter table users add column if not exists password_hash text;
alter table users add column if not exists password_must_change boolean not null default false;
alter table users add column if not exists password_failed_count integer not null default 0;
alter table users add column if not exists password_locked_until timestamptz;
alter table users add column if not exists provisioned_organization_id text references organizations(id) on delete set null;
alter table users add column if not exists display_name text;

-- One identity or the other; never neither.
alter table users drop constraint if exists users_identity_ck;
alter table users add constraint users_identity_ck
  check (phone_e164 is not null or login_name is not null);

-- Login names are compared lowercase; the service normalises before writing,
-- and this index makes the login lookup a point read.
create unique index if not exists users_login_name_uq on users (login_name) where login_name is not null;

-- The org console lists the accounts it issued.
create index if not exists users_provisioned_org_idx on users (provisioned_organization_id) where provisioned_organization_id is not null;
