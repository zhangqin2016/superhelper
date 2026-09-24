-- Where an update stalls: one row per device × target version × stage, so a
-- rollout can say "412 downloaded, 9 failed to download, 380 installed" instead
-- of guessing from who later reports the new version. Kept apart from
-- runtime_diagnostics: update progress is not a runtime failure and must not
-- move a version's error rate.
create table if not exists update_events (
  device_id text not null,
  platform text not null,
  from_version text,
  to_version text not null,
  stage text not null check (stage in ('download_started', 'downloaded', 'download_failed', 'install_started')),
  error_code text,
  created_at timestamptz not null default now(),
  primary key (device_id, to_version, stage)
);

create index if not exists update_events_version_idx on update_events (platform, to_version, stage);
