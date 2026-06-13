-- Seed the default model gateway providers (verified against each vendor's
-- official Claude Code docs, 2026-06). Keyless on purpose: API keys are never
-- committed — an operator pastes them in the admin panel, or a provider whose
-- key already lives in server env is used automatically (listModelGatewayProviders
-- falls back to the env key when the DB row has none). ON CONFLICT DO NOTHING so
-- this only seeds a fresh table and never overwrites operator edits on redeploy.
--
-- Model names per vendor docs:
--   Qwen Coding Plan  -> qwen3.7-plus (all tiers)
--   Qwen pay-as-you-go-> qwen3.7-max (default) + qwen3.6-flash (fast)
--   DeepSeek          -> claude-* names, mapped server-side by DeepSeek
--   Kimi              -> kimi-k2.7-code
--   GLM               -> glm-5.2[1m] (default) + glm-4.5-air (fast)
insert into model_gateway_providers (id, label, type, base_url, default_model, models, enabled) values
  ('qwen-coding', 'Qwen Coding Plan', 'anthropic', 'https://coding.dashscope.aliyuncs.com/apps/anthropic', 'qwen3.7-plus', '["qwen3.7-plus"]'::jsonb, true),
  ('dashscope', 'Qwen 按量', 'anthropic', 'https://dashscope.aliyuncs.com/apps/anthropic', 'qwen3.7-max', '["qwen3.7-max","qwen3.6-flash"]'::jsonb, true),
  ('deepseek', 'DeepSeek', 'anthropic', 'https://api.deepseek.com/anthropic', 'claude-opus-4-5', '["claude-opus-4-5","claude-sonnet-4-5","claude-haiku-4-5"]'::jsonb, true),
  ('kimi', 'Kimi K2.7 Code', 'anthropic', 'https://api.moonshot.ai/anthropic', 'kimi-k2.7-code', '["kimi-k2.7-code"]'::jsonb, true),
  ('glm', 'GLM-5.2', 'anthropic', 'https://open.bigmodel.cn/api/anthropic', 'glm-5.2[1m]', '["glm-5.2[1m]","glm-4.5-air"]'::jsonb, true)
on conflict (id) do nothing;
