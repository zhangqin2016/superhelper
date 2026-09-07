# IM Presence Redis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** 统一好友、Team、私聊的有权限在线状态，支持 Redis 跨实例共享与故障降级，不改变可靠消息语义。

**Architecture:** PostgreSQL 保持授权、消息和游标。Redis 是有时限的临时连接状态及通知层。客户端异步批量查询，展示只消费主进程安全投影。

**Tech Stack:** Fastify、PostgreSQL/Kysely、Node Redis 官方客户端、WebSocket、Electron、现有 CSS/i18n。

## Task 1 — Redis 服务端与查询契约

文件：新增 server/src/services/collaboration/presence-redis.js、presence-query.js；修改 online-presence.js、realtime-gateway.js、enterprise-directory.js、server/src/app.js、config.js、routes/public/collaboration.js、server/package*.json；测试 scripts/test-collaboration-presence-redis.mjs、test-collaboration-presence-query.mjs。

规格审查补充：新增仅加列的 `server/migrations/046_collaboration_presence_ticket_sessions.sql`，为一次性 WebSocket ticket 加可空 `session_id`。签名请求的真实 session ID 经 ticket 传递到连接租约；Redis 和内存查询均按该会话及其设备的当前有效性聚合。同设备另一个有效会话不能替已撤销连接作证。旧空值 ticket 保留传输兼容，但不用于在线断言。部署先运行迁移，禁止破坏性回填或修改消息/outbox。

- [x] 先补 RED：两个独立 tracker 共享 Redis；a/b 两连接同用户，关闭 a 仍 online；旧连接断开不影响新连接；75 秒租约过期；失联读取 unknown、恢复心跳恢复 online。
- [x] 实现有界 Redis 生命周期与原子连接租约更新/删除、批量快照。禁止将 Redis 故障当作 offline。消息 outbox 不变。
- [x] 先补 RED：签名 presence 查询最多200用户；好友/同Team允许，拉黑/移出/停用/无有效会话不允许；无权返回unknown，不回传设备信息。
- [x] 实现 presence-query 权限过滤与真实有效设备聚合，挂载 POST presence；企业目录消费同一服务，避免异步接口漏 await。
- [x] Redis 提示去重和断网补偿，限定事件名及大小；客户端断开清理仅自身连接。相关 presence 查询限流共享 Redis，故障以受限本机限流兜底保护数据库。
- [x] 运行新增测试和 test-enterprise-presence.mjs、test-enterprise-presence-websocket.mjs、test-collaboration-realtime.mjs。保存 RED/GREEN 证据；独立规格、质量审查通过后进入下一项。

Task 1 验证记录（2026-09-07）：新增单元、路由、真实 WebSocket、真实 Redis 双客户端、真实 PostgreSQL TEMP 授权/会话及迁移幂等测试通过。实际停止/恢复专用本地 Redis 容器通过；租约到期测试通过回拨测试分数加速，不冒充真实等待或物理双机。规格复审与独立质量审查均通过。主进程/renderer 开始修改前的一轮 Node IM/企业回归 132 项通过。

## Task 2 — 主进程与 UI

实现澄清：可分离 IM 窗口不能互相覆盖在线目标。IPC 使用真实 sender ID（不接受 renderer 伪造 source 字段）维护有上限的窗口声明，每窗口最多200目标；合并查询仍每个 HTTP 批次最多200，并与消息同步通道隔离。窗口隐藏/销毁仅释放自己的声明，账号切换清空全部旧声明。

文件：新增 src/main/collaboration/online-status.js、src/renderer/modules/collaboration-online-presence.js、collaboration-presence-view.js；修改 client.js、service.js、realtime-client.js、src/main.js、ipc-collaboration.js、preload.js、directory-view.js、collaboration-center.js、collaboration-friends.js、collaboration-teams.js、enterprise-roster.js、三语言和相关样式。

- [x] RED：状态查询不阻塞会话打开；异步旧账号/旧目录响应被拒绝；到期 online 转unknown；网络错误不保留绿点。
- [x] 主进程批量读取接口，内存缓存租约、合并提示与查询，不写持久联系人状态。只订阅当前需要的最多200目标，更多Team成员分页读取。
- [x] RED：真实Electron好友行/私聊标题/成员行一致，离线/未知文字，切换会话与locale不复活旧状态，不替换编辑节点。
- [x] 实现统一状态元素和独立更新生命周期，保留typing优先级、不增加面板。三语言语义为在线/离线/状态暂不可用。
- [x] 运行新测试及既有导航、目录、typing、IPC回归，独立规格及质量审查。

Task 2 验证记录：7个新增测试通过；主线程完整运行135个 Node IM/企业目录脚本零失败，独立运行实际 Electron native WebSocket、IM center、统一状态视图以及既有成员/社交导航/社交交互和3个远程任务UI回归。规格及最终质量复审通过；审查子进程无法启动Electron，相关真实执行证据由主线程提供，不合并为重复独立执行。

真实启动链补漏：原正式入口未传 WebSocket factory，仅有HTTP轮询。现在默认签名获取一次性 ws-ticket，按 `serviceClient.getServiceSettings().apiBaseUrl` 建立原生 WebSocket，支持异步工厂、15秒握手超时、旧票据/旧连接围栏、心跳及重连。`test-collaboration-online-presence-native.cjs` 用 Electron 原生构造器、本地签名HTTP票据和真实网关验证；心跳用加速测试时钟，不冒充30秒实际等待。它不代替部署后的双客户端验收。原生 WebSocket 不继承 Electron HTTP 的系统代理能力；受限网络失败时保留HTTP消息同步、状态未知，不改变全局代理或TLS。

UI验证补漏：状态变动复用成员按钮和编辑节点；在线筛选按50名候选分页，不因未知页面失去下一页入口；部分未知时标注“已确认在线”。窄屏截图走真实docked/overlay单层布局，独立窗口实际最小宽度760，不用不可能的420独立窗口替代验收。修复Team语言切换指纹遗漏。全局样式门禁通过，baseline未提高；13处等值令牌替换外，仅圆角12→10、标题19→18、任务覆盖层z12→既有raised20，远程任务界面回归通过。

## Task 3 — 部署与真实验收

文件：新增 deploy/baota/docker-compose.redis.yml、Redis运行说明及可选真实集成测试；更新 CAPABILITY-GATE.md 与本计划。

- [x] 验证真实Redis两实例，同连接/设备重连与进程退出、Redis中断恢复、跨实例提示。测试只使用随机命名空间，不清空共享数据库。
- [x] Redis部署配置：只loopback绑定、认证secret文件、健康检查、内存上限、无消息持久化依赖；API显式配置地址与命名空间，日志不得包含secret。
- [x] 验证配置语法、全量IM相关回归、真实Electron状态UI；失败则修复再测，不跳过关键门禁。
- [x] 部署新API和Redis，保持网站及历史数据，保留旧API和env回滚；国内海外健康及真实双客户端状态核对。记录实际版本与未执行项。

## 验证命令

发布状态（2026-09-07）：用户明确允许上传后，API、Redis及无密钥部署配置已上传七牛 `lanrensoft/app/server-images/presence-20260907/`，服务器下载后逐一核验SHA-256。生产 `101.200.232.184` 已运行 `lily-workbench-api:presence-20260907` 与 `lily-collaboration-redis:presence-20260907`，均 healthy。迁移046先于API切换执行成功。网站 `lily-workbench-web:91c992fd` 的容器ID保持不变。原功能开关、PostgreSQL、对象存储数据均未更改。

最终本地状态：Task1/Task2源码与独立审查完成，未提交或推送。客户端改动是本地源码，需完整重启源码版应用；没有构建或发布新的桌面安装包。专用本地 `lily-collaboration-redis` 测试容器已停止、未删除；不涉及其他Redis服务。

生产验收：管理员认证健康检查返回 `ok:true`、`imageTag:presence-20260907`、presence `{configured:true,ready:true,subscriberReady:true}`。Redis匿名PING被拒绝，健康检查认证成功，端口绑定127.0.0.1。国内/海外 `/health` 均返回 `{"ok":true}`。`presence-live-acceptance.mjs --allow-live-writes` 用两独立测试账号与真实公网WebSocket完成 cross_account_online / closed_peer_offline / peer_reconnect / revoked_session_offline，退出码0，并注销全部本次创建的session；未发送消息或修改好友/Team。

部署实录：首次匿名访问管理员健康接口收到401，触发旧API自动回滚；修正为容器内部使用现有管理员凭证后，重新部署并验收通过。首次本地协议验收遭WebSocket连接超时，清理会话后重跑通过；本地Node健康探测曾超时，curl两区域检查成功。这些失败没有隐藏或冒充通过。验收脚本补充真实30秒心跳、95秒收敛上限和握手超时，容纳新Redis epoch 75秒负面状态恢复窗口，不修改生产时钟或租约。

回滚：部署目录 `/www/wwwroot/lily-workbench/deploy/baota`，旧环境 `.env.before-presence-20260907`，旧API镜像 `lily-workbench-api:remote-task-20260907-0730` 均保留。恢复旧env后，通过环境变量指定旧 `COLLABORATION_API_IMAGE` / `COLLABORATION_API_TAG`，带 base + presence-api override，仅重建api；不删除兼容迁移046。部署证据目录 `/tmp/lily-presence-20260907.sRfczc` 是私有目录，日志和env不可公开。后续API部署必须保留override，不能让共享IMAGE_TAG重置API版本。

已上传并核验的工件：api-716e1496.tar.gz SHA256 `716e149667f9b063f6bde9fa14d9030c3a14620fab80cef7e46db966bd45214d`；redis-06b90cac.tar.gz SHA256 `06b90cac5fd807fadd4d0efec766a57959ac1932ce09a1afee034b4c568661e3`；deploy-ebbbd905.tar.gz SHA256 `ebbbd9050af23da8e9c0d5b77bb46f6e7f287a3167ab411c971a9f3da1446c67`。部署后本地REDIS.md增加认证验收说明，因此当前文档不再与已上传归档逐字一致，实际Compose和启动脚本未改动。

最终总回归：135个Node IM/企业脚本、30个Electron IM/企业脚本全部零失败；此外全局style-scale和3个远程任务Electron回归通过。首轮UI总回归发现timeline旧fixture混淆缓存预览、用户导航与后台刷新，仅修正fixture：缓存miss、显式后台刷新。原分页、查询游标、撤回正文、撤权清理断言完整保留；无产品源码改动，独立只读复审确认其与HEAD原产品契约一致，再次完整运行30个脚本通过。

截图验证使用受控数据的真实源码界面，不是生产数据或发布版Windows客户端：`/private/tmp/lily-presence-visual-final.zxPJc9`（明暗/窄屏/RTL），以及 `/private/tmp/lily-presence-screenshots`（好友/私聊）。实际Redis与PG证据、原生Electron协议证据和生产验收是不同层次，不能互相替代。生产验收为同一主机上两个独立协议客户端连接真实服务，不是两台物理设备，也未声称发布版Windows界面验收。Redis为单节点，不是高可用或Cluster集群。

构建依赖审计另外报告已有依赖链 9 项漏洞（6 high / 3 moderate），新增 Redis 包不在报告中。它们不等于已证明可利用，但不能宣称全服务安全审计通过；本次未进行无关的框架大版本升级。

`node scripts/test-enterprise-presence.mjs`

`node scripts/test-enterprise-presence-websocket.mjs`

`node scripts/test-collaboration-realtime.mjs`

新测试遵循同目录 Node/Electron 约定。生产网络测试显式 opt-in，不进入自动测试运行器；所有模拟结果与真实服务结果分别记录。
