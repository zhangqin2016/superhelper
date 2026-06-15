create table if not exists licenses (
  id text primary key,
  license_key_hash text not null unique,
  customer_name text,
  plan text not null default 'pro',
  seats integer not null default 1,
  expires_at timestamptz not null,
  status text not null default 'active',
  features jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists devices (
  id text primary key,
  fingerprint_hash text,
  platform text,
  arch text,
  app_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists license_devices (
  id text primary key,
  license_id text not null references licenses(id),
  device_id text not null references devices(id),
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active',
  unique (license_id, device_id)
);

create table if not exists usage_daily (
  id bigserial primary key,
  usage_date date not null,
  license_id text,
  device_id text not null references devices(id),
  model text not null,
  message_count integer not null default 0,
  image_count integer not null default 0,
  tool_call_count integer not null default 0,
  plugin_call_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (usage_date, device_id, model)
);

create table if not exists releases (
  id text primary key,
  version text not null,
  platform text not null,
  url text not null,
  sha256 text not null,
  size_bytes bigint,
  notes text,
  force_update boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (version, platform)
);

create table if not exists admin_users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  role text not null default 'admin',
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

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
