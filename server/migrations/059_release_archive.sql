-- An archived release: its installer and feeds were moved under archive/ in
-- object storage (reversible), so old direct links stop handing out a build
-- nobody should install. The moved keys are kept for an exact restore.
alter table releases
  add column if not exists archived_at timestamptz,
  add column if not exists archived_objects jsonb not null default '[]'::jsonb;
