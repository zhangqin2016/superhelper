create table if not exists legal_knowledge_packs (
  id text primary key,
  pack_id text not null,
  character_id text not null,
  version text not null,
  url text not null,
  sha256 text not null,
  size_bytes bigint not null,
  format text not null default 'zip',
  schema_version integer not null default 1,
  min_plan text not null default 'free',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (pack_id, character_id, version)
);

create index if not exists legal_knowledge_packs_lookup
  on legal_knowledge_packs (pack_id, character_id, enabled, created_at desc);
