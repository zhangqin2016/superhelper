# IM 临时在线状态 Redis

仅为连接租约、临时通知和相关限流服务，不存聊天正文，不替代 PostgreSQL。现有消息 outbox 和 LISTEN/NOTIFY 保留。Redis 单节点不可用时，在线状态显示未知，可靠消息仍走 PostgreSQL；本配置不是 Redis 高可用集群。

## 配置

`docker-compose.redis.yml` 是现有 host-network API 的独立 sidecar，宿主机仅开放 `127.0.0.1:16379`。禁止改成公网监听。生产在构建时固定官方镜像摘要，经七牛分发并校验 SHA-256 后加载；`COLLABORATION_REDIS_IMAGE` 指向该已验证的本地发布标签，避免服务器另行拉取漂移版本。不同环境用不同 Redis namespace。本实现使用单节点多 key 原子查询，不支持 Redis Cluster 分片模式。

在服务器私有目录创建 0600 密钥文件，内容是密码生成器产生的 64 位十六进制随机值；将路径配置为 `COLLABORATION_REDIS_PASSWORD_FILE`。不要将密钥文件或含密码 URL 放入版本控制。入口脚本生成 Redis 私有配置后降权启动，进程参数不含密码。

API 的 `COLLABORATION_REDIS_URL` 使用 `redis://:<password>@127.0.0.1:16379`，只存于已有受保护 `.env`。认证错误、连接错误日志不得输出 URL。不要在终端运行未脱敏的 `docker compose config` 或输出 `.env`。

启动：`docker compose --env-file .env -f docker-compose.redis.yml up -d`。检查容器健康；匿名 `redis-cli ping` 必须被拒绝，容器健康检查应成功。Redis 128 MiB 上限、noeviction，容量耗尽必须降级未知，不能驱逐租约伪装用户离线。无需数据卷及 AOF，重启靠有效连接重新续租。

## 升级与回滚

部署 API 前备份 `.env` 和当前镜像标记，先验证 Redis 认证与隔离。仅重建 API，不更新网站。回滚 API 时恢复原标记和配置；不要删除 PostgreSQL 或对象存储。Redis 可独立停止，普通消息服务必须继续健康。日志需关注 Redis 依赖降级和恢复，不能用 API liveness 代替该依赖状态。

API 单独发布使用 `docker-compose.presence-api.yml` 叠加在 `docker-compose.images-app-only.yml` 后，并仅执行 `up -d --no-deps api`。设置 `COLLABORATION_API_IMAGE` 与 `COLLABORATION_API_TAG` 为已经验证的发布值，保留原 `IMAGE_TAG`，避免网站被间接指向一个不存在的新镜像。后续 API 管理应继续带上此 override；回滚使用旧 API 镜像值。迁移046必须先执行成功，再切换 API（它是可回滚代码兼容的加列迁移）。

`/health` 只证明 API 存活。`/api/admin/health` 需要管理员认证；在容器内部读取现有 `ADMIN_TOKEN` 发起请求，不要把 token 放进命令行或日志。验收必须检查 `runtime.collaborationPresence` 的 `configured`、`ready`、`subscriberReady` 均为 true；匿名请求得到401不等于服务故障。新 Redis epoch 的负面状态有75秒恢复窗口，线上验收应维持30秒心跳并给状态收敛足够时间，不能为了测试缩短生产租约。

## 验收状态

部署配置测试检查端口和密钥边界；实际 Redis 集成、认证、重启恢复和生产部署必须另行运行并记录，文档存在不代表已经部署。

`scripts/presence-live-acceptance.mjs` 是显式 opt-in 的线上验收，不参与自动测试发现。凭证文件必须是0600、非符号链接，包含 HTTPS baseUrl 和两个专用测试账号；先用 `--credentials <private-file> --preflight` 验证输入，再经授权使用 `--allow-live-writes`。它仅登录测试设备、连接/重连 WebSocket、读取跨账号状态、撤销自己创建的 session；不发送聊天消息、不修改好友和 Team。最后清理全部新 session，任一清理失败必须非零退出。它验证真实服务协议，不代表两个物理设备或发布版客户端界面验收。
