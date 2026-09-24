-- A feedback ticket that says "it broke" with nothing behind it cannot be acted
-- on. The desktop client now sends, when the user leaves the box ticked, the
-- redacted support-diagnostics report and a bounded tail of its main-process
-- log alongside the request.
--
-- Kept here rather than beside the screenshots: those live at a public CDN URL,
-- and a log carries conversation text. This row is readable only through the
-- admin API.
create table if not exists contact_request_diagnostics (
  contact_request_id text primary key references contact_requests(id) on delete cascade,
  report jsonb,
  log_gzip bytea,
  log_bytes integer,
  log_compressed_bytes integer,
  log_sha256 text,
  log_truncated boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists contact_request_diagnostics_created_at_idx
  on contact_request_diagnostics (created_at desc);
