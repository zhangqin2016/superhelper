# 宝塔 Docker 一键部署

这套部署把官网、管理后台和 API 放在同一个入口：

- `/` 官网和管理后台前端
- `/admin` 管理后台
- `/api/*` 服务端 API，桌面端也连这个地址

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

如果不想在服务器上 `git pull`，可以本地直接打包上传并部署：

```bash
cd /Users/zhangqin/aicode/ceshitermianl
chmod +x deploy/baota/push-to-server.sh
SSH_HOST=你的服务器IP \
SSH_USER=root \
SSH_PORT=22 \
REMOTE_DIR=/www/wwwroot/lily-workbench \
deploy/baota/push-to-server.sh
```

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
docker compose restart
docker compose down
```

不要随便删除 volume：

```text
lily_pg_data
```

它保存授权、设备、用量、版本和插件数据。
