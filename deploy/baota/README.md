# 宝塔 Docker 一键部署

这套部署把官网、管理后台和 API 放在同一个入口：

- `/` 官网和管理后台前端
- `/admin` 管理后台
- `/api/*` 服务端 API，桌面端也连这个地址
- `/llm/*` 模型网关，桌面端通过这里拿短期 token 访问模型

## 服务器准备

宝塔面板安装：

- Docker 管理器
- Nginx 网站

服务器目录建议：

```bash
/www/wwwroot/lily-workbench
```

把代码上传或 `git clone` 到这个目录后执行：

```bash
cd /www/wwwroot/lily-workbench/deploy/baota
chmod +x deploy.sh
./deploy.sh
```

脚本会自动生成 `.env`，默认构建并启动：

- `lily-db`
- `lily-api`
- `lily-web`
- `lily-gateway`

默认只暴露本机端口：

```text
18080 -> lily-gateway:80
```

## 使用服务器已有 Gateway / 宝塔 Nginx

如果服务器已经安装了 gateway 或宝塔 Nginx，不需要启动 `lily-gateway` 容器。编辑 `.env`：

```env
DB_MODE=external
GATEWAY_MODE=external
DATABASE_URL=postgres://用户名:密码@PG地址:5432/lily_workbench
API_PORT=13000
WEB_PORT=13001
PUBLIC_API_BASE_URL=https://你的域名
```

执行：

```bash
./deploy.sh
```

这时只会启动：

```text
lily-api  -> 127.0.0.1:13000
lily-web  -> 127.0.0.1:13001
```

不会启动：

```text
lily-db
lily-gateway
```

你现有网关这样反代：

```nginx
location /api/ {
  proxy_pass http://127.0.0.1:13000;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /llm/ {
  proxy_pass http://127.0.0.1:13000;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /health {
  proxy_pass http://127.0.0.1:13000/health;
}

location / {
  proxy_pass http://127.0.0.1:13001;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 宝塔网站反向代理

在宝塔里创建站点，例如：

```text
lily.yourdomain.com
```

反向代理到：

```text
http://127.0.0.1:18080
```

然后给这个站点申请 SSL。外部访问：

```text
https://lily.yourdomain.com
https://lily.yourdomain.com/admin
https://lily.yourdomain.com/api/health
```

桌面端服务地址填：

```text
https://lily.yourdomain.com
```

## 模型网关和 LiteLLM

默认部署只启动 Lily 自己的控制面和 `/llm` 网关。DeepSeek、阿里
DashScope、Kimi/Moonshot、Z.AI/GLM 这类已经提供
Anthropic-compatible endpoint 的平台，直接在 `.env` 配置对应 key：

```env
MODEL_GATEWAY_ENABLED=true
MODEL_GATEWAY_DEFAULT_PROVIDER=deepseek
DEFAULT_MODEL_PROVIDERS=deepseek # 普通用户默认只看到 DeepSeek；需要全量可选时显式设为 all
MODEL_CONFIG_DELIVERY_MODE=gateway # gateway: 服务端托管 key；direct: 客户端直连，延迟低但会下发模型 key
ACCOUNT_USAGE_ENFORCEMENT=true # 默认强制账户扣费；仅内测/自用环境可显式设为 false
DEEPSEEK_API_KEY=sk-...
DASHSCOPE_API_KEY=sk-... # media skills only: image/video/speech
DASHSCOPE_CHAT_API_KEY=sk-... # optional: enable DashScope/Qwen as a chat gateway
KIMI_API_KEY=sk-...
GLM_API_KEY=sk-...

# 可选：阿里百炼媒体技能默认模型。留空 endpoint 时使用技能内置官方入口。
DASHSCOPE_MODEL=qwen3-coder-plus # 仅在配置 DASHSCOPE_CHAT_API_KEY 时作为聊天模型使用
DASHSCOPE_IMAGE_MODEL=qwen-image-2.0-pro
DASHSCOPE_VIDEO_MODEL=wan2.7-t2v
DASHSCOPE_TTS_MODEL=cosyvoice-v3-flash
DASHSCOPE_TTS_VOICE=longanyang
DASHSCOPE_IMAGE_ENDPOINT=
DASHSCOPE_VIDEO_ENDPOINT=
DASHSCOPE_TTS_ENDPOINT=
```

服务启动时会根据这些环境变量自动维护一个全局配置下发 profile：

- 模型类供应商通过 Lily `/llm/:provider` 网关下发，客户端拿短期 token，真实模型 key 留在服务端。
- 图片生成、视频生成、语音合成等本地技能会拿到百炼运行环境配置，用户无需手动配置。
- 后台仍可新增更高优先级的授权级或设备级 profile，覆盖默认值。

如果要接自建模型，建议先让自建模型暴露 OpenAI-compatible endpoint，
再启用 LiteLLM 把它适配成 Anthropic-compatible endpoint：

```env
LITELLM_ENABLED=true
LITELLM_MASTER_KEY=换成强随机密钥
LITELLM_API_KEY=同上
LITELLM_BASE_URL=http://litellm:4000
LOCAL_OPENAI_BASE_URL=http://你的模型服务:8000/v1
LOCAL_OPENAI_API_KEY=你的模型服务key
LOCAL_QWEN_MODEL=openai/你的模型ID
LOCAL_QWEN_FAST_MODEL=openai/你的快速模型ID
LOCAL_QWEN_STRONG_MODEL=openai/你的强模型ID
```

执行：

```bash
./deploy.sh
```

脚本会自动追加 `docker-compose.litellm.yml`，启动：

```text
lily-litellm -> 4000
```

然后在管理后台的配置下发里选择 `LiteLLM Gateway` 预设。

如果客户自建的服务已经原生支持 Anthropic-compatible `/v1/messages`，
不需要 LiteLLM，直接配置：

```env
LOCAL_ANTHROPIC_BASE_URL=https://models.example.com/anthropic
LOCAL_ANTHROPIC_API_KEY=server-side-secret
LOCAL_ANTHROPIC_MODEL=local-qwen
```

然后在管理后台选择 `Local Anthropic Gateway` 预设。

## 使用宝塔已有 Postgres

如果宝塔里已经有 PG，不需要启动 `lily-db`。编辑：

```bash
cd /www/wwwroot/lily-workbench/deploy/baota
vim .env
```

改成：

```env
DB_MODE=external
DATABASE_URL=postgres://用户名:密码@PG地址:5432/lily_workbench
```

然后执行：

```bash
./deploy.sh
```

这时只会启动：

```text
lily-api
lily-web
lily-gateway
```

不会启动 `lily-db`。

注意：Docker 容器里的 `127.0.0.1` 是容器自己，不是宝塔宿主机。`DATABASE_URL` 里的 PG 地址要用容器能访问到的地址：

- PG 是宝塔宿主机服务：优先用服务器内网 IP
- PG 是另一个 Docker 容器：用对应 Docker 网络里的服务名或容器 IP
- PG 只监听 `127.0.0.1`：需要在宝塔/PG 配置里允许 Docker 网段访问

## 管理后台登录

查看生成的 token：

```bash
cd /www/wwwroot/lily-workbench/deploy/baota
grep '^ADMIN_TOKEN=' .env
```

打开：

```text
https://lily.yourdomain.com/admin/login
```

输入 `ADMIN_TOKEN`。

## 更新部署

```bash
cd /www/wwwroot/lily-workbench
git pull
cd deploy/baota
./deploy.sh
```

## 从本地一键打包推送到服务器

如果不想在服务器上 `git pull`，标准流程是本地打包、上传七牛云，服务器再从七牛云下载并部署。这样避免大包直接走 SSH/SCP，网络断开时也更容易重试。

```bash
cd /Users/zhangqin/aicode/ceshitermianl
chmod +x deploy/baota/push-via-qiniu.sh
SSH_HOST=你的服务器IP \
SSH_USER=root \
SSH_PORT=22 \
REMOTE_DIR=/www/wwwroot/lily-workbench \
deploy/baota/push-via-qiniu.sh
```

`push-to-server.sh` 只保留为兼容入口，实际也会转到 `push-via-qiniu.sh`。

第一次部署前，服务器上的 `.env` 仍然要配置好：

```bash
ssh root@你的服务器IP
cd /www/wwwroot/lily-workbench/deploy/baota
cp .env.example .env
vim .env
```

如果你使用宝塔已有 PG 和已有 gateway，关键配置是：

```env
DB_MODE=external
GATEWAY_MODE=external
DATABASE_URL=postgres://用户名:密码@PG地址:5432/lily_workbench
API_PORT=13000
WEB_PORT=13001
PUBLIC_API_BASE_URL=https://你的域名
```

## 常用命令

```bash
cd deploy/baota
docker compose ps
docker compose logs -f api
docker compose logs -f web
docker compose logs -f gateway
docker compose logs -f litellm
docker compose restart
docker compose down
```

不要随便删除 volume：

```text
lily_pg_data
```

它保存授权、设备、用量、版本和插件数据。
