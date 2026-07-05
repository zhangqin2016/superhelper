-- Seed the default model gateway providers (OpenAI-compatible first, matching
-- the OpenCode runtime). Keyless on purpose: API keys are never
-- committed — an operator pastes them in the admin panel, or a provider whose
-- key already lives in server env is used automatically (listModelGatewayProviders
-- falls back to the env key when the DB row has none). ON CONFLICT DO NOTHING so
-- this only seeds a fresh table and never overwrites operator edits on redeploy.
--
-- Model names per vendor docs:
--   Qwen Coding Plan  -> qwen3.7-plus (all tiers)
--   Qwen pay-as-you-go-> qwen3.7-max (default) + qwen3.6-flash (fast)
--   DeepSeek          -> deepseek-v4-pro
--   Kimi              -> kimi-k2.7-code
--   GLM               -> glm-5.2 (default) + glm-4.5-air (fast)
insert into model_gateway_providers (id, label, type, base_url, default_model, models, enabled) values
  ('qwen-coding', 'Qwen Coding Plan', 'openai', 'https://coding.dashscope.aliyuncs.com/v1', 'qwen3.7-plus', '["qwen3.7-plus"]'::jsonb, true),
  ('dashscope', 'Qwen 按量', 'openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-max', '["qwen3.7-max","qwen3.6-flash"]'::jsonb, true),
  ('deepseek', 'DeepSeek', 'openai', 'https://api.deepseek.com/v1', 'deepseek-v4-pro', '["deepseek-v4-pro"]'::jsonb, true),
  ('kimi', 'Kimi K2.7 Code', 'openai', 'https://api.moonshot.ai/v1', 'kimi-k2.7-code', '["kimi-k2.7-code"]'::jsonb, true),
  ('glm', 'GLM-5.2', 'openai', 'https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.2', '["glm-5.2","glm-4.5-air"]'::jsonb, true)
on conflict (id) do nothing;
