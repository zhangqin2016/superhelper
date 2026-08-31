# Collaboration Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有 AI 工作台默认能力的前提下，交付支持好友、个人群、企业 Team、可靠消息、加密附件和工作空间交接的独立协作中心，并用自动化故障注入证明消息不会因超时、重试、重连或乱序通知而静默丢失、重复或错序。

**Architecture:** 保持现有 Electron + Fastify + PostgreSQL + 七牛对象存储技术栈。服务端采用模块化单体：HTTPS 写命令，PostgreSQL 事务同时提交领域事件、消息投影、用户同步游标、幂等回执和实时 outbox；WebSocket 只做低延迟提示，durable sync 才是交付依据。桌面端使用独立 `collaboration.db` 和持久 outbox，Renderer 只接收裁剪后的 view model。附件和 `.lilyspace.zip` 在客户端使用 `LILYENC1` 加密后直传独立私有 bucket。

**Tech Stack:** Electron 41、Node.js CommonJS/ESM、Fastify 5、PostgreSQL、Kysely、`pg`、`ws`、Node `crypto`、Node `node:sqlite`、七牛 Kodo、原生 Renderer HTML/CSS/JavaScript、现有 `scripts/test-*.mjs/.cjs` 测试框架。

---

## 执行约束

- 规范源是 `docs/superpowers/specs/2026-08-29-collaboration-center-design.md`；本计划只拆解实现顺序，不降低其中的权限、安全、可靠性和交互要求。
- 每个任务严格执行 red → green → refactor：先新增或扩展测试并确认它因缺少目标行为而失败，再写最小实现，再运行该任务列出的验证。
- 每个持久写命令都必须经过同一幂等命令内核；不得在单个路由里手写一套“近似幂等”。
- 所有消息最终顺序只看服务端 `conversation_seq`。客户端时间只用于乐观展示，不参与权威排序。
- `collaboration.db` 与现有 `messages.db` 分离；协作服务损坏或关闭时，AI 会话路径、模型、工具、上下文和文件处理保持基线行为。
- 对象存储只保存密文；协作 bucket 使用独立 `COLLAB_QINIU_*` 配置，不复用公开发行物 bucket。
- 不实现多人实时共同编辑工作空间。工作空间协作是“本地打包 → 加密上传 → 消息交接 → 接收方新目录导入”。
- 所有 IPC 输入、API body、对象元数据、文件名和路径都视为不可信；密钥、token、正文、签名 URL 和完整本地路径不得进入日志。
- 每个任务完成后运行 `git diff --check`；只有列出的测试通过才提交。任何跳过项必须记录，不能声称完成。

## 里程碑与硬出口

### 2026-08-31 执行核对（不是完成声明）

工作目录：`/Users/zhangqin/.config/superpowers/worktrees/ceshitermianl/collaboration-center`；分支：`codex/collaboration-center`。原 Task 1–22 的范围和最终完成定义不变；已有提交不能替代验收证据。

| 顺序 | 交付范围 | 当前事实 / 出口 |
|---|---|---|
| A | Task 1–12 基础链路复核 | 有实现和专项测试，但真实 HTTP→SQLite→IPC 联调发现缺陷；以下修复进行中，不把基础切片整体标为完成 |
| B | Task 13 好友和消息交互 | 好友操作、持久社交命令、持久编辑/撤回和持久已读/精确计数已独立双审；引用/@、完整消息操作UI与可见已读仍待接通并验证 |
| C | Task 14 群/Team/频道 | 领域权限、签名命令/发现、PG撤权竞态、本地缓存清理、目录及操作UI已独立双审；既有企业管理入口撤权也已双审提交f50ceca，尚未做生产迁移与企业管理实机点击验收 |
| D | Task 15–17 加密对象传输 | 等待交接、Team传输退休和同文本独立草稿保护已双审提交81e8adc，原有容器/对象/调度/Renderer链路保留；真实bucket尚未验收 |
| E | Task 18–19 工作空间交接和 AI | Task18A 本地严格归档预检/隔离导入已独立双审；仍待发送导出适配、加密分享元数据/接收卡、确定性AI工具和发送确认 |
| F | Task 20–22 运营与发布 | 仍待轮换/清理/故障和容量实测、真实双客户端、能力门禁；尚未合并或部署 |

本轮复核新增必须关闭的回归项：

- [x] HTTP history 的 `result` 数组经真实 client/service/store 保留正文，不能按不存在的 `.messages` 字段变成空数组。验证：`node scripts/test-collaboration-history-roundtrip.mjs`。
- [x] 编辑 revision、引用和撤回信息保留到加密缓存与 IPC；旧响应不得复活已撤回正文。验证：同上。
- [x] 全量 bootstrap 重复本人 profile 不触发唯一键失败；待发送、失败、暂停和确认中的本地消息保留。验证：`node scripts/test-collaboration-recovery-integrity.mjs`。
- [x] 其他用户的同名 command ID 不结算本人 outbox；本地相同 command ID 的正文/会话变更必须冲突。验证：同上。
- [x] 无 HTTP 响应/504 不标成永久失败；401 强制刷新一次 token，普通账号访问缓存行为不变。验证：`node scripts/test-collaboration-transport-errors.mjs`、`node scripts/test-account-resilience.mjs`。
- [x] 持久插入顺序约束同会话 outbox；暂停/未知送达阻挡后继；同步周期主动查询持久 receipt，不依赖用户点击取消。验证：`node scripts/test-collaboration-queue-barrier.mjs`。
- [x] Composer 输入法 Enter、重复 Enter、跨会话迟到响应和同一草稿 IPC 重试身份验证。验证：`node scripts/test-collaboration-composer-behavior.mjs`。
- [x] 草稿加密持久化、进程重启恢复、账号隔离；旧提交不得清空新输入。验证：`node scripts/test-collaboration-drafts.mjs`。
- [x] 账号切换后旧 refresh 的成功和401均不能覆盖/清除新账号，真实client不得携带旧token；独立复审通过（9f094ae）。验证：`node scripts/test-account-resilience.mjs`。
- [x] 取消消息在SQL LIMIT之前排除，真实v4/v5→v6迁移及重复重启保留旧paused命令ID和状态；独立复审通过（d369593）。验证：`node scripts/test-collaboration-recovery-integrity.mjs`。
- [x] 真实Electron验证稳定消息/正文DOM、纯文本、防撤回复活、页面偏移下滚动锚点、底部跟随；独立规格/质量审查通过。验证：Electron运行 `scripts/test-collaboration-timeline.cjs`。这不替代其余交互或双客户端E2E。
- [x] 好友接受事件原子投影direct（6b3f5c6）；按server seq分页、跨200条刷新补缺口、200 pending不挤掉离线历史（2cefb8f），均完成独立双审。
- [x] receipt真实签名HTTP路由校验当前登录session/设备/actor/会话（5f00076）；sync/bootstrap/open/stop统一lane与shutdown fence（b4e8cc6），生命周期后续扩充至25项。
- [x] 未知送达同键有界恢复、部分/畸形receipt、ACK与完整receipt正证据、投影失败、取消与多次重启故障注入（70863ee）。71项恢复测试和25项生命周期测试通过；不得把无receipt的崩溃命令直接重发。
- [x] 旧于最新200条的edit/revoke持久化目标、201目标分批、崩溃恢复、显式不可见证明、bootstrap待水合检查点（0f489aa）。16项回归及真实PG签名HTTP/并发撤权测试通过；授权与history读取保持同一事务。
- [x] 已加载旧窗口按200条分批更新新revision/墓碑并移除失效缓存，账号/导航代际隔离（5f21c8a），规格/质量审查、目标Node与真实Electron通过。
- [x] scope整体撤权后checkpoint/key/cache清理、key删除失败重启重试、Renderer清空撤权正文（19de5f3）；真实PG事件经sync到SQLite验证。既有企业管理路由触发仍未接入，不能据此标记Task14整体完成。
- [x] 会话创建/成员事件先持久化metadata发现任务，经当前授权get再history后ACK；v9未知历史待恢复记录迁移回填，避免未入库就确认（2f18cf8）。10项回归、真实PG签名HTTP→桌面链路及两轮独立审查通过。
- [x] 私有对象独立配置、HTTP签名、敏感日志保护、实际消息事务绑定、双对象回滚、提交后ACK丢失同键恢复（68bb365）。真实PG锁超时映射503可重试，legacy对象接口畸形JSON也不泄露凭证；存储提供方为替身，不是真实桶验收。
- [ ] Renderer 实际 DOM、滚动锚定、所有动作和双窗口验证；现有源文件正则测试仅证明静态结构，不证明交互闭环。

执行方式：逐项测试先行、实现、回归、独立审查。每项保留实际命令与失败/通过记录；不再用“稍后补测试”关闭任务。最终合并依赖全部出口，不因任务序号或新增文件数量推算完成百分比。

最新检查点（9f6a6da）：两份仅扫描源码的 `.cjs` 测试被自动发现器交给 Electron 后不退出，实际重现180秒超时；已保留全部断言改名为 `test-collaboration-message-surface.mjs` / `test-collaboration-shell-surface.mjs`，不再将它们称为交互E2E。协作CSS未定义token及硬编码暗色fallback已改用现有深浅主题变量，四项目标测试通过并完成双审。附件等待和Team退休冻结版本下，父进程Node协作262项通过、0跳过；完整能力门禁退出0（162项，原Office/PDF运行时跳过及Renderer缺省IPC日志仍存在）。随后同caption的独立composer草稿问题已通过真实SQLite红灯复现并修复，专项重新通过，正在独立复审；不沿用旧门禁宣称这项修复已经过全部测试。

全项目自动发现测试仍未通过：除已修复的协作主题/静态测试类型及便携CLI夹具问题外，独立复跑确认六项依赖缺失或未隔离的基线失败：`test-ensure-session-runner-resume-reset.mjs` 缺CLI；`test-large-document-skill-routing.mjs` 无bundled runtime时强求环境指南；`test-runtime-health.mjs` 和 `test-runtime-pack-installer.mjs` 缺Python；`test-stock-workspace-app-package.mjs` 缺其默认应用源码；`test-web-system-playwright-runtime-loader.mjs` 缺本地Playwright。相关测试和直接实现相对e4501f2未变。不降低生产健康检查、不删除断言、不把它们算作通过；发布前仍需准备环境或隔离测试夹具并重跑。工作空间交接、AI确认工具、完整消息交互、后台运维和真实桶/双客户端仍未完成，尚未合并或部署。

后续验证（81e8adc / e2c22fa）：同文本独立草稿保护已完成规格/质量复审；父进程15项附件/退休/IPC/Store/Outbox测试及真实PG signedHTTP双附件发送-丢ACK-重启-接收保存链路退出0。第二次完整自动发现回归为732/738，失败精确为上一段六项，无协作测试超时或主题回归。其后两处测试夹具隔离修复e2c22fa保留所有原断言、增加无runtime不虚假宣称环境的反向断言，双审及目标测试通过；复用主工作区既有 `LILY_RUNTIME_ROOT` 后，runtime-health、runtime-pack-installer两项也实际通过（未改健康检查）。本地Playwright模块和股票应用默认源码仍缺，不能用四项目标通过改写上次全套732/738结果。新工作空间严格导入切片仍在实现，未纳入这次全套。

继续验证（847fb8f）：真实 client 的已读 HTTP 响应为 `{ok:true,result:{lastReadSeq}}`；已修复请求99/服务端确认5却误报99的问题，仅接受服务端非负安全整数，畸形响应不发布已读确认。新回归、25项生命周期与独立双审通过并提交；这不代表已读操作已经持久恢复。使用主工作区现有真实 Python runtime 运行原注册完整能力门禁退出0（162项）；真实 PostgreSQL signed receipt 与 message integration 重新通过。随后新增已读/严格工作空间导入到门禁注册，注册校验通过，但新的完整164项门禁尚待运行。工作空间严格导入仍在独立审查；下一优先项为既有 outbox 的 typed edit/revoke 恢复，不能把服务端幂等实现等同于桌面端操作已持久化。主分支合并、真实私有bucket及双客户端验收仍未执行。

Task18A 本地切片审查闭环：复用普通导入选择/路径规则，增加原始central/local名称一致性、ZIP64/分卷拒绝、真实流式展开限额/CRC/SHA-256、最终目标NFC/大小写冲突防护、包含技能的实际落地文件数、独占新目录/隔离stage/身份复验与失败清理。`plumless`/`buckeroo` 等长CRC碰撞、hidden/legacy `SKILL.md`/`skill.md`覆盖、伪造解压大小、目标被写入/替换symlink均有持久回归。规格与质量独立审查批准；父进程重新跑strict/share/inspector/skill-import/automation-sharing/character-portability/architecture/registry通过。164项注册门禁退出0（其strict测试执行早于最后的最终路径别名修复，该修复随后单独重跑通过）；新全量自动发现回归正在冻结版本上运行，不用尚未结束的结果声明全部通过。Windows仅分支模拟，未实机验证；没有接通分享网络/UI，也没有注册或运行导入能力。

冻结版本全量结果（e51340e）：显式给自动发现器及其子进程配置 Node24 和既有 `LILY_RUNTIME_ROOT`，完整运行318秒，738/740通过，退出1。仅失败 `test-stock-workspace-app-package.mjs`（默认股票应用源码缺失）与 `test-web-system-playwright-runtime-loader.mjs`（未安装可发现的Playwright Node模块）；未跳过或改弱它们以制造全绿。此前一次只为父进程指定Node24、子进程仍用系统Node16的错误环境运行已终止，不计作有效全套结果。冻结解除后开始Task13 typed edit/revoke持久恢复；上述738/740只对应e51340e，不代表后续未实现改动。

2026-08-31 验证检查点：早期Node24下35个 `test-collaboration-*.mjs` 全部通过（含1GiB加密测试），当时沙箱外完整 `npm run test:capability-gate` 退出码0；后续曾回归40个协作脚本通过。最新上述提交按专项测试、独立双审与真实Electron验证，不沿用旧检查点声称所有新改动已过全套。已在独立本地PostgreSQL随机schema验证friend/message/realtime/sync，以及signed receipt/history的撤权竞争；仍没有私有bucket和真实双客户端验收，尚未合并或部署。

后续检查点（5f21c8a）：加入协作可靠性gate后，沙箱外Node24执行完整 `npm run test:capability-gate` 退出码0（包含本轮历史、恢复和显示测试及原工作台门禁）。Renderer测试宿主仍打印缺省未注册IPC/故障注入的错误日志，runner整体通过；不能把该结果当作真实双客户端或生产发布验收。此后Task14等改动需重新运行门禁。

后续检查点（68bb365）：Node24遍历52个 `test-collaboration-*.mjs` 退出码0；对象SQLSTATE修复后额外重跑对象route和真实PG signedHTTP通过。完整 `npm run test:capability-gate` 沙箱外退出码0（153项，26个gate）；Renderer宿主仍有缺省未注册IPC日志。以上不包含随后正在开发的目录投影、传输manifest及完整续传，不替代所有项目测试/实际私有桶/双客户端/发布验收。尚未合并或部署。

后续检查点（43ae4d9 / f0dec2c）：好友/Team目录已完成SQLite v11、bootstrap/incremental、撤权清理和只读IPC，规格与质量复审通过。修复legacy明确空好友列表不清旧好友，以及v1缺少Team成员数组仍提交游标的问题。私有multipart v2适配器完成6组测试及双审：精确bucket/key、4MiB分块、MD5、响应上限、分页和错误分类；成功响应头后断流仍属未知结果。两项已提交功能分支；不代表UI或完整传输管理器完成。

权限检查点（2026-08-31）：先前自动权限审查要求用户明确授权社交命令本地加密持久化与既有签名协作后端提交。用户随后明确同意，补丁重试获准，阻塞已解除。社交journal、好友/Team界面和实际Electron测试已实现并冻结进入独立规格审查；尚未完成双审，不标记整体完成。

同轮对象恢复检查：新增签名 `objects/:id/status` 供原complete命令恢复使用，不代替complete、不自动绑定消息。实际PostgreSQL测试覆盖owner权限、404缺失证明、提供方503、错误密文、verified不再签发上传票据与撤销后拒绝；4项单测额外验证探测耗时后的有效期及verified孤儿过期。Qiniu仍为测试替身；完整transfer-manager、上传/下载续传和用户入口尚未接入。

后续传输检查点（f6ed4e5）：传输核心完成规格/质量双审并提交，20项传输故障测试与11项manifest测试通过。覆盖init、分块、提供方complete、服务端complete回执丢失后原身份恢复，下载授权过期和断流续传，校验/解密、停止/取消/撤权及磁盘读取期间的迟到回调。另有未提交的真实桌面client→签名HTTP→PostgreSQL→两账号加解密联调，经独立双审通过；Qiniu仍为替身。后台恢复调度、主进程装配、附件用户入口与工作空间交接尚待完成，不能据此声称全模块完成。

后续检查点（194a543 / 176563b / e838192）：上传恢复已绑定原设备；好友/Team完整交互、加密社交命令与真实对象client联调已双审提交。父进程重新运行实际Electron social-ui及social-navigation均退出0，真实PG对象链路退出0（Qiniu替身）。后台传输调度通过43项专项测试及双审，最多3次持久化退避、并发2、显式上传授权，暂停和禁用调度同次CAS，EIO/崩溃不能误恢复。同期完整能力门禁退出0（153项），Office/PDF因缺bundled runtime跳过、旧Renderer宿主缺省IPC日志仍存在；不将其算作未跳过的全项目验收。后续新增runtime及企业管理接入需重新验证。附件历史补齐缓存/离线IPC/reopen DB，非法ID整页回滚，撤回与同revision防复活也已双审提交。尚未完成全部模块、真实桶、双客户端发布验收或合并主分支。

授权阻塞已解除：用户明确同意修改相关代码和数据库迁移以完成企业撤权同步，补丁重试获准。migration040严格区分device、enterprise-web、platform-admin来源，保留原设备FK，不伪造设备身份；成员/组织变更和撤权事件、sync游标在同一事务内提交。父进程及独立规格审查均实跑本机随机schema的 `server/scripts/collaboration-enterprise-http-integration.mjs` 退出0；覆盖双认证、事务内session/role重验、多接收者回滚、并发撤权及下载票据竞争。质量审查仍在进行；没有直接修改生产数据库。

后续检查点（cac7243）：native transfer runtime和安全另存为已完成规格/质量双审并提交，8项runtime与7项save测试通过。下载缓存不等于永久授权，保存前重新取得服务端授权、校验明文，并以独占发布防止覆盖用户文件；最终异步路径检查后再次验证撤权。主进程生命周期、7条closed IPC及preload装配随后也完成双审，尚待与共享service改动一起提交。父进程联合运行目录刷新、生命周期、runtime/save、service、IPC及负向/preload测试，共48项通过、0跳过。附件消息持久等待、完整Renderer入口、工作空间交接和真实私有桶仍未完成，不能据此宣布全模块闭环或主分支合并。

后续检查点（f50ceca / 34c4249）：企业撤权与native transfer主装配完成双审提交。父进程三组真实PG signedHTTP（企业、会话、对象）退出0；Node协作专项254项通过、0跳过；新增注册文档漏项曾令完整gate失败，补齐后完整重跑 `capability-gate: ok (158 tests)`，原有运行时跳过及Renderer宿主缺省IPC日志仍需单独说明。随后附件Renderer入口完成双审与真实Electron测试并提交，六项策略/导航/下载/状态问题及一项键盘焦点问题均经过新增红灯回归修复。消息等待交接尚未提交：独立审查发现handoff后原设备丢失、取消整组后崩溃仍恢复网络、损坏coordinator被当不存在，另有enqueue前崩溃与预上传后发送的恢复窗口，正在修复；不能把已通过的正常路径PG“两附件→ACK丢失→重启→单条消息→接收方另存为”当作这些窗口已通过。新PG链路仍使用Qiniu替身。没有合并主分支或部署。

| 里程碑 | 包含任务 | 硬出口 |
|---|---:|---|
| Slice 0 协议地基 | 1–7 | 两个无 UI 客户端通过重复、超时、乱序、断线、重启和撤权协议测试 |
| Slice 1 好友私聊 | 8–12 | 两个桌面客户端完成好友、离线私聊、编辑撤回、未读和重连 |
| Slice 2 群与 Team | 13–14 | 个人/Team/公开频道/私密频道权限矩阵全绿，撤权立即生效 |
| Slice 3 成果交接 | 15–18 | 私有密文对象、续传、过期/撤销、工作空间隔离导入闭环 |
| Slice 4 AI 增强 | 19 | AI 关闭时人工 IM 完整；未持久化 ACK 不能报告已发送 |
| Slice 5 灰度运营 | 20–22 | 故障注入、负载、安全、可访问性、Capability Gate 和部署演练通过 |

## Task 1：建立协作开关、公开身份和测试骨架

**Files:**

- Create: `server/migrations/032_collaboration_identity.sql`
- Create: `server/src/services/collaboration/policy.js`
- Modify: `server/src/config.js`
- Modify: `server/src/services/client-config.js`
- Modify: `src/main/remote-config.js`
- Create: `scripts/test-collaboration-policy.mjs`
- Create: `scripts/test-collaboration-schema.mjs`

- [ ] 写 `scripts/test-collaboration-policy.mjs`，固定以下契约：服务端默认关闭；签名远端配置可按用户/组织开启；显式 kill switch 优先；配置缺失或解析失败恢复关闭协作但不改变其他远端配置。
- [ ] 写 `scripts/test-collaboration-schema.mjs`，静态校验迁移包含 `user_profiles`、唯一 `lily_id`、合法 discoverability 约束，并禁止把手机号或邮箱作为公开检索键。
- [ ] 运行 `node scripts/test-collaboration-policy.mjs && node scripts/test-collaboration-schema.mjs`，确认测试因模块/迁移不存在而失败。
- [ ] 在 `server/src/config.js` 增加 `collaborationEnabled`、`collaborationRolloutOrganizations`、`collaborationMessageKek`、`collaborationMessageKekVersion`；生产开启协作但缺少消息 KEK 时启动失败，协作关闭时不阻断现有服务。
- [ ] 在 `server/src/services/client-config.js` 增加版本化策略：

```js
collaboration: {
  enabled: false,
  schemaVersion: 1,
  realtime: true,
  attachments: false,
  workspaceShares: false,
  aiTools: false,
}
```

- [ ] 在 `src/main/remote-config.js` 解析上述策略；未知字段忽略，未知 schema version 整体关闭协作。
- [ ] 创建 `032_collaboration_identity.sql`，包含 `user_profiles` 及更新时间索引；Lily ID 采用规范化小写值，展示值保留在独立字段。
- [ ] 运行目标测试和 `npm run test:capability-gate`。
- [ ] 提交：`git commit -m "feat(collaboration): add rollout policy and public identity"`。

## Task 2：创建服务端协作事件、消息与同步模式

**Files:**

- Create: `server/migrations/033_collaboration_core.sql`
- Create: `server/src/services/collaboration/contracts.js`
- Create: `scripts/test-collaboration-core-schema.mjs`
- Create: `scripts/test-collaboration-contracts.mjs`

- [ ] 在测试中断言所有核心表、外键、检查约束、部分唯一索引和幂等唯一键存在：关系、屏蔽、会话、成员、事件、消息、修订、回执、用户同步、设备 ACK、实时 outbox。
- [ ] 运行测试并确认红灯。
- [ ] 编写 `033_collaboration_core.sql`。关键约束必须直接由数据库保证：

```sql
unique (conversation_id, seq);
unique (actor_device_id, command_type, client_command_id);
check (next_seq >= 1);
check (last_read_seq >= 0);
check ((scope_type = 'organization') = (organization_id is not null));
```

- [ ] 为个人 direct 和 Team direct 增加规范化 pair key 与部分唯一索引，确保并发创建只得到一个会话。
- [ ] 为 `user_sync_events(user_id, cursor)`、历史分页、成员授权、未处理 realtime outbox、回执查询建立覆盖索引；JSON payload 不建立正文搜索索引。
- [ ] 在 `contracts.js` 定义有界枚举和 schema version 常量；未知持久事件由客户端忽略并记录，不阻断 cursor 推进。
- [ ] 运行 `node scripts/test-collaboration-core-schema.mjs && node scripts/test-collaboration-contracts.mjs`。
- [ ] 使用临时 PostgreSQL 执行 `npm run server:migrate` 两次，证明迁移可重复运行且第二次无变更。
- [ ] 提交：`git commit -m "feat(collaboration): add ordered event and sync schema"`。

## Task 3：抽出统一账号会话守卫和协作授权内核

**Files:**

- Modify: `server/src/services/account-session-guard.js`
- Create: `server/src/services/collaboration/authorization.js`
- Create: `server/src/services/collaboration/lock-order.js`
- Create: `scripts/test-collaboration-authorization.mjs`
- Create: `scripts/test-collaboration-lock-order.mjs`

- [ ] 为个人 direct、个人 group、Team direct、公开频道、私密频道建立表驱动权限测试，覆盖读取、发送、邀请、下载、审计、屏蔽和成员失效。
- [ ] 写锁顺序测试，固定 `organization/friendship → conversation → message/object(sorted) → user_sync_state(sorted)`；输入乱序 ID 时输出仍稳定排序。
- [ ] 运行两项测试确认红灯。
- [ ] 实现纯函数 `authorizeCollaborationAction(context, action)`，返回 `{ok, code, auditReason}`，不访问数据库、不信任客户端角色。
- [ ] 实现 `lockAuthorizationRows(trx, scope)` 和 `lockSyncStates(trx, userIds)`；所有 ID 排序和 SQL 锁语义集中在该模块。
- [ ] 将协作路由账号校验统一复用 `requireAccountSession`，不复制 `account.js` 内部 bearer/session 判断。
- [ ] 对 `40P01`、`40001` 输出统一 `{retryable:true, code:"COLLAB_TRANSACTION_RETRY"}`；权限错误永不标为 retryable。
- [ ] 运行目标测试和 `node scripts/test-account-session-guard.mjs`。
- [ ] 提交：`git commit -m "feat(collaboration): centralize authorization and lock order"`。

## Task 4：实现幂等命令收据与单事务事件提交器

**Files:**

- Create: `server/src/services/collaboration/idempotency.js`
- Create: `server/src/services/collaboration/command-runner.js`
- Create: `server/src/services/collaboration/event-writer.js`
- Create: `scripts/test-collaboration-idempotency.mjs`
- Create: `scripts/test-collaboration-command-runner.mjs`

- [ ] 先测试 canonical fingerprint：对象 key 排序、空值规范化、附件 ID 顺序保留；相同键同一 body 回放结果，不同 body 返回 `IDEMPOTENCY_KEY_REUSED`。
- [ ] 测试 `runCollaborationCommand` 只允许以下事务序列：锁授权、锁 conversation、分配 seq、写 event/projection、分配用户 cursor、完成 receipt、写 realtime outbox、commit。
- [ ] 注入 projection 写失败，断言 receipt/event/sync/outbox 全部回滚；注入 commit 后响应丢失，重试返回同一 event/message。
- [ ] 运行测试确认红灯。
- [ ] 实现 SHA-256 canonical request fingerprint，并禁止把 token、DEK、签名 URL、本地路径纳入回执 payload。
- [ ] 实现 `runCollaborationCommand({account, commandType, clientCommandId, input, authorize, project})`；receipt 首次插入与唯一冲突恢复都在事务内完成。
- [ ] `event-writer.js` 只接受已排序接收人，逐用户锁定并分配 cursor，同时生成聚合 realtime outbox 行。
- [ ] 配置短 `lock_timeout`、`statement_timeout`，死锁/序列化失败只用原幂等键做有界重试。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): add transactional idempotent command kernel"`。

## Task 5：实现文本消息、历史、编辑、撤回和读取投影

**Files:**

- Create: `server/src/services/collaboration/messages.js`
- Create: `server/src/services/collaboration/message-crypto.js`
- Create: `scripts/test-collaboration-messages.mjs`
- Create: `scripts/test-collaboration-message-crypto.mjs`

- [ ] 用依赖注入测试消息发送：连续 seq、引用验证、附件未完成拒绝、正文超限、屏蔽/撤权拒绝、同幂等键只产生一条投影。
- [ ] 测试 mention 只能引用当前 active 成员；用户 sync projection 能稳定计算未读数和 @ 数，重复事件不能重复累加。
- [ ] 测试编辑/撤回必须携带 `expectedRevision`；双设备并发只有一次 CAS 成功，失败返回当前 revision。
- [ ] 测试读取指针执行 `max(old, submitted)`，旧设备 ACK 不能把已读位置倒退。
- [ ] 测试消息 KEK 封装/解封、版本轮换、错误 key version 和日志 redaction；数据库内不得出现明文测试字符串。
- [ ] 运行测试确认红灯。
- [ ] 实现 `message-crypto.js`，使用独立 `COLLAB_MESSAGE_KEK` 的 AES-256-GCM 信封加密；AAD 绑定 message id、conversation id、revision。
- [ ] 在 `messages.js` 中通过 Task 4 命令内核发送、编辑、撤回；历史按 `beforeSeq` keyset 分页，默认 50、最大 200。
- [ ] 投影响应只返回当前已授权用户可见字段；普通成员不读取修订历史。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): implement ordered message projection"`。

## Task 6：实现无缝 bootstrap、增量 sync、多设备 ACK 和压缩

**Files:**

- Create: `server/src/services/collaboration/sync.js`
- Create: `server/src/services/collaboration/compaction.js`
- Create: `scripts/test-collaboration-sync.mjs`
- Create: `server/scripts/collaboration-sync-integration.mjs`

- [ ] 纯逻辑测试覆盖 sync limit、稳定 `fromCursor/toCursor`、未知事件、重复 event id、游标早于压缩水位和 stale device 判定。
- [ ] 集成测试在 bootstrap 每个查询边界并发插入消息，断言 `REPEATABLE READ READ ONLY` 快照的 watermark 前后均无缺口。
- [ ] 集成测试两台设备 ACK 不同 cursor 后压缩，较慢 active device 仍能增量；30 天未见设备被标记 full resync。
- [ ] 运行测试确认红灯。
- [ ] 实现 `bootstrapCollaboration`：同一只读可重复读事务中读取 profile、关系、Team、会话投影和 cursor watermark。
- [ ] 实现 `syncAfterCursor`：默认 500、最大 2000；cursor 太旧返回 `FULL_RESYNC_REQUIRED`，绝不返回看似成功的空页。
- [ ] 实现 `ackDeviceCursor`：只允许单调推进并校验账号/设备绑定。
- [ ] 实现压缩水位：`min(active device ACK, time-retention floor)`，stale device 标记需 full resync，不用最新设备覆盖旧设备状态。
- [ ] 运行纯逻辑和 PostgreSQL 集成测试。
- [ ] 提交：`git commit -m "feat(collaboration): add gap-free durable sync"`。

## Task 7：实现 realtime outbox dispatcher 与 WebSocket 提示层

**Files:**

- Create: `server/src/services/collaboration/ws-ticket.js`
- Create: `server/src/services/collaboration/realtime-dispatcher.js`
- Create: `server/src/services/collaboration/realtime-gateway.js`
- Modify: `server/src/app.js`
- Create: `scripts/test-collaboration-realtime.mjs`
- Create: `server/scripts/collaboration-realtime-integration.mjs`

- [ ] 测试 60 秒单次票据、票据重放、过期、设备不匹配、旧连接替换和 schema version。
- [ ] 故障注入 dispatcher 在读取 outbox 后、NOTIFY 前、NOTIFY 后崩溃；断言最多重复唤醒且消息 durable sync 永远存在。
- [ ] 测试 LISTEN 建立竞态、乱序/重复/丢弃 `sync.available`、半开连接和 server draining。
- [ ] 运行测试确认红灯。
- [ ] 实现票据只存哈希并 CAS 消费；WebSocket URL 只带票据，不带长期 access token。
- [ ] 实现 dispatcher 使用 `FOR UPDATE SKIP LOCKED` 租约领取 durable outbox，失败指数退避，完成后标记 delivered；PostgreSQL NOTIFY 仅为进程间提示。
- [ ] gateway 只推 `{type:"sync.available", schemaVersion:1, cursor}` 及有 TTL 的 typing/presence；不得经 socket 承载持久写命令。
- [ ] 在 `server/src/app.js` 注册协作 gateway，协作关闭时不绑定 upgrade handler。
- [ ] 运行目标测试及服务重启演练。
- [ ] 提交：`git commit -m "feat(collaboration): add durable realtime hints"`。

## Task 8：实现好友、屏蔽与唯一个人私聊

**Files:**

- Create: `server/src/services/collaboration/friends.js`
- Create: `server/src/routes/public/collaboration-friends.js`
- Create: `scripts/test-collaboration-friends.mjs`
- Create: `server/scripts/collaboration-friends-integration.mjs`

- [ ] 测试申请、交叉申请、重复申请、接受/拒绝、解除、重新添加、屏蔽优先级和 Lily ID 防枚举响应。
- [ ] 集成测试两个并发 accept 只创建一条 friendship 和一个 direct conversation；重新加好友复用原会话。
- [ ] 运行测试确认红灯。
- [ ] 所有写入接 Task 4 命令内核；好友接受事务同时 CAS 请求、插 friendship、upsert direct conversation、写双方 sync。
- [ ] 屏蔽后拒绝新申请、新消息和新对象 ticket；已有本地副本不宣称远程删除。
- [ ] 搜索结果只返回最少公开资料，并增加发送者、接收者、设备和 IP 维度限流接口。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): add friend and block workflows"`。

## Task 9：注册版本化 REST API 与 OpenAPI 契约

**Files:**

- Create: `server/src/routes/public/collaboration.js`
- Modify: `server/src/routes/public.js`
- Create: `server/src/services/collaboration/http-schemas.js`
- Create: `scripts/test-collaboration-api-contract.mjs`
- Modify: `scripts/test-server-api-docs.mjs`

- [ ] 测试所有设计文档 §13 路由存在、需要 bearer + signed device、body/limit 被 Zod 限制、错误统一含 `code/retryable/requestId`。
- [ ] 运行测试确认红灯。
- [ ] 路由层只做解析、账号守卫、调用领域服务和错误映射；不得在 route handler 中分配 seq 或直接改 projection。
- [ ] 对协作命令统一接收 `clientCommandId`；缺失时 400，不由服务端替客户端发明重试身份。
- [ ] 对 `objects/init`、`download-ticket` 增加 body logging 禁止和字段级 redaction 钩子。
- [ ] 在 `public.js` 注册路由并更新 OpenAPI 覆盖测试。
- [ ] 运行 `node scripts/test-collaboration-api-contract.mjs && node scripts/test-server-api-docs.mjs`。
- [ ] 提交：`git commit -m "feat(collaboration): expose versioned collaboration API"`。

## Task 10：创建独立本地数据库、账户密钥和安全缓存

**Files:**

- Modify: `src/main/config.js`
- Create: `src/main/collaboration/collaboration-store.js`
- Create: `src/main/collaboration/local-keyring.js`
- Create: `src/main/collaboration/schema.js`
- Create: `scripts/test-collaboration-store.mjs`
- Create: `scripts/test-collaboration-local-keyring.mjs`

- [ ] 测试 `collaboration.db` 与 `messages.db` 路径不同；DB 损坏或锁定只关闭协作服务，不影响 SessionManager。
- [ ] 测试账户 A/B 同一正文得到不可互解密的缓存；退出保留密文，同账号重新登录可恢复，Team 撤权销毁 scope key。
- [ ] 测试 outbox、乐观消息和草稿在一个 SQLite 事务内创建，网络请求只能发生在事务成功之后。
- [ ] 运行测试确认红灯。
- [ ] 在 `config.js` 增加 `collaborationDbPath()` 和专用 transfer root。
- [ ] 用现有 `src/main/store/sqlite-db.js` 建立 WAL 数据库，表含 profiles、conversations、members、events、messages、applied_events、sync_state、outbox、drafts、transfers、share_mappings。
- [ ] `local-keyring.js` 使用 Electron `safeStorage` 封装每账户随机主密钥；正文/草稿 AES-GCM AAD 绑定账户、会话和记录 ID。
- [ ] 不建立明文消息 FTS；元数据搜索只覆盖 Lily ID、好友、Team、频道、标题、附件卡片名。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): add isolated encrypted desktop cache"`。

## Task 11：实现桌面端 sync engine、持久 outbox 与恢复状态机

**Files:**

- Create: `src/main/collaboration/client.js`
- Create: `src/main/collaboration/outbox.js`
- Create: `src/main/collaboration/sync-engine.js`
- Create: `src/main/collaboration/realtime-client.js`
- Create: `src/main/collaboration/service.js`
- Create: `scripts/test-collaboration-outbox.mjs`
- Create: `scripts/test-collaboration-sync-engine.mjs`

- [ ] 用虚拟 transport 测试 `draft → queued → submitting → confirming → persisted → projected` 和 retryable/permanent 分类。
- [ ] 测试同会话 lane 严格串行、不同会话并发；前一条达到自动重试上限时必须暂停并等待用户选择。
- [ ] 测试 HTTP commit 后 ACK 丢失：状态保持 confirming；sync 用同 `client_command_id` 原位结算，不能生成第二个气泡。
- [ ] 测试 sync page 本地提交后、服务端 ACK 前崩溃：重启重复 page，`event_id UNIQUE` 去重且 cursor 只前进一次。
- [ ] 测试 full resync 只清空并重建当前账户的协作投影，不删除 AI 会话、工作空间、其他账户密文缓存或仍在确认中的原始 outbox 意图。
- [ ] 测试用户在 submitting/confirming 取消：先用原幂等键确认 receipt；未提交才取消，已提交则转为“已发送”并提供撤回，绝不伪造取消成功。
- [ ] 运行测试确认红灯。
- [ ] `client.js` 通过 `accountManager.accessTokenForService()` 取得短期 token，401 时只刷新一次；Renderer 永远拿不到 token。
- [ ] `sync-engine.js` 在单个 SQLite 事务应用整页、结算 outbox、更新投影和本地 cursor，事务后再 ACK 服务端。
- [ ] `realtime-client.js` 心跳 30 秒、抖动退避上限 30 秒；前台每 15 秒、后台每 60 秒 cursor check，网络变化/唤醒/聚焦立即 sync。
- [ ] `service.js` 构造失败时返回 `COLLABORATION_UNAVAILABLE`，不抛到 app 启动主链。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): add crash-safe desktop sync engine"`。

## Task 12：建立 IPC/preload 边界和协作中心基础三栏 UI

**Files:**

- Create: `src/main/ipc-collaboration.js`
- Modify: `src/main/ipc-handlers.js`
- Modify: `src/main.js`
- Modify: `src/preload.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Create: `src/renderer/modules/collaboration-center.js`
- Create: `src/renderer/modules/collaboration-state.js`
- Create: `src/renderer/styles/collaboration.css`
- Modify: `src/renderer/styles.css`
- Create: `scripts/test-collaboration-ipc.mjs`
- Create: `scripts/test-collaboration-ui.cjs`

- [ ] 测试 IPC allowlist、每个 payload 大小限制、conversation/object/path 二次校验；preload API 中不存在 token/DEK/raw-path getter。
- [ ] DOM 测试三栏布局、窄屏降级、个人/Team scope badge、空态、离线状态、键盘焦点顺序和 aria live 区。
- [ ] 运行测试确认红灯。
- [ ] `main.js` 在账户管理可用后构造 CollaborationService；失败只记录安全错误码。退出时停止 realtime/dispatcher 并关闭 DB。
- [ ] `ipc-collaboration.js` 暴露 bootstrap/list/open/send/retry/cancel/mark-read 和事件订阅；返回显示所需 view model，不返回密钥、token、服务端内部行或本地路径。
- [ ] 在左侧顶级导航加入“工作台 / 协作中心”切换；协作关闭时入口隐藏且原 DOM/快捷键行为保持不变。
- [ ] 三栏结构固定为导航/收件箱/会话；会话标题、发送确认和通知始终显示个人或 Team 作用域。
- [ ] 桌面通知只包含安全预览和明确 scope；静音、当前可见会话、系统通知权限和 Team 策略任一禁止时不弹出，点击通知通过内部 conversation id 定位。
- [ ] 更新 `zh-CN.json`、`en.json`、`ar.json`，并让测试验证所有协作 key 三语齐全和 RTL 可用。
- [ ] 运行目标测试和 `npm run test:renderer`。
- [ ] 提交：`git commit -m "feat(collaboration): add secure IPC and center shell"`。

## Task 13：完成好友、消息时间线、编辑撤回和恢复交互

### 继续实施的依赖顺序（审计确认，未实现项不能当完成）

2026-08-31 持久 mutation 切片已完成规格与质量独立复审：编辑/撤回先加密进入既有 outbox，原设备 typed ACK/receipt 与最低 revision 刷新目标原子结算，原创建序号不变。新增崩溃 queued 恢复、并发 drain、drain→skip/cancel 和 stop→迟到错误回归；最终发送边界仅允许仍为 queued 的命令。父进程最终遍历79个协作 Node 脚本全部通过，真实迁移033/037/038/040的 PostgreSQL signedHTTP→丢ACK→SQLite重启→receipt→history通过，且断言创建/编辑/撤回各只有一个服务端事件。完整166项能力门禁退出0，但执行早于最后的 queued-only 竞态修复；该修复随后由上述79脚本和PG专项复验，不能冒称最终代码已重新跑完整门禁。原 Renderer 测试宿主未注册IPC日志仍存在。持久已读、准确未读统计、引用/@和完整消息UI尚未实现；没有合并或部署。

2026-08-31 后续已读切片完成规格与质量独立复审：SQLite v13 分离加密 read checkpoint、精确活动投影和会话刷新 generation；原 UUID/device/seq 重放，较高 pending 合并，持久退避（最多60秒间隔，每轮20项/2 worker），不占用文本发送屏障。own-read 精确刷新必须持久化后才 ACK；旧 bootstrap/get、停止和撤权后的迟到结果不能覆盖新状态。异常序号钳制不立即重发，但后续正常较低观察和授权快照/消息/历史证明的真实增长可以继续已读。有序新消息的计数与 projectionSeq 原子前进，自己的消息及已读消息不增加计数，任意历史页不推进覆盖序号。服务端从全部授权消息和原创建事件聚合 unread/mention，legacy 缺省为 unknown。

最终冻结版父进程验证：82个协作 Node 脚本加 architecture/registry 共84项全部通过；12组本地 PostgreSQL 随机 schema 集成全部通过；完整能力门禁 `capability-gate: ok (169 tests)` 退出0。新增 signedHTTP 600条消息/200条缓存/双设备/SQLite重启/私密加入边界/公共频道精确统计和同步前ACK断言通过；既有 sync PG夹具升级为真实迁移033/035/037/038/040并保留边界/压缩断言。门禁仍包含缺少 bundled OpenCode 的跳过与原 Renderer 宿主未注册IPC日志（本次121行），不能等同于全项目零跳过、真实双Electron、私有bucket或生产验收。上段 mutation 检查点是历史结果；此次门禁已覆盖该提交及本次最终修复。没有合并或部署。

1. **持久编辑/撤回**：复用现有 outbox 的类型化命令、同键恢复和会话屏障；device-bound receipt确认与最低revision历史刷新检查点原子写入。原消息createSeq和创建command ID不变，不新增乐观气泡；旧历史响应只能清掉自己已验证的刷新目标，不能删除并发新增的更高revision。
2. **持久已读与准确统计**：独立read checkpoint，不进入消息发送屏障。pendingMax可合并，已经发出的UUID/device/seq冻结；ACK或授权快照确认后仍保留更高pendingMax。扩既有bootstrap/conversations-get准确返回projectionSeq/lastReadSeq/unreadCount/mentionCount，从全部授权消息及对应创建事件统计，而非seq差或最近200条。增量事件按snapshot覆盖序号去重；自己的read事件触发持久conversation hydration精确刷新，再ACK。
3. **引用/@与消息字段**：引用ID、mention IDs贯穿draft/outbox/重启恢复/完整意图比较；有限引用快照由main从授权目标取得，撤回后显示占位。public Team频道的@候选需与activeRecipients同源（全体active Team成员）；private/group/direct不能放宽成整个Team名册。保留服务端createdAt，不能以本地缓存写入时间推断15分钟编辑/24小时撤回窗口。先接通不可变字段、准确时间和主进程边界，再完成发送时加密引用快照/授权候选；两个子切片均完成才算此项关闭。创建消息的生产 transport 对缺失/错会话的200响应也必须保持不确定，不能以空的 committedView 提前确认并释放队列。
4. **实际消息交互**：在现有timeline/composer/shell上增加行内编辑、撤回确认、冲突比较、引用条和键盘@候选，不新增第二面板。mutation恢复视图区分原消息发送状态与修改状态，保留未提交编辑稿。收件箱按稳定conversation ID更新，使用持久pin/notification偏好、未读提及和权威最近活动排序，不跨会话比较局部seq。
5. **可见已读与Electron验收**：窗口聚焦、document/面板/当前会话可见才观察viewport内已持久消息；切换/隐藏/账号/撤权令迟到回调失效。主进程复核可见窗口、授权会话及缓存seq。复用真实timeline/attachments/social-navigation Electron夹具，测试旧detached按钮、失焦、跨会话迟到结果、冲突/撤回及三语言；静态surface检查不算交互E2E。

2026-08-31 3A 完成规格→质量独立审查及复审。引用ID和显式mentions经过preload/严格IPC、加密draft/optimistic/outbox、原device和同UUID重试、历史及SQLite重启保留；同文但引用/@不同的新版草稿不误清，附件意图不能被纯文本同键替换。新建正文32KiB在主进程写盘前和服务端旧receipt分支之后约束，旧64KiB已提交消息仍可恢复和读取。历史mentions来自原创建event，服务端时间与clientCreatedAt分离，history-first确认不丢稳定command ID、不覆盖较新revision。私密joined-seq边界也约束新引用。

审查补齐了五个旧测试的device/字段前置条件，消除了草稿测试假绿和生命周期测试永久等待；质量审查另用真实SQLite/outbox复现“同会话撤回ACK被误当create成功、释放队列且无法恢复”，现生产create ACK必须严格满足revision=1且revoked=false。20种错误响应矩阵验证异常分类、未确认屏障和重启后完整意图恢复，非错会话用例均使用正确会话避免其他校验遮蔽缺陷。

最终代码验证：85个协作Node脚本加architecture/registry共87项通过；13组隔离PostgreSQL集成通过；完整能力门禁172项退出0。新增PG验证真实迁移/签名HTTP/错误200/SQLite重启/receipt/引用可见边界及64KiB升级回放；旧receipt集成改用正式迁移并保留授权、锁等待与撤权断言。门禁仍有bundled OpenCode缺失的shape/usage跳过和121行既有Renderer宿主未注册IPC诊断，不等于全项目零跳过或真实双客户端/私有bucket/生产验收。3B引用快照和候选、完整消息UI及可见已读仍未完成；未合并或部署。

第3项的实施出口（不能用字段接通代替引用体验）：

- [x] 3A：reply ID、显式 mention IDs、完整草稿意图、原设备恢复、创建 ACK 的确切证据；服务端原创建事件的 mention、服务端 createdAt 和 sender 经 history/SQLite/IPC 保留。私密历史边界也必须约束新引用。对应新增 signedHTTP/PG→桌面→错误200→receipt→重启→history 回归，初始已复现引用ID落库为 null，修复后通过。
- [ ] 3B：发送时有限引用快照必须加密、绑定发送记录且不能由 Renderer 伪造；原文后续编辑不能偷偷改写已经发送的快照，原文撤回/不可读则仅显示占位。接收方不能借新回复读取其加入前不可见原文；本地旧引用缓存也要遵循撤权/撤回。复用现有加密、history 和确定性主进程边界，不把正文放入 event payload。
- [ ] 3B：沿用授权会话详情获取 @ 候选，public Team 采用现有 activeRecipients 的全体 active Team 成员语义；私密/群聊/direct 不扩大范围。候选数据与管理用 members 分开，避免把公共频道候选误当显式成员；首发 Team 上限1000，候选不能静默截断并声称完整。

3B 按可验证边界顺序实施，不能只交付服务端就勾选上面的完整出口：

2026-08-31 服务端快照检查点：加性041、独立用途信封、事务内发送时截取、批量按接收人授权后解密、明确占位和客户端保留字段拒绝已实现。87个协作Node守卫加architecture/registry共89项通过；14组隔离PostgreSQL集成通过；完整能力门禁174项退出0。真实PG包括签名HTTP、source/reply编辑、receipt不重建、跨消息/会话/用途错绑、加入前隔离、插入故障全事务回滚、source硬删除和reply撤回清密文。门禁仍有bundled OpenCode shape/usage缺失跳过及121行既有Renderer宿主IPC诊断；不是全项目零跳过、真实双客户端或私有bucket验收。桌面缓存/IPC快照消费、撤回屏蔽、@候选仍待后续切片；尚未合并或部署。

服务端边界补充：原文硬删除沿用既有 FK `ON DELETE SET NULL`，遗留引用密文返回 unavailable 且不解密；随后引用消息自身也撤回时清除该密文/封装密钥，源ID与引用密文均不存在的记录返回 null（自身仍为撤回 tombstone）。不为这一已无内容的组合增加额外历史身份字段。

1. 服务端引用快照：加性存储迁移；复用现有 envelope crypto、独立用途 AAD 和随机 DEK。快照在创建事务持有授权锁时从原文生成，绑定新消息 ID/会话且不随后续编辑改变；正文上限512个 Unicode code point（最多2048 UTF-8字节），标明是否截断，不复制嵌套引用或附件凭证。命令只传目标ID，不接受客户端快照正文。相同命令 receipt 回放不重建快照；原引用在接收者 joined-seq 边界外、撤回、不可用或回复本身被撤回时，仅返回占位，不解封引用正文。旧记录没有发送时快照则明确缺失，不能以当前原文冒充历史快照。真实PG测试覆盖原文编辑、撤回、新成员边界、错误用途/消息绑定和回放。
2. 桌面引用读模型：授权 history 取得快照后加密入本地消息缓存，get/list/readMessages/重启一致；显示用快照与不可变发送意图分离。已知原文撤回要在同步事务中屏蔽所有旧引用，包括最近200条之外的缓存；过时 history 不能复活引用。会话/Team撤权、membership epoch、bootstrap重建与账号切换一起清理或重新授权。Renderer只能传目标ID，不能伪造快照。主进程/实际IPC回归先于UI接线。
3. 授权候选：服务端会话详情与现有 activeRecipients 同源；候选独立于管理成员投影，包含最小安全身份字段和明确完整性。主进程缓存、撤权/目录变化失效和IPC白名单齐备，旧服务器缺字段显示未知而不是擅自拿Team全量成员补齐。超过首发上限明确失败，不能悄悄截取1000项。

桌面读模型采用无正文的 account/conversation/source 屏蔽元数据和统一 get/list 占位投影，不为单次撤回扫描解密整个会话。源撤回标记与 cursor 同事务；授权 target-history 的明确 unavailable 也屏蔽旧引用，网络失败不得触发此动作。单条 legacy reply 缺快照或 reply 自身撤回不证明其源不可读，不能屏蔽同源其他有效回复。异步 history 需验证发起时会话代次，防 bootstrap/新 membership/撤权后重建被旧响应污染；仍可见会话 bootstrap 不得遗忘已知不可逆源撤回。显示快照始终不进入 draft/outbox/wire identity。

桌面切片双审无阻断问题；质量审查建议已固化为5项额外回归。两份新guard共37/37通过：有数据的磁盘v13→v14升级保留密文/草稿/cursor，generation回填、INSERT、普通upsert与重复迁移符合预期；page/target两条服务路径的迟到授权拒绝/网络错误跨bootstrap不得清理新代次、改变mask/cursor或ACK。

2026-08-31 桌面引用验证检查点：v14 source masks 与新会话 generation 插入 trigger、加密 history/get/list/readMessages/IPC、不可见优先、授权代际 fence 已实现。父独立91个脚本（89协作Node+architecture/registry）通过；14组真实PG集成通过；完整能力门禁176项退出0。新PG链路从正式bootstrap、授权history持久化、completion ACK进入sync，覆盖重启后的quote/真实IPC/源撤回即时屏蔽/同revision迟到history和新成员隐私；好友accepted创建/删除重建漏fence已实际RED→GREEN。能力门禁仍有bundled OpenCode shape/usage缺失跳过与121行既有Renderer宿主IPC诊断。尚无引用UI、@候选、真实双应用交互或Task20物理擦除验收，不据此关闭Task13整体。

- [x] 近期补强：生产 receipt transport 与 create ACK 使用一致的不可矛盾提交证据。2026-08-31实际SQLite+生产transport/outbox注入 completed create receipt（revision=3、revoked=true）后，错误进入persisted/deliveryConfirmed=true并采用sequence=9。不是正常服务端已返回此数据的证据，而是客户端确实缺少防御；桌面引用切片后立即修复。覆盖缺失/错类型/错会话/错revision/revoked/两sequence矛盾、显式unknown兼容、cancel/reconcile/重启与原UUID/device保持。不得把不完整回执当成未知重发证明；服务器receipt视图只在revoked=true时携带该字段，正常create省略false须兼容。

回执补强实现冻结：客户端生产lookup严格验证创建提交证据及可选布尔字段；显式unknown保留原UUID/device重试，通用outbox兼容接口不变。服务端从原始event确认id/type/client_command_id，兼容旧创建回执缺revision并拒绝矛盾字段；completed缺event链接报错而不是授权重发，mutation仍用其事件序号而非原创建序号。父独立209项客户端矩阵、85项服务端矩阵、93个Node/architecture/registry脚本及14组PG通过；PG新增真实签名旧回执→桌面transport→SQLite重启确认，并覆盖错误持久回执和断链接。补查实际复现unknown的pending字符串授权重发，已在生产边界对所有命令严格校验unknown类型（合法null proof仍兼容），原通用outbox不变；规格与质量均已独立复审通过。最终冻结代码完整能力门禁178项退出0；仍有bundled OpenCode shape/usage缺失跳过和121行既有Renderer宿主IPC诊断。此回执补强切片闭合，不等于全项目零跳过、真实双客户端/私有bucket或整个IM验收；未合并主分支或部署。

**Files:**

- Create: `src/renderer/modules/collaboration-inbox.js`
- Create: `src/renderer/modules/collaboration-timeline.js`
- Create: `src/renderer/modules/collaboration-composer.js`
- Create: `src/renderer/modules/collaboration-friends.js`
- Modify: `src/renderer/styles/collaboration.css`
- Modify: `src/renderer/i18n/locales/zh-CN.json`
- Modify: `src/renderer/i18n/locales/en.json`
- Modify: `src/renderer/i18n/locales/ar.json`
- Create: `scripts/test-collaboration-message-ui.cjs`

- [ ] 测试好友申请全流程、未读分界、引用、编辑冲突、撤回 tombstone、滚动锚定和草稿按会话恢复。
- [ ] 测试 `@` 候选只来自当前 active 成员，键盘可完成选择；消息渲染和通知中的 @ 提示不依赖不可信 HTML。
- [ ] 测试乐观消息在 ACK/sync 后使用相同 DOM identity 绑定服务端 ID，并按 server seq 平滑重排；不得先删后加造成闪烁或屏幕阅读器重复播报。
- [ ] 测试超时显示“正在确认”而非“发送失败”；永久失败提供修改/取消，队列暂停提供继续/跳过/取消。
- [ ] 运行测试确认红灯。
- [ ] 实现 inbox 排序、未读/@ badge、固定会话、静音和 scope badge；不做逐人已读头像墙。
- [ ] Composer 支持 Enter/Shift+Enter、引用、附件入口、每会话草稿和明确发送状态。
- [ ] 窗口聚焦且会话可见时才 mark-read；读取指针只单调推进。
- [ ] 运行目标测试和实际 Electron 双窗口手工检查。
- [ ] 提交：`git commit -m "feat(collaboration): complete friend chat experience"`。

## Task 14：实现个人群、Team direct 与公开/私密频道

**Files:**

- Create: `server/src/services/collaboration/conversations.js`
- Create: `server/src/services/collaboration/team-scopes.js`
- Create: `server/src/routes/public/collaboration-conversations.js`
- Create: `src/renderer/modules/collaboration-teams.js`
- Create: `scripts/test-collaboration-team-permissions.mjs`
- Create: `server/scripts/collaboration-team-race-integration.mjs`

- [ ] 权限矩阵测试覆盖 owner/admin/member、active/suspended/removed、公开/私密、读/发/邀请/下载/审计。
- [ ] 竞态测试成员移除与 send、scope revoke 与 history/download 同时发生，结果严格等价于某个串行顺序；撤权提交后不得插入新消息。
- [ ] 交叉 Team 并发 fanout 测试统一锁顺序，并注入 `40P01/40001` 验证原幂等键安全重试。
- [ ] 运行测试确认红灯。
- [ ] 复用 `organizations`/`organization_members` 作为 Team 权威身份，不复制企业成员表。
- [ ] 实现 personal group、Team direct、public channel、private channel 的创建和成员管理；私密频道每次读取都验证双重 active。
- [ ] 撤权事务写 durable sync event；客户端收到或 API 403 时锁定 Team、清理 scope key 和正文投影，但不虚假承诺删除已导出副本。
- [ ] Renderer 在导航、标题、通知、分享确认中明确组织名和频道类型，重名收件人禁止猜测。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): add groups and team conversations"`。

## Task 15：实现并固定 `LILYENC1` 流式加密容器

**Files:**

- Create: `src/main/collaboration/encrypted-container.js`
- Create: `src/main/collaboration/encrypted-container-format.js`
- Create: `fixtures/collaboration/lilyenc1-vector.json`
- Create: `scripts/test-collaboration-encryption.mjs`

- [ ] 先创建固定向量测试：确定性输入/固定 DEK/固定 nonce source 产生固定 header、chunk tag、trailer 和 hash；生产路径必须使用真随机 nonce。
- [ ] 加入 0 字节、块边界、超大声明、截断、位翻转、错误 DEK、nonce 重复检测、未知版本和 AAD 篡改测试。
- [ ] 运行测试确认红灯。
- [ ] 实现 4 MiB 分块 AES-256-GCM；每块唯一 96-bit nonce，header 作为 AAD，trailer 记录 chunk count 和整体密文 SHA-256。
- [ ] 解密先验证 magic/version/长度上限，再逐块认证；任一失败关闭句柄并删除专用 transfer 临时文件。
- [ ] API 以 stream/path broker 为输入输出，不把整个工作空间包读入 Renderer 或常驻内存。
- [ ] 运行目标测试，并用 1 B、4 MiB、4 MiB+1 B、1 GiB 稀疏 fixture 做内存上界检查。
- [ ] 提交：`git commit -m "feat(collaboration): add versioned encrypted container"`。

## Task 16：建立私有对象存储、密钥代理和对象状态机

**Files:**

- Create: `server/migrations/034_collaboration_objects.sql`
- Modify: `server/src/config.js`
- Create: `server/src/services/collaboration/object-key-broker.js`
- Create: `server/src/services/collaboration/object-store.js`
- Create: `server/src/services/collaboration/objects.js`
- Create: `server/src/routes/public/collaboration-objects.js`
- Modify: `server/.env.example`
- Modify: `deploy/baota/docker-compose.yml`
- Modify: `deploy/baota/docker-compose.app-only.yml`
- Modify: `deploy/baota/docker-compose.external-postgres.yml`
- Create: `scripts/test-collaboration-objects.mjs`

- [ ] 测试对象状态机只允许 `initiated→uploading→uploaded→verified→bound` 及明确失败/过期/撤销路径；非法跳转失败。
- [ ] 测试上传 token 只授权随机指定 key、大小范围和短时效；下载 ticket 最长 5 分钟且每次重新授权。
- [ ] 测试 KEK 不可用时附件明确失败，文本消息仍可用；日志中无 DEK/wrapped DEK/URL。
- [ ] 运行测试确认红灯。
- [ ] 迁移创建 `stored_objects`、`object_keys`、`message_attachments`、`workspace_shares` 和清理/删除补偿队列表。
- [ ] 配置独立 `COLLAB_QINIU_ACCESS_KEY/SECRET_KEY/BUCKET/PRIVATE_BASE_URL` 与 `COLLAB_OBJECT_KEK(_VERSION)`；生产启用附件但配置不完整时 fail closed。
- [ ] key broker 在请求内立即封装随机 DEK，只持久化 wrapped DEK；实现 init/complete/abort/download-ticket/revoke。
- [ ] complete 必须对 Kodo HEAD 验证 key、大小、etag/hash；只有 owner、scope、用途均匹配的 verified 未绑定对象可在消息事务绑定，绑定以 CAS 保证单次成功。
- [ ] 部署配置只传环境变量，不写真实 secret；现有公开 Qiniu 配置保持不变。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): add private encrypted object storage"`。

## Task 17：实现断点续传、下载验证和崩溃恢复

**Files:**

- Create: `src/main/collaboration/transfer-manager.js`
- Create: `src/main/collaboration/transfer-manifest.js`
- Create: `scripts/test-collaboration-transfers.mjs`

- [ ] 测试 init 后崩溃、部分上传后重启、complete ACK 丢失、下载 URL 过期、密文 hash 错、明文 hash 错、撤销和权限变化。
- [ ] 测试 transfer root 路径规范化、0700、symlink 拒绝和 manifest 身份；无法确认归属的目录保留并报告，不盲删。
- [ ] 运行测试确认红灯。
- [ ] 实现分块上传 checkpoint 持久化；complete 使用稳定 client command id，ACK 丢失时查询对象状态而非新建对象。
- [ ] 下载先校验密文 size/hash，再流式解密和明文 hash；成功后通过 save/import broker 原子移动，失败删除已认证的专用临时文件。
- [ ] 清理只接受 `collaboration-transfer` 根下经过 `realpath` 验证且含有效 manifest 的随机目录。
- [ ] 网络失败退避不阻塞文本 outbox；同一消息附件未 verified 时消息命令保持可解释等待状态。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): add resumable verified transfers"`。

## Task 18：接入工作空间预检、加密分享卡与隔离导入

**Files:**

- Modify: `src/main/workspace-share.js`
- Create: `src/main/collaboration/workspace-share-service.js`
- Modify: `src/main/ipc-collaboration.js`
- Create: `src/renderer/modules/collaboration-share-cards.js`
- Create: `scripts/test-collaboration-workspace-share.mjs`
- Modify: `scripts/test-workspace-share.mjs`

- [ ] 测试现有 `.lilyspace.zip` 导出/导入行为保持；协作 adapter 只编排 preview → export → encrypt → upload → bind。
- [ ] 覆盖敏感文件排除、内容预警、自动化默认暂停、旧包兼容、zip-slip、symlink、文件数/总大小/单文件/压缩炸弹限制。
- [ ] 测试发送方离线时接收方仍能下载；share 过期/撤销/损坏/权限撤销均有明确卡片状态。
- [ ] 测试目标目录已存在时绝不覆盖，导入失败不留下半工作空间；重复导入要求用户选择新副本或取消。
- [ ] 运行测试确认红灯。
- [ ] `workspace-share-service.js` 复用现有 preview/export/import，不复制 zip 规则；share 元数据记录 plaintext hash、parent share id 和过期策略。
- [ ] 发送确认卡显示收件人/Team scope、文件数、大小、敏感预警、有效期；Renderer 不接触源路径或 DEK。
- [ ] 接收卡支持“查看安全摘要 / 下载 / 导入为新工作空间”；导入通过 main 隔离目录和原子 rename。
- [ ] 运行目标测试、`node scripts/test-workspace-share.mjs` 和手工双客户端闭环。
- [ ] 提交：`git commit -m "feat(collaboration): add encrypted workspace handoff"`。

## Task 19：加入 AI 协作工具和强制发送确认

**Files:**

- Create: `src/main/collaboration/agent-tools.js`
- Create: `src/main/collaboration/agent-confirmation.js`
- Modify: `src/main/mcp/tool-broker-registry.js`
- Modify: `src/main/required-tool-completion.js`
- Create: `scripts/test-collaboration-agent-tools.mjs`
- Create: `scripts/test-collaboration-agent-confirmation.mjs`

- [ ] 测试 `list_contacts/list_conversations/read_conversation/draft_message/send_message/prepare_workspace_share/send_workspace_share/download_shared_artifact` 的确定性参数与权限范围。
- [ ] 测试跨模块自然语言发送必须显示收件人、作用域、最终正文和附件预览；重名、跨 Team 歧义、上传未完、权限过期必须停下。
- [ ] 测试只有 server persisted ACK 或 sync reconciliation 能满足 required-tool completion；草稿、本地文件、queued/confirming 都不能报告“已发送”。
- [ ] 测试 `collaboration.aiTools=false` 时不注册工具且原有 agent 请求 body、工具集合和工作台行为保持基线。
- [ ] 运行测试确认红灯。
- [ ] 模型只负责理解与草拟；ID 解析、授权、上传、重试、校验和导入全部调用确定性服务。
- [ ] `read_conversation` 强制用户指定会话和时间/消息范围，并执行字符数、消息数和时间窗三重上限。
- [ ] 工具使用可信 main owner scope，不接受模型伪造用户/Team/本地路径。
- [ ] 运行目标测试和 `npm run test:runtime`。
- [ ] 提交：`git commit -m "feat(collaboration): add confirmed AI collaboration tools"`。

## Task 20：加入审计、指标、清理、保留和密钥轮换

**Files:**

- Create: `server/src/services/collaboration/audit.js`
- Create: `server/src/services/collaboration/maintenance.js`
- Create: `server/src/services/collaboration/metrics.js`
- Create: `server/scripts/collaboration-maintenance.mjs`
- Create: `scripts/test-collaboration-maintenance.mjs`
- Create: `scripts/test-collaboration-log-redaction.mjs`

- [ ] 测试审计只有 actor/action/scope/result/内部 ID/时间，不含正文、文件列表、token、DEK、URL 或完整路径。
- [ ] 测试孤儿 24 小时清理、retention tombstone、对象与 wrapped DEK 删除、失败补偿重试、账号注销 30 天恢复期和 Team 保留规则。
- [ ] 幂等 receipt 的清理下限不得短于对应消息保留期和最大离线重试窗；删除前还要确认没有 non-terminal outbox 可能引用该 command id。
- [ ] 测试消息/object KEK 版本轮换可读旧数据、新写只用当前版本，删除旧 key 前有引用计数硬门槛。
- [ ] 引用快照同属受保护正文：保留到期/注销擦除不能遗漏其密文和封装密钥，旧 message KEK 的引用检查必须统计快照；撤回/到期读模型在后台清理尚未完成时也不得解封原引用。
- [ ] 本地 reply_source_masks 不按时间盲目过期：只有对应会话/授权代次清理且旧引用和迟到响应已被隔离时才可删除；否则删除屏蔽元数据会使仍缓存的旧引用重新可见。正文物理清理与显示屏蔽分开验证。
- [ ] 运行测试确认红灯。
- [ ] 指标至少包含 send commit latency、sync lag、outbox age/retry、WS connection、dispatcher backlog、object bytes/failures、403/429、full resync count；不得以正文作 label。
- [ ] maintenance 使用可恢复批次和 `SKIP LOCKED`，每批有上限；数据库删除与 Kodo 删除不一致时留在补偿队列。
- [ ] 加入 server startup/shutdown 生命周期，但维护失败只降低协作后台能力，不影响 AI 网关和现有公开服务。
- [ ] 运行目标测试。
- [ ] 提交：`git commit -m "feat(collaboration): add safe operations lifecycle"`。

## Task 21：建立故障注入、并发与容量硬门槛

**Files:**

- Create: `server/scripts/collaboration-fault-injection.mjs`
- Create: `server/scripts/collaboration-load.mjs`
- Create: `scripts/test-collaboration-fault-matrix.mjs`
- Create: `docs/operations/collaboration-runbook.md`

- [ ] 故障矩阵至少覆盖：请求发送前崩溃、数据库 commit 前/后崩溃、ACK 丢失、WS 通知丢失/重复/乱序、sync 本地事务前/后崩溃、cursor ACK 丢失、dispatcher/NOTIFY 关闭、睡眠恢复、对象 complete ACK 丢失。
- [ ] 每个场景断言最终可见消息数、server seq、client command id、outbox terminal state、两个设备 cursor 和未读数；任何静默缺口或重复气泡使脚本非零退出。
- [ ] 并发场景覆盖同会话 100 个发送者、交叉会话 fanout、成员撤权竞态、好友并发接受和双设备编辑 CAS。
- [ ] 引用捕获与原文编辑/撤回使用真实数据库锁屏障验证并发序列化；本阶段单独报告，不将现有顺序执行的快照回归当作该并发验收。
- [ ] 负载脚本输出 p50/p95/p99、DB lock wait、sync lag、realtime backlog；设置首发硬门槛：正常负载 p95 send commit < 500 ms、p95 sync catch-up < 2 s、零序号冲突、零永久丢失。
- [ ] runbook 写明开关、指标、告警、dispatcher 排障、full resync、KEK 轮换、对象补偿、回滚和“不要手工改 cursor/seq”的禁令。
- [ ] 在隔离测试数据库和私有测试 bucket 运行；保存机器规格、数据量和结果，不用 mock 结果替代真实报告。
- [ ] 提交：`git commit -m "test(collaboration): add failure and load gates"`。

## Task 22：Capability Gate、灰度部署和最终闭环验收

**Files:**

- Create: `scripts/test-collaboration-capability-gate.mjs`
- Create: `scripts/test-collaboration-security-boundary.mjs`
- Modify: `src/shared/capability-gates.json`
- Modify: `CAPABILITY-GATE.md`
- Modify: `server/.env.example`
- Modify: `deploy/baota/README.md`
- Modify: `README.md`
- Create: `docs/operations/collaboration-release-checklist.md`

- [ ] Capability Gate 测试快照协作关闭/初始化失败/服务端不可达三种情况下的 AI 工作台：请求路径、模型选择、工具、上下文、文件处理、SessionManager 启动和现有 UI 均保持基线。
- [ ] 安全边界测试证明 Renderer 不得获得 access/refresh token、DEK、wrapped DEK、签名 URL持久副本或源路径；越权 object id 无法换 ticket。
- [ ] 在 `src/shared/capability-gates.json` 注册 `collaboration-center-isolation`，并在 `CAPABILITY-GATE.md` 描述 fail-open 的 AI 基线和 fail-closed 的协作授权。
- [ ] 运行专项全套：

```bash
node scripts/test-collaboration-policy.mjs
node scripts/test-collaboration-idempotency.mjs
node scripts/test-collaboration-sync-engine.mjs
node scripts/test-collaboration-encryption.mjs
node scripts/test-collaboration-workspace-share.mjs
node scripts/test-collaboration-fault-matrix.mjs
node scripts/test-collaboration-capability-gate.mjs
```

- [ ] 运行项目全套：`npm run test:unit && npm run test:renderer && npm run test:runtime && npm run test:service && npm run test:skills && npm run test:capability-gate`。
- [ ] 在开发版执行双账号、双设备、两个 Team 的真实 Electron E2E：在线、离线 24 小时模拟、重连、编辑冲突、撤权、附件、工作空间导入。
- [ ] 部署顺序固定为：迁移 → server dark launch → 内部用户开文本 → 内部 Team → 附件 → 工作空间分享 → AI tools；每级至少观察一个完整业务周期。
- [ ] 回滚只关 signed feature policy，不回滚已应用数据库迁移、不删除本地密文缓存；验证关闭后旧 AI 工作台立即正常。
- [ ] 发布检查单逐条签字，尤其记录 PostgreSQL 故障注入、私有 bucket ACL、日志扫描、KEK 备份/轮换、对象补偿和真实延迟数据。
- [ ] README/发布文案明确写“服务端可授权解封的加密存储”，禁止使用端到端加密、绝对召回或实时共同编辑等超出实现边界的表述。
- [ ] 提交：`git commit -m "docs(collaboration): close release and rollback loop"`。

## 最终完成定义

只有以下证据同时存在，才可把“实现完成”标记为真：

- Task 1–22 的复选项全部完成且没有未记录的跳过。
- 设计文档 §19 的 19 条发布验收全部有自动化或明确的实机证据。
- commit 后 ACK 丢失、bootstrap 并发写、sync page 重放、多设备压缩、dispatcher 停止和撤权竞态均由故障注入证明无静默丢消息。
- 同一幂等键不同正文被拒绝；同一正文的无限网络重放只形成一个可见 message/event。
- UI 最终顺序完全来自 server seq；乐观顺序变化不产生重复气泡或不可解释跳动。
- 私有 bucket 中抽样对象均为 `LILYENC1` 密文；数据库、日志和 Renderer 快照没有 DEK、token、签名 URL 或本地绝对路径。
- 协作功能关闭、初始化失败和服务端不可达时，现有 AI 工作台全量 Capability Gate 通过。
- 真实双客户端完成工作空间发送、发送方离线、接收方下载、校验、隔离导入和打开新工作空间。
- 发布/回滚/密钥轮换/对象补偿 runbook 经至少一次演练，而不是只存在文档。
