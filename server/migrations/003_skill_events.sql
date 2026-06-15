create table if not exists skill_events (
  id bigserial primary key,
  event_type text not null,
  skill_id text not null,
  skill_version text,
  license_id text,
  device_id text not null references devices(id),
  app_version text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists skill_events_skill_id_created_at_idx
  on skill_events(skill_id, created_at desc);

create index if not exists skill_events_device_id_created_at_idx
  on skill_events(device_id, created_at desc);
