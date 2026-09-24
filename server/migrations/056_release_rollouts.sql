-- A release becomes a rollout: a stateful, staged delivery of one version to
-- one platform. A release with no rollout row keeps today's meaning (enabled
-- = offered to everyone), so this migration changes no client's behaviour.

alter table releases
  -- The release has its own immutable auto-update feed at
  -- auto-updates/<platform>/releases/<version>/, so a device can be pointed at
  -- exactly this version. Legacy releases only have the mutable stable/ feed.
  add column if not exists immutable_feed boolean not null default false;

create table if not exists release_rollouts (
  id text primary key,
  release_id text not null references releases(id) on delete cascade,
  platform text not null,
  version text not null,
  channel text not null default 'stable',
  state text not null check (state in ('draft', 'rolling', 'paused', 'halted', 'complete')),
  percent integer not null default 0 check (percent between 0 and 100),
  notes text,
  created_by text,
  started_at timestamptz,
  completed_at timestamptz,
  halted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (release_id, channel)
);

create index if not exists release_rollouts_channel_platform_idx on release_rollouts (channel, platform, state);
