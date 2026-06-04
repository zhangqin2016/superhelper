create table if not exists runtime_diagnostics (
  id text primary key,
  device_id text not null references devices(id),
  license_id text,
  app_version text,
  platform text,
  arch text,
  claude_version text,
  event_type text,
  event_subtype text,
  normalized_kind text,
  severity text not null default 'warning',
  turn_phase text,
  session_state text,
  summary text,
  trace jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists runtime_diagnostics_created_at_idx
  on runtime_diagnostics(created_at desc);

create index if not exists runtime_diagnostics_device_id_created_at_idx
  on runtime_diagnostics(device_id, created_at desc);

create index if not exists runtime_diagnostics_kind_created_at_idx
  on runtime_diagnostics(normalized_kind, created_at desc);
