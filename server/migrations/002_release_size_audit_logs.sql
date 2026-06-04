alter table releases
  add column if not exists size_bytes bigint;

create table if not exists audit_logs (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target_type text not null,
  target_id text,
  ip text,
  user_agent text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
