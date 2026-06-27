-- Align DeepSeek's managed provider with the model ids our OpenCode runtime
-- actually sends. Older seed data used Claude-style aliases, which made the
-- client look like it was not using DeepSeek and could be incompatible with
-- non-Claude runtimes.
update model_gateway_providers
set
  default_model = 'deepseek-v4-pro[1m]',
  models = '["deepseek-v4-pro[1m]"]'::jsonb,
  updated_at = now()
where
  id = 'deepseek'
  and default_model in ('claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5');
