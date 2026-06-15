-- Optional runtime packs (e.g. the pro-pdf Docling engine).
-- The desktop app resolves a per-pack, per-platform download here so the
-- artifact can be hosted on a China-reachable CDN (Qiniu) and reconfigured
-- server-side without an app release. Mirrors the releases table.
create table if not exists runtime_packs (
  id text primary key,
  pack_id text not null,
  platform text not null,
  url text not null,
  sha256 text not null,
  version text not null,
  size_bytes bigint,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (pack_id, platform, version)
);

create index if not exists runtime_packs_lookup
  on runtime_packs (pack_id, platform, enabled);
