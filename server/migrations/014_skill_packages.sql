-- Server-managed skill packages delivered as Qiniu-hosted skillpack zips.
-- The desktop client consumes /api/skills/registry and verifies sha256 before install.
create table if not exists skill_packages (
  id text primary key,
  skill_id text not null,
  name text not null,
  description text,
  version text not null,
  category text not null default 'core',
  category_label text,
  capability_layer text not null default 'core',
  publisher text not null default 'Lily Workbench',
  source_kind text not null default 'lily',
  source_repo text,
  artifact_url text not null,
  sha256 text not null,
  size_bytes bigint,
  min_app_version text,
  channel text not null default 'stable',
  risk_level text not null default 'low',
  default_eligible boolean not null default false,
  featured boolean not null default false,
  enabled boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (skill_id, version, channel)
);

create index if not exists skill_packages_registry_lookup
  on skill_packages (skill_id, channel, enabled, created_at desc);

create index if not exists skill_packages_featured_lookup
  on skill_packages (default_eligible, featured, enabled);
