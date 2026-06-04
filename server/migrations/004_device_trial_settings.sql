create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value)
values ('license_trial_days', '3'::jsonb)
on conflict (key) do nothing;

alter table devices
  add column if not exists trial_ends_at timestamptz;
