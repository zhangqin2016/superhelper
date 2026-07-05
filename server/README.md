# Lily Workbench Server

Lightweight API for license activation, device registration, usage reporting,
release metadata, skill package metadata, and admin dashboards.

## Setup

```bash
cd server
npm install
cp .env.example .env
npm run migrate
npm run integration
npm run dev
```

Required:

```env
DATABASE_URL=postgres://user:pass@host:5432/lily_workbench
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-me
ADMIN_TOKEN=change-me
SESSION_SECRET=change-me-at-least-32-chars
PUBLIC_BASE_URL=https://www.lilywb.cn
```

For production license signing, set:

```env
LICENSE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
LICENSE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----..."
CONFIG_SIGNING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----..."
CONFIG_SIGNING_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----..."
ALLOW_UNSIGNED_LICENSES=false
```

`CONFIG_SIGNING_*` signs dynamic model/tool/policy configuration. If omitted,
the server temporarily falls back to the license signing key. Production should
separate these keys.

For feedback screenshots, set Qiniu upload credentials on the server only:

```env
QINIU_ACCESS_KEY=...
QINIU_SECRET_KEY=...
QINIU_BUCKET=lanrensoft
QINIU_PUBLIC_BASE_URL=https://qny.lanrensoft.cn
QINIU_UPLOAD_URL=https://upload.qiniup.com
```

The desktop client requests short-lived upload tokens from the server, uploads
images directly to Qiniu, and submits only attachment metadata with the feedback
record. Do not package Qiniu credentials into the desktop app.

## Model Gateway

The server supports two model delivery modes:

- Direct mode: config profiles send the vendor URL and model key to the client.
  This has the lowest latency, but the vendor key eventually exists on the
  user's machine.
- Gateway mode: config profiles send a Lily `/llm/:provider` URL. The server
  injects a short-lived device gateway token into the signed client config, and
  the real provider key stays on the server.

Provider keys are configured with environment variables, not sent through
`/api/client/config`:

```env
MODEL_GATEWAY_ENABLED=true
MODEL_CONFIG_DELIVERY_MODE=direct # direct | gateway
MODEL_GATEWAY_TOKEN_SECRET=change-me-at-least-32-chars
MODEL_GATEWAY_TOKEN_TTL_SECONDS=21600
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
DASHSCOPE_API_KEY=sk-... # media skills only: image/video/speech
DASHSCOPE_CHAT_API_KEY=sk-... # optional: enable DashScope/Qwen as a chat gateway
KIMI_API_KEY=sk-...
GLM_API_KEY=sk-...
LITELLM_BASE_URL=http://litellm:4000
LITELLM_API_KEY=sk-litellm...
LOCAL_ANTHROPIC_BASE_URL=https://models.example.com/anthropic
LOCAL_ANTHROPIC_API_KEY=sk-local...
```

When provider environment variables are present, the API server creates or
updates a global `lily-default-runtime` config profile during startup.
`MODEL_CONFIG_DELIVERY_MODE=gateway` is the default and recommended mode: model
provider secrets stay on the server and clients receive Lily gateway URLs plus
short-lived gateway tokens. `MODEL_CONFIG_DELIVERY_MODE=direct` is an explicit
operator opt-in for private deployments that accept delivering long-lived model
provider keys to clients. DashScope media skill defaults are also included so the
desktop app can enable built-in image, video, and speech generation without
manual client setup:

```env
DASHSCOPE_MODEL=qwen3-coder-plus # used only when DASHSCOPE_CHAT_API_KEY is set
DASHSCOPE_IMAGE_MODEL=qwen-image-2.0-pro
DASHSCOPE_VIDEO_MODEL=wan2.7-t2v
DASHSCOPE_TTS_MODEL=cosyvoice-v3-flash
DASHSCOPE_TTS_VOICE=longanyang
DASHSCOPE_IMAGE_ENDPOINT=
DASHSCOPE_VIDEO_ENDPOINT=
DASHSCOPE_TTS_ENDPOINT=
```

`DASHSCOPE_BASE_URL` is reserved for the Anthropic-compatible model gateway.
Use the media-specific endpoint variables only when a media API needs a custom
base URL.

For custom providers, use JSON:

```env
MODEL_GATEWAY_PROVIDERS='{
  "anthropic": {"type":"anthropic","baseUrl":"https://api.anthropic.com","apiKey":"sk-ant-..."},
  "deepseek": {"type":"anthropic","baseUrl":"https://api.deepseek.com/anthropic","apiKey":"sk-..."},
  "dashscope": {"type":"anthropic","baseUrl":"https://dashscope.aliyuncs.com/apps/anthropic","apiKey":"sk-..."},
  "kimi": {"type":"anthropic","baseUrl":"https://api.moonshot.ai/anthropic","apiKey":"sk-..."},
  "glm": {"type":"anthropic","baseUrl":"https://api.z.ai/api/anthropic","apiKey":"sk-..."},
  "local-qwen": {"type":"anthropic","baseUrl":"https://models.example.com/anthropic","apiKey":"sk-..."},
  "litellm": {"type":"anthropic","baseUrl":"http://litellm:4000","apiKey":"sk-litellm...","models":["local-qwen","local-qwen-fast","local-qwen-strong"]},
  "openai": {"type":"openai","baseUrl":"https://api.openai.com/v1","apiKey":"sk-..."}
}'
```

Config profile example for gateway mode:

```json
{
  "models": {
    "activePresetId": "deepseek-gateway",
    "presets": [{
      "id": "deepseek-gateway",
      "label": "DeepSeek Gateway",
      "env": {
        "LILY_API_BASE_URL": "/llm/deepseek/v1",
        "LILY_API_KEY": "$LILY_GATEWAY_TOKEN",
        "LILY_GATEWAY_PROVIDER": "deepseek",
        "LILY_OPENCODE_PROTOCOL": "openai",
        "LILY_MODEL": "deepseek-v4-pro",
        "LILY_MODEL_HAIKU": "deepseek-v4-pro",
        "LILY_MODEL_SONNET": "deepseek-v4-pro",
        "LILY_MODEL_OPUS": "deepseek-v4-pro",
        "LILY_SUBAGENT_MODEL": "deepseek-v4-pro"
      }
    }]
  }
}
```

The current `/llm` gateway path is OpenAI-first. Configure model providers that
expose OpenAI-compatible APIs as `type: "openai"` and use `/llm/:provider/v1`
from the client; the runtime will call `/chat/completions`. Anthropic-compatible
`/messages` remains only as a compatibility path for older clients/providers.

Gateway endpoints:

```text
POST /llm/:provider/v1/messages
POST /llm/:provider/v1/messages/count_tokens
POST /llm/:provider/v1/chat/completions
GET  /llm/:provider/v1/models
```

For self-hosted models, prefer this production chain:

```text
vLLM / SGLang / Ollama / llama.cpp
  -> Lily /llm/<provider>/v1 OpenAI-compatible provider
  -> desktop runtime
```

## API

Public:

```text
POST /api/devices/register
POST /api/licenses/activate
POST /api/licenses/verify
POST /api/client/config
POST /api/usage/report
POST /api/skills/events
GET  /api/releases/latest
GET  /api/releases
GET  /api/skills/registry
POST /llm/:provider/v1/messages
POST /llm/:provider/v1/messages/count_tokens
GET  /llm/:provider/v1/models
```

`/api/skills/registry` emits the desktop client's skill package registry format.
Only enabled skill package entries with both package URL and SHA256 are installable.
`/api/skills/events` records install, update, uninstall, enable, and disable
actions so operations can be monitored without exposing chat content or model
API keys.

Admin:

```text
POST /api/admin/login
GET  /api/admin/summary
GET  /api/admin/licenses
GET  /api/admin/licenses/:id
POST /api/admin/licenses
PATCH /api/admin/licenses/:id
GET  /api/admin/devices
GET  /api/admin/usage
GET  /api/admin/releases
POST /api/admin/releases
GET  /api/admin/skill-packages
POST /api/admin/skill-packages
PATCH /api/admin/skill-packages/:id
GET  /api/admin/config-profiles
POST /api/admin/config-profiles
PATCH /api/admin/config-profiles/:id
GET  /api/admin/audit-logs
```

Integration verification:

```bash
DATABASE_URL=postgres://user:pass@host:5432/lily_workbench \
ADMIN_TOKEN=change-me \
ALLOW_UNSIGNED_LICENSES=true \
npm run integration
```

## Desktop client connection

The desktop app no longer lets end users configure the service URL in the UI.
Set `LILY_SERVICE_API_BASE_URL` at build/runtime, or ship a non-empty built-in
service URL in `src/main/service-client.js`.

After the service URL is configured:

- Activation uses `POST /api/licenses/activate`.
- Update checks prefer `GET /api/releases/latest`.
- The skill market uses `GET /api/skills/registry`.
- Skill operations report to `POST /api/skills/events`.
- Usage reports use `POST /api/usage/report`.
- Startup registers the device with `POST /api/devices/register`.
- Startup also pulls signed dynamic config from `POST /api/client/config`.
- Device-state APIs require request signing after registration:
  `POST /api/client/config`, `POST /api/licenses/verify`,
  `POST /api/usage/report`, `POST /api/usage/summary`,
  `POST /api/skills/events`, `POST /api/diagnostics/runtime-traces`, and
  `POST /api/devices/rotate-key`.
  The device public key is registered during device registration or license
  activation; every protected request must include timestamp, nonce, body hash,
  and signature headers. Reused nonces are rejected.
- Device key rotation uses the old private key to sign the rotation request.
  If the old private key is lost, the device must bootstrap again through
  license activation.
- Public website/update APIs stay public: contact submission, release metadata,
  and skill registry reads do not require device signing.

Dynamic config profiles resolve in this order:

```text
global profile
< license profile
< device profile
```

Each profile has `rolloutPercent` from 0 to 100. The server uses a stable
device/profile hash bucket, so the same device consistently receives or skips a
partial rollout until the percentage changes.

Every config profile save creates a revision snapshot. The admin console can
restore the previous revision if a rollout or model setting is wrong.

The desktop client verifies the server signature before applying model presets
or skill registry overrides. If the remote config is missing or invalid, it
falls back to packaged defaults.

If the service URL is empty, the client keeps using the static Qiniu update
manifest, offline signed activation codes, and the bundled skill catalog. This
is only a fallback; production builds should include a real service URL.

## Deployment

Minimal PM2 deployment:

```bash
cd server
npm ci --omit=dev
npm run migrate
pm2 start src/index.js --name lily-workbench-api
```

Minimal Docker image:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "src/index.js"]
```

Put Nginx/Caddy in front for HTTPS. Keep installer files and skill packages on
Qiniu; the API stores only metadata and hashes.
