-- Tier/config groups: a named group that a device (or a whole license/customer)
-- belongs to, so config profiles (model presets, runtime env, policy …) can be
-- delivered per group — e.g. give the "vip" tier a stronger model. This is just
-- another scope on the existing general config-profile system; group config
-- carries any config, model being one use.
create table if not exists config_groups (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

-- A device may be assigned to a group directly; a license (customer/tier) may
-- also carry a group, which its devices inherit unless the device overrides it.
alter table devices add column if not exists group_id text;
alter table licenses add column if not exists group_id text;

create index if not exists devices_group_lookup on devices (group_id);
create index if not exists licenses_group_lookup on licenses (group_id);
