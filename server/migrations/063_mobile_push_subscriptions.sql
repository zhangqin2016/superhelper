-- A paired phone's Web Push subscription, so the desktop can reach it when its
-- page is closed or asleep: "the task finished", "Lily needs your
-- confirmation". Scoped to a pairing — it goes when the pairing ends — and it
-- carries no conversation content: the notification only says to look.
create table if not exists mobile_push_subscriptions (
  id text primary key,
  grant_id text not null references mobile_pairing_grants(id) on delete cascade,
  mobile_device_id text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  failures integer not null default 0
);

create index if not exists mobile_push_subscriptions_grant_idx on mobile_push_subscriptions (grant_id);
