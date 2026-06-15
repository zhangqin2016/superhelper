-- Server-managed workspace applications. These are complete apps exported
-- from workspaces or published by Lily, distinct from runtime packs and skills.
create table if not exists workspace_apps (
  id text primary key,
  app_id text not null,
  name text not null,
  summary text not null,
  description text,
  version text not null,
  category text not null default 'productivity',
  app_type text not null default 'workspace',
  entry_kind text not null default 'zip',
  publisher text not null default 'Lily Workbench',
  source_kind text not null default 'lily',
  source_repo text,
  artifact_url text not null,
  sha256 text not null,
  size_bytes bigint,
  min_app_version text,
  channel text not null default 'stable',
  risk_level text not null default 'low',
  featured boolean not null default false,
  enabled boolean not null default true,
  tags jsonb not null default '[]'::jsonb,
  required_runtime_packs jsonb not null default '[]'::jsonb,
  required_skill_packages jsonb not null default '[]'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_id, version, channel)
);

create index if not exists workspace_apps_catalog_lookup
  on workspace_apps (app_id, channel, enabled, created_at desc);

create index if not exists workspace_apps_featured_lookup
  on workspace_apps (featured, enabled, category);
