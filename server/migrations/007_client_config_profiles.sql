create table if not exists config_profiles (
  id text primary key,
  name text not null,
  scope text not null default 'global',
  target_id text,
  priority integer not null default 0,
  rollout_percent integer not null default 100 check (rollout_percent >= 0 and rollout_percent <= 100),
  enabled boolean not null default true,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists config_profiles_scope_target_idx
  on config_profiles (scope, target_id, enabled, priority);

alter table config_profiles
  add column if not exists rollout_percent integer not null default 100;

alter table config_profiles
  drop constraint if exists config_profiles_rollout_percent_check;

alter table config_profiles
  add constraint config_profiles_rollout_percent_check
  check (rollout_percent >= 0 and rollout_percent <= 100);

create table if not exists config_profile_revisions (
  id bigserial primary key,
  profile_id text not null references config_profiles(id) on delete cascade,
  name text not null,
  scope text not null,
  target_id text,
  priority integer not null,
  rollout_percent integer not null,
  enabled boolean not null,
  config jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists config_profile_revisions_profile_idx
  on config_profile_revisions (profile_id, created_at desc, id desc);

create table if not exists device_public_keys (
  device_id text primary key references devices(id) on delete cascade,
  public_key text not null,
  key_alg text not null default 'ed25519',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists request_nonces (
  device_id text not null references devices(id) on delete cascade,
  nonce text not null,
  created_at timestamptz not null default now(),
  primary key (device_id, nonce)
);
