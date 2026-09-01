-- One-time websocket tickets are bearer secrets only in transit. PostgreSQL
-- stores a hash and atomically consumes it before the websocket is accepted.

create table if not exists collaboration_ws_tickets (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  device_id text not null references devices(id) on delete cascade,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  foreign key (user_id, device_id) references user_devices(user_id, device_id) on delete cascade,
  constraint collaboration_ws_tickets_expiry_ck check (expires_at > issued_at)
);

create index if not exists collaboration_ws_tickets_active_idx
  on collaboration_ws_tickets (expires_at)
  where consumed_at is null;
