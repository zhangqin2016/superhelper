-- Access tier for workspace apps. A viewer's license plan must rank >= an app's
-- min_plan to see/install it (free < pro < vip). Default 'free' keeps every
-- existing app visible to everyone — gating is opt-in per app by an admin.
alter table workspace_apps
  add column if not exists min_plan text not null default 'free';

create index if not exists workspace_apps_min_plan_lookup
  on workspace_apps (channel, enabled, min_plan);
