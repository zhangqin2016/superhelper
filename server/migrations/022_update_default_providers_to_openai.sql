-- Move built-in chat providers to OpenAI-compatible endpoints for the OpenCode
-- runtime. Provider API keys stay untouched.

update model_gateway_providers
set
  type = 'openai',
  base_url = 'https://coding.dashscope.aliyuncs.com/v1',
  default_model = 'qwen3.7-plus',
  models = '["qwen3.7-plus"]'::jsonb,
  updated_at = now()
where id = 'qwen-coding';

update model_gateway_providers
set
  type = 'openai',
  base_url = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  default_model = 'qwen3.7-max',
  models = '["qwen3.7-max","qwen3.6-flash"]'::jsonb,
  updated_at = now()
where id = 'dashscope';

update model_gateway_providers
set
  type = 'openai',
  base_url = 'https://api.deepseek.com/v1',
  default_model = 'deepseek-v4-pro',
  models = '["deepseek-v4-pro"]'::jsonb,
  updated_at = now()
where id = 'deepseek';

update model_gateway_providers
set
  type = 'openai',
  base_url = 'https://api.moonshot.ai/v1',
  default_model = 'kimi-k2.7-code',
  models = '["kimi-k2.7-code"]'::jsonb,
  updated_at = now()
where id = 'kimi';

update model_gateway_providers
set
  type = 'openai',
  base_url = 'https://open.bigmodel.cn/api/coding/paas/v4',
  default_model = 'glm-5.2',
  models = '["glm-5.2","glm-4.5-air"]'::jsonb,
  updated_at = now()
where id = 'glm';
