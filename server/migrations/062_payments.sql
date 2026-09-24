-- Real payments. Until now an order could only become "paid" through the fake
-- payment toggle or a development endpoint: nothing asked Alipay or WeChat to
-- take money, and nothing received their notification. This adds the three
-- things a payment needs to be trustworthy:
--
--   payments        each attempt to pay an order (a user may switch method or
--                   retry). Its id IS the merchant trade number sent to the
--                   provider, so a provider result maps to exactly one attempt.
--   payment_events  every notification and query result, stored BEFORE it is
--                   acted on — what the provider said, whether its signature
--                   verified, and what we did. Money decisions are auditable
--                   and replayable.
--   refunds         a refund is its own record with its own lifecycle; the
--                   ledger reversal happens when the provider confirms it.
--
-- And gives orders a lifetime: an unpaid order expires instead of sitting
-- "pending" forever, and a refunded amount is tracked on the order.

alter table orders add column if not exists expires_at timestamptz;
alter table orders add column if not exists closed_at timestamptz;
alter table orders add column if not exists refunded_cents integer not null default 0;
alter table orders add column if not exists payment_id text;

create table if not exists payments (
  id text primary key,                         -- = out_trade_no at the provider
  order_id text not null references orders(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  provider text not null,                      -- alipay | wechat
  method text not null,                        -- page | wap | precreate | native
  amount_cents integer not null,
  currency text not null default 'CNY',
  status text not null default 'pending',      -- pending | succeeded | closed | failed
  provider_trade_no text,
  checkout jsonb not null default '{}',        -- { kind: redirect|qrcode, url|code }
  last_synced_at timestamptz,
  succeeded_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payments_order_idx on payments (order_id, created_at desc);
create index if not exists payments_pending_idx on payments (status, created_at) where status = 'pending';
create unique index if not exists payments_provider_trade_unique
  on payments (provider, provider_trade_no)
  where provider_trade_no is not null;

create table if not exists payment_events (
  id text primary key,
  provider text not null,
  payment_id text,                             -- null when the event names no payment of ours
  kind text not null,                          -- notify | query | close | refund | reconcile
  verified boolean not null default false,
  outcome text not null,                       -- settled | duplicate | ignored | rejected | error | …
  detail text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists payment_events_payment_idx on payment_events (payment_id, created_at desc);
create index if not exists payment_events_created_idx on payment_events (created_at desc);

create table if not exists refunds (
  id text primary key,                         -- = out_request_no / out_refund_no
  order_id text not null references orders(id) on delete cascade,
  payment_id text not null references payments(id),
  user_id text not null references users(id) on delete cascade,
  amount_cents integer not null,
  reason text,
  status text not null default 'pending',      -- pending | succeeded | failed
  provider_refund_no text,
  actor text,
  error text,
  created_at timestamptz not null default now(),
  succeeded_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists refunds_order_idx on refunds (order_id, created_at desc);

create table if not exists reconciliation_runs (
  id text primary key,
  provider text not null,
  bill_date date not null,
  status text not null,                        -- matched | mismatched | failed
  summary jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create unique index if not exists reconciliation_runs_unique on reconciliation_runs (provider, bill_date);
