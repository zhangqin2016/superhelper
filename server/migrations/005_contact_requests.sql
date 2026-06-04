create table if not exists contact_requests (
  id text primary key,
  name text not null,
  email text not null,
  company text,
  phone text,
  subject text,
  message text not null,
  source text,
  status text not null default 'new',
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists contact_requests_created_at_idx on contact_requests (created_at desc);
create index if not exists contact_requests_status_idx on contact_requests (status);
