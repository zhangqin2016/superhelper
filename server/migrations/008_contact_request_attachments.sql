create table if not exists contact_request_attachments (
  id text primary key,
  contact_request_id text not null references contact_requests(id) on delete cascade,
  type text not null default 'image',
  storage_provider text not null default 'qiniu',
  object_key text not null,
  public_url text,
  mime_type text,
  size_bytes integer,
  width integer,
  height integer,
  sha256 text,
  original_name text,
  created_at timestamptz not null default now()
);

create index if not exists contact_request_attachments_request_idx
  on contact_request_attachments (contact_request_id);

create index if not exists contact_request_attachments_created_at_idx
  on contact_request_attachments (created_at desc);
