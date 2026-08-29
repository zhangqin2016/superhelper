-- 034 is intentionally reserved for Task 16 collaboration object storage.
-- A full-resync acknowledgement may only consume a server-issued completion
-- record. The raw token never enters PostgreSQL, logs, or durable events.

create table if not exists collaboration_bootstrap_completions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  device_id text not null references devices(id) on delete cascade,
  watermark bigint not null,
  snapshot_schema_version integer not null default 1,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (user_id, device_id) references user_devices(user_id, device_id) on delete cascade,
  constraint collaboration_bootstrap_completion_watermark_ck check (watermark >= 0),
  constraint collaboration_bootstrap_completion_expiry_ck check (expires_at > issued_at)
);

create index if not exists collaboration_bootstrap_completions_device_idx
  on collaboration_bootstrap_completions (user_id, device_id, expires_at)
  where consumed_at is null;
