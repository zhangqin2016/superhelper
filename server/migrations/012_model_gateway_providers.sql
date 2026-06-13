-- DB-backed model gateway providers, so operators can add/edit providers (and
-- their API keys) from the admin UI instead of only via server env. The /llm
-- gateway merges these with the env-configured providers; the client never
-- receives a raw key — it always gets a short-lived gateway token and the
-- gateway uses the stored key to reach the LLM. api_key is encrypted at rest
-- (security.encryptSecret, keyed off SESSION_SECRET).
create table if not exists model_gateway_providers (
  id text primary key,
  label text not null default '',
  type text not null default 'anthropic',
  base_url text not null default '',
  api_key_encrypted text not null default '',
  default_model text not null default '',
  models jsonb not null default '[]'::jsonb,
  headers jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
