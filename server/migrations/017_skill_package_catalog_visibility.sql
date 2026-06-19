-- Distinguish installable platform packages from user-facing catalog entries.
-- Some low-level bundles should be synced and auto-installed, but not shown as
-- standalone skills in the marketplace.
alter table skill_packages
  add column if not exists display_in_catalog boolean not null default true;
