create table if not exists plugin_events (
  id bigserial primary key,
  event_type text not null,
  plugin_id text not null,
  plugin_version text,
  license_id text,
  device_id text not null references devices(id),
  app_version text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists plugin_events_plugin_id_created_at_idx
  on plugin_events(plugin_id, created_at desc);

create index if not exists plugin_events_device_id_created_at_idx
  on plugin_events(device_id, created_at desc);
