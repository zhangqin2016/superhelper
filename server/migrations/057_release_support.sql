-- What a channel × platform still supports: a minimum version (a floor every
-- client below must reach), versions pulled for being bad (never offered), and
-- an optional deadline after which a mandate can no longer be postponed.
-- Replaces the per-release force_update flag as the one place "must update"
-- comes from. Empty table = no floor, exactly as today.
create table if not exists release_support (
  channel text not null default 'stable',
  platform text not null,
  min_supported_version text,
  blocked_versions jsonb not null default '[]'::jsonb,
  mandate_deadline timestamptz,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (channel, platform)
);
