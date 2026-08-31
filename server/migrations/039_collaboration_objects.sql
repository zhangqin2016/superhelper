create table stored_objects (
  id text primary key,
  owner_user_id text not null references users(id),
  conversation_id text not null references conversations(id),
  scope_type text not null check(scope_type in ('personal','organization')),
  organization_id text references organizations(id),
  purpose text not null check(purpose in ('attachment','workspace')),
  provider text not null default 'qiniu' check(provider = 'qiniu'),
  object_key text not null unique,
  state text not null check(state in ('initiated','uploading','uploaded','verified','bound','expired','aborted','rejected','revoked','deleted')),
  ciphertext_size bigint not null check(ciphertext_size > 0 and ciphertext_size <= case when purpose = 'workspace' then 268435456 else 1073741824 end),
  ciphertext_sha256 text not null check(ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  provider_etag text,
  mime_type text not null,
  original_name text not null,
  bound_message_id text references messages(id),
  expires_at timestamptz,
  orphan_expires_at timestamptz not null default now() + interval '24 hours',
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((scope_type = 'organization') = (organization_id is not null)),
  check((state = 'bound' and bound_message_id is not null) or state <> 'bound')
);
create index stored_objects_owner_state_idx on stored_objects(owner_user_id,state);
create index stored_objects_orphan_cleanup_idx on stored_objects(orphan_expires_at) where state in ('initiated','uploading','uploaded','verified');
create table object_keys (
  object_id text primary key references stored_objects(id) on delete cascade,
  wrapped_dek bytea not null check(octet_length(wrapped_dek) = 60),
  kek_version integer not null check(kek_version > 0),
  algorithm text not null check(algorithm = 'aes-256-gcm'),
  created_at timestamptz not null default now()
);
create table message_attachments (
  message_id text not null references messages(id),
  object_id text not null unique references stored_objects(id),
  purpose text not null check(purpose in ('attachment','workspace')),
  sort_order integer not null default 0 check(sort_order >= 0),
  primary key(message_id,object_id)
);
create table workspace_shares (
  id text primary key,
  object_id text not null unique references stored_objects(id),
  source_name text not null,
  source_manifest_summary jsonb not null default '{}',
  plaintext_sha256 text not null check(plaintext_sha256 ~ '^[0-9a-f]{64}$'),
  parent_share_id text references workspace_shares(id),
  expires_at timestamptz not null,
  created_by text not null references users(id),
  created_at timestamptz not null default now()
);
-- Durable compensation only; remote deletion is performed by a separate worker.
create table object_cleanup_jobs (
  object_id text primary key references stored_objects(id),
  reason text not null,
  state text not null default 'pending' check(state in ('pending','leased','completed')),
  available_at timestamptz not null default now(),
  attempts integer not null default 0 check(attempts >= 0),
  last_error_code text,
  created_at timestamptz not null default now()
);
