-- Licence codes (授权码) join the credit pricing (2026-09-30).
--
-- A licence now opens a plan: pro | max | standard (企业标准) | premium (企业高级)
-- | trial. Each licence has its own weekly credit pool: credits per seat per
-- week × the seats actually in use (active bound devices, capped by `seats`),
-- so a licence typed with 99999 seats is not a bottomless pool. Licensed
-- devices spend the pool first, then the signed-in account's own credits.
-- Before this, licensed devices were not metered at all.
--
-- Every existing licence moves to the highest plan (owner decision); the old
-- label is kept in legacy_plan.

alter table licenses add column if not exists legacy_plan text;
alter table licenses add column if not exists weekly_credits_per_seat bigint;
alter table licenses drop constraint if exists licenses_weekly_credits_ck;
alter table licenses add constraint licenses_weekly_credits_ck check (weekly_credits_per_seat is null or weekly_credits_per_seat >= 0);

-- A migration runs once, at deploy: every licence that exists now is historical.
update licenses set legacy_plan = plan, plan = 'premium' where legacy_plan is null;

-- One row per licence per week; the pool size is fixed when the week opens.
create table if not exists license_credit_weeks (
  license_id text not null references licenses(id) on delete cascade,
  week_index integer not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  seats_in_use integer not null,
  credits_total bigint not null,
  credits_used bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (license_id, week_index)
);
