create table if not exists users (
  id text primary key,
  phone_e164 text not null unique,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists sms_codes (
  id text primary key,
  phone_e164 text not null,
  code_hash text not null,
  purpose text not null default 'login',
  expires_at timestamptz not null,
  attempt_count integer not null default 0,
  consumed_at timestamptz,
  ip text,
  user_agent text,
  device_id text,
  risk_level text not null default 'low',
  risk_reason text,
  send_provider text,
  send_status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists sms_codes_phone_created_idx on sms_codes (phone_e164, created_at desc);
create index if not exists sms_codes_device_created_idx on sms_codes (device_id, created_at desc);

create table if not exists sms_rate_limits (
  bucket_key text not null,
  purpose text not null default 'login',
  window_started_at timestamptz not null,
  request_count integer not null default 0,
  blocked_until timestamptz,
  last_request_at timestamptz not null default now(),
  primary key (bucket_key, purpose, window_started_at)
);

create table if not exists user_sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  device_id text not null references devices(id) on delete cascade,
  refresh_token_hash text not null unique,
  refresh_token_version integer not null default 1,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists user_sessions_user_idx on user_sessions (user_id, created_at desc);
create index if not exists user_sessions_device_idx on user_sessions (device_id, created_at desc);

create table if not exists user_devices (
  user_id text not null references users(id) on delete cascade,
  device_id text not null references devices(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active',
  primary key (user_id, device_id)
);

create table if not exists products (
  id text primary key,
  kind text not null,
  name text not null,
  description text,
  price_cents integer not null,
  currency text not null default 'CNY',
  resource_type text not null,
  unit_amount integer not null default 0,
  duration_seconds integer,
  grant_expires_days integer,
  metadata jsonb not null default '{}',
  status text not null default 'active',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists feature_pricing_rules (
  id text primary key,
  feature text not null,
  provider text,
  model text,
  spec_key text not null,
  resource_type text not null,
  unit_cost integer not null default 1,
  free_daily_limit integer,
  paid_daily_limit integer,
  concurrency_limit integer,
  enabled boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists feature_pricing_rules_lookup
  on feature_pricing_rules (feature, coalesce(provider, ''), coalesce(model, ''), spec_key);

create table if not exists orders (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  product_id text not null references products(id),
  provider text not null,
  provider_order_id text,
  amount_cents integer not null,
  currency text not null default 'CNY',
  status text not null default 'pending',
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists orders_provider_order_unique
  on orders (provider, provider_order_id)
  where provider_order_id is not null;

create table if not exists wallet_grants (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  source_type text not null,
  source_id text,
  grant_type text not null,
  resource_type text not null,
  token_total integer not null default 0,
  token_remaining integer not null default 0,
  unit_total integer not null default 0,
  unit_remaining integer not null default 0,
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'active',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists wallet_grants_user_active_idx on wallet_grants (user_id, status, expires_at);

create table if not exists wallet_ledger (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  grant_id text references wallet_grants(id),
  event_type text not null,
  resource_type text,
  token_delta integer not null default 0,
  unit_delta integer not null default 0,
  money_delta_cents integer not null default 0,
  source_type text,
  source_id text,
  idempotency_key text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists wallet_ledger_idempotency_unique
  on wallet_ledger (idempotency_key)
  where idempotency_key is not null;

create table if not exists usage_events (
  id text primary key,
  user_id text references users(id),
  device_id text references devices(id),
  license_id text,
  model text,
  provider text,
  feature text,
  spec_key text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  billable_tokens integer not null default 0,
  resource_type text,
  billable_units integer not null default 0,
  unit_cost integer not null default 0,
  status text not null default 'completed',
  idempotency_key text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists usage_events_idempotency_unique
  on usage_events (idempotency_key)
  where idempotency_key is not null;

create table if not exists billing_link_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  session_id text not null references user_sessions(id) on delete cascade,
  device_id text not null references devices(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
