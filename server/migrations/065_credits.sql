-- Lily credits (积分), 2026-09-30: 1 yuan = 1000 credits; every model consumes
-- credits at its own rate (feature_pricing_rules.metadata.creditsPerMillion,
-- see src/services/credit-pricing.js). The wallet keeps credits in the
-- resource_type 'token' balance (the name predates credits).
--
-- Old balances convert BY VALUE: they were charged one unit per token whatever
-- the model, on flash-dominant traffic — 1,600 credits per million tokens.
-- History converts with them (ledger and usage units), so a statement never
-- mixes the two scales; usage_events.billable_tokens keeps the raw tokens.
-- Runs once: guarded by app_settings 'credits_converted'.

do $$
declare
  ratio numeric := 1600.0 / 1000000.0;
begin
  if exists (select 1 from app_settings where key = 'credits_converted') then
    return;
  end if;

  update wallet_grants set
    unit_total = ceil(unit_total * ratio)::int,
    unit_remaining = ceil(unit_remaining * ratio)::int,
    token_total = ceil(token_total * ratio)::int,
    token_remaining = ceil(token_remaining * ratio)::int,
    metadata = metadata || jsonb_build_object('legacyTokenTotal', unit_total, 'legacyTokenRemaining', unit_remaining, 'creditRatio', ratio)
  where resource_type = 'token';

  update wallet_ledger set
    unit_delta = round(unit_delta * ratio)::int,
    token_delta = round(token_delta * ratio)::int
  where resource_type = 'token';

  update usage_events set billable_units = ceil(billable_units * ratio)::int
  where resource_type = 'token';

  update organization_members set
    weekly_budget = case when weekly_budget is null then null else ceil(weekly_budget * ratio)::bigint end,
    weekly_used = ceil(weekly_used * ratio)::bigint,
    quota = case when quota is null then null else ceil(quota * ratio)::int end;

  update organizations set default_member_weekly_budget = ceil(default_member_weekly_budget * ratio)::bigint
  where default_member_weekly_budget is not null;

  -- People whose converted balance fell below the new signup gift (2,000) are
  -- topped up to it, so an early user never starts behind a new one. Only
  -- balances that exist (> 0) and are personal; valid 30 days.
  insert into wallet_grants (id, user_id, source_type, source_id, grant_type, resource_type, token_total, token_remaining, unit_total, unit_remaining, starts_at, expires_at, status, metadata)
  select 'grant_credit_topup_' || b.user_id, b.user_id, 'credit_conversion', b.user_id, 'free_tokens', 'token',
         2000 - b.balance, 2000 - b.balance, 2000 - b.balance, 2000 - b.balance, now(), now() + interval '30 days', 'active',
         jsonb_build_object('reason', 'credit_conversion_topup', 'convertedBalance', b.balance)
  from (
    select user_id, sum(unit_remaining)::int as balance from wallet_grants
    where resource_type = 'token' and organization_id is null and status = 'active' and starts_at <= now() and expires_at > now()
    group by user_id having sum(unit_remaining) > 0 and sum(unit_remaining) < 2000
  ) b
  on conflict (id) do nothing;
  insert into wallet_ledger (id, user_id, grant_id, event_type, resource_type, token_delta, unit_delta, source_type, source_id, idempotency_key, metadata)
  select 'ledger_credit_topup_' || g.user_id, g.user_id, g.id, 'grant', 'token', g.unit_total, g.unit_total, 'credit_conversion', g.user_id,
         'credit_topup:' || g.user_id, '{}'::jsonb
  from wallet_grants g where g.source_type = 'credit_conversion'
  on conflict do nothing;

  insert into app_settings (key, value) values ('credits_converted', jsonb_build_object('at', now(), 'creditsPerMillionTokens', 1600));
end $$;

-- Rates at peak supplier price (DeepSeek, 2026-09-30) sold at 30% gross margin,
-- in credits per million tokens. 'default' covers any model without its own
-- rule, at the most expensive model's rate.
insert into feature_pricing_rules (id, feature, provider, model, spec_key, resource_type, unit_cost, enabled, metadata) values
  ('credit_deepseek_flash', 'chat_model', null, null, 'deepseek-flash', 'token', 1, true,
    '{"creditsPerMillion": {"inputCached": 60, "input": 2900, "output": 11500}, "supplier": "deepseek", "basis": "peak 0.04/2/8 CNY per 1M, /0.7"}'),
  ('credit_deepseek_v4_flash', 'chat_model', null, null, 'deepseek-v4-flash', 'token', 1, true,
    '{"creditsPerMillion": {"inputCached": 60, "input": 2900, "output": 11500}, "supplier": "deepseek", "basis": "peak 0.04/2/8 CNY per 1M, /0.7"}'),
  ('credit_deepseek_v4_pro', 'chat_model', null, null, 'deepseek-v4-pro', 'token', 1, true,
    '{"creditsPerMillion": {"inputCached": 450, "input": 13000, "output": 39000}, "supplier": "deepseek", "basis": "peak 0.30/9/27 CNY per 1M, /0.7"}'),
  ('credit_default', 'chat_model', null, null, 'default', 'token', 1, true,
    '{"creditsPerMillion": {"inputCached": 450, "input": 13000, "output": 39000}, "basis": "fallback = most expensive model"}')
on conflict do nothing;
