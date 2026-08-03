\set ON_ERROR_STOP on

-- One-time emergency credit for every account present at execution time.
-- Safe to rerun: the stable batch identity admits exactly one grant per user.
begin;

select pg_advisory_xact_lock(hashtext('global-100m-2026-08-03'));

with target_users as (
  select
    u.id as user_id,
    'grant_' || replace(gen_random_uuid()::text, '-', '') as grant_id
  from users u
  where not exists (
    select 1
    from wallet_grants existing
    where existing.user_id = u.id
      and existing.source_type = 'admin_bulk_grant'
      and existing.source_id = 'global-100m-2026-08-03'
      and existing.resource_type = 'token'
  )
), inserted_grants as (
  insert into wallet_grants (
    id, user_id, source_type, source_id, grant_type, resource_type,
    token_total, token_remaining, unit_total, unit_remaining,
    starts_at, expires_at, status, metadata
  )
  select
    target_users.grant_id,
    target_users.user_id,
    'admin_bulk_grant',
    'global-100m-2026-08-03',
    'operations_token_credit',
    'token',
    100000000,
    100000000,
    100000000,
    100000000,
    now(),
    '2099-12-31T23:59:59Z'::timestamptz,
    'active',
    '{"reason":"restore free access for all existing users","batch":"global-100m-2026-08-03"}'::jsonb
  from target_users
  returning id, user_id, unit_total
)
insert into wallet_ledger (
  id, user_id, grant_id, event_type, resource_type,
  token_delta, unit_delta, source_type, source_id,
  idempotency_key, metadata
)
select
  'ledger_' || replace(gen_random_uuid()::text, '-', ''),
  inserted_grants.user_id,
  inserted_grants.id,
  'grant',
  'token',
  inserted_grants.unit_total,
  inserted_grants.unit_total,
  'admin_bulk_grant',
  'global-100m-2026-08-03',
  'admin_bulk_grant:global-100m-2026-08-03:' || inserted_grants.user_id,
  '{"batch":"global-100m-2026-08-03"}'::jsonb
from inserted_grants;

do $$
declare
  missing_or_duplicate_users integer;
  malformed_grants integer;
  missing_ledgers integer;
begin
  select count(*)
  into missing_or_duplicate_users
  from (
    select u.id
    from users u
    left join wallet_grants g
      on g.user_id = u.id
      and g.source_type = 'admin_bulk_grant'
      and g.source_id = 'global-100m-2026-08-03'
      and g.resource_type = 'token'
    group by u.id
    having count(g.id) <> 1
  ) invalid_users;

  select count(*)
  into malformed_grants
  from wallet_grants g
  where g.source_type = 'admin_bulk_grant'
    and g.source_id = 'global-100m-2026-08-03'
    and (
      g.grant_type <> 'operations_token_credit'
      or g.resource_type <> 'token'
      or g.token_total <> 100000000
      or g.unit_total <> 100000000
      or g.token_remaining < 0
      or g.token_remaining > 100000000
      or g.unit_remaining <> g.token_remaining
      or g.status <> 'active'
    );

  select count(*)
  into missing_ledgers
  from wallet_grants g
  left join wallet_ledger l
    on l.grant_id = g.id
    and l.event_type = 'grant'
    and l.idempotency_key = 'admin_bulk_grant:global-100m-2026-08-03:' || g.user_id
  where g.source_type = 'admin_bulk_grant'
    and g.source_id = 'global-100m-2026-08-03'
    and l.id is null;

  if missing_or_duplicate_users <> 0 or malformed_grants <> 0 or missing_ledgers <> 0 then
    raise exception 'global token grant verification failed: users=%, grants=%, ledgers=%',
      missing_or_duplicate_users, malformed_grants, missing_ledgers;
  end if;
end $$;

commit;

select
  count(*) as users_credited,
  sum(token_total) as tokens_granted,
  sum(token_remaining) as tokens_remaining
from wallet_grants
where source_type = 'admin_bulk_grant'
  and source_id = 'global-100m-2026-08-03'
  and resource_type = 'token';
