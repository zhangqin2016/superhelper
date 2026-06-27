-- Extra credentials for media providers that need more than one secret.
-- Kling auth is a JWT signed from AccessKey (api_key_encrypted) + SecretKey, so
-- we need a second encrypted secret. MiniMax (China) needs a GroupId query param.
-- These must NOT live in `headers` — that column is spread into upstream HTTP
-- request headers (anthropic/openai adapters), which would leak the secret to
-- the provider. Dedicated columns keep them out of that path.
--   secret_key_encrypted: AES-256-GCM (security.encryptSecret), like api_key.
--   metadata: jsonb for non-secret provider extras (e.g. { "groupId": "..." }).
alter table model_gateway_providers
  add column if not exists secret_key_encrypted text not null default '';

alter table model_gateway_providers
  add column if not exists metadata jsonb not null default '{}'::jsonb;
