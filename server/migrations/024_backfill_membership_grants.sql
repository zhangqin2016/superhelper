-- Remediation for the account-wallet rollout (022): existing users held valid
-- LICENSES but the model gateway now debits WALLET GRANTS, and nothing ever
-- seeded wallets for pre-wallet accounts — so licensed users started getting
-- 402 ENTITLEMENT_INSUFFICIENT ("余额不足") on every chat request.
--
-- Fix: grant EVERY existing user a membership through 2027-01-01. Membership
-- grants bypass unit debits entirely (selectGrantsForConsumption returns
-- coveredByMembership), so this restores the pre-wallet experience without
-- touching token/image/video accounting.
--
-- Idempotent: skipped for users who already hold an active remediation or
-- membership grant covering 2027-01-01, so redeploys never double-grant.
insert into wallet_grants (
  id, user_id, source_type, source_id, grant_type, resource_type,
  token_total, token_remaining, unit_total, unit_remaining,
  starts_at, expires_at, status, metadata
)
select
  'grant_' || replace(gen_random_uuid()::text, '-', ''),
  u.id,
  'wallet_rollout_remediation',
  null,
  'membership',
  'membership',
  0, 0, 0, 0,
  now(),
  '2027-01-01T00:00:00Z'::timestamptz,
  'active',
  '{"reason":"pre-wallet licensed users hit 402 after the 022 wallet rollout"}'::jsonb
from users u
where u.status = 'active'
  and not exists (
    select 1 from wallet_grants g
    where g.user_id = u.id
      and g.resource_type = 'membership'
      and g.status = 'active'
      and g.expires_at >= '2027-01-01T00:00:00Z'::timestamptz
  );

-- Ledger entries so the remediation is auditable like any other grant.
insert into wallet_ledger (
  id, user_id, grant_id, event_type, resource_type,
  token_delta, unit_delta, source_type, idempotency_key, metadata
)
select
  'ledger_' || replace(gen_random_uuid()::text, '-', ''),
  g.user_id,
  g.id,
  'grant',
  'membership',
  0,
  0,
  'wallet_rollout_remediation',
  'wallet_rollout_remediation:' || g.user_id,
  '{"source":"wallet_rollout_remediation"}'::jsonb
from wallet_grants g
where g.source_type = 'wallet_rollout_remediation'
  and not exists (
    select 1 from wallet_ledger l where l.grant_id = g.id and l.event_type = 'grant'
  );
