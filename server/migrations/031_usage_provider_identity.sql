-- usage_daily and its conflict target remain unchanged for old live servers.
create table usage_provider_daily (
  id bigserial primary key,
  usage_date date not null,
  license_id text,
  device_id text not null references devices(id),
  provider_id text not null default 'unknown',
  model text not null,
  message_count integer not null default 0,
  image_count integer not null default 0,
  tool_call_count integer not null default 0,
  plugin_call_count integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (usage_date, device_id, provider_id, model)
);

-- Receipts and counter increments are committed in the same transaction.
create table usage_report_receipts (
  device_id text not null references devices(id) on delete cascade,
  report_id text not null,
  created_at timestamptz not null default now(),
  primary key (device_id, report_id)
);

-- No backfill or trigger on the legacy table: historical usage and old-server
-- writes remain unknown, including writes arriving during a rolling upgrade.
-- The residual includes new unknown-provider reports too, so do not union those
-- detail rows separately. Aggregate and detail writes commit atomically.
create view usage_provider_breakdown as
select id, usage_date, license_id, device_id, provider_id, model,
  message_count, image_count, tool_call_count, plugin_call_count,
  input_tokens, output_tokens, created_at, updated_at
from usage_provider_daily
where provider_id <> 'unknown'
union all
select -d.id, d.usage_date, d.license_id, d.device_id, 'unknown', d.model,
  d.message_count - coalesce(p.message_count, 0),
  d.image_count - coalesce(p.image_count, 0),
  d.tool_call_count - coalesce(p.tool_call_count, 0),
  d.plugin_call_count - coalesce(p.plugin_call_count, 0),
  d.input_tokens - coalesce(p.input_tokens, 0),
  d.output_tokens - coalesce(p.output_tokens, 0),
  d.created_at, d.updated_at
from usage_daily d
left join (
  select usage_date, device_id, model,
    sum(message_count) as message_count, sum(image_count) as image_count,
    sum(tool_call_count) as tool_call_count, sum(plugin_call_count) as plugin_call_count,
    sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens
  from usage_provider_daily
  where provider_id <> 'unknown'
  group by usage_date, device_id, model
) p using (usage_date, device_id, model)
where d.message_count <> coalesce(p.message_count, 0)
   or d.image_count <> coalesce(p.image_count, 0)
   or d.tool_call_count <> coalesce(p.tool_call_count, 0)
   or d.plugin_call_count <> coalesce(p.plugin_call_count, 0)
   or d.input_tokens <> coalesce(p.input_tokens, 0)
   or d.output_tokens <> coalesce(p.output_tokens, 0);
