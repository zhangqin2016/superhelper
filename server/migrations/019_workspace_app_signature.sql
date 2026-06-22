-- Publisher signature over {appId, sha256} (ed25519, license key) so the client
-- can verify a workspace app is authentic — not just intact (sha256). An app
-- carries executable skills/scripts, so authenticity matters. Empty when the
-- signing key isn't configured (dev / unsigned); the client treats those as
-- unverified.
alter table workspace_apps
  add column if not exists signature text not null default '';
