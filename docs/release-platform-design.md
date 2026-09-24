# 版本发布平台设计

> 状态：设计稿（2026-09-24）。目标：把“发一个版本”从“往一张表里插一行 + 覆盖一个文件”变成有状态、可灰度、可中止、可观测的发布单。
> 前置：强制升级（`update-enforcement` 门禁）、按提交部署（`server-deploy-from-commit`）、`--mandatory` 与 `--force` 分离，均已上线。

## 1. 现状与问题（实测）

| 现状 | 证据 | 问题 |
|---|---|---|
| 一个版本 = `releases` 表一行（version, platform, url, sha256, `force_update`, `enabled`） | `server/migrations/001_initial.sql` | 没有状态：只有“有/没有”，没有“推给多少人”“已暂停”“有问题” |
| 自动更新源是**每平台一个可变文件** `auto-updates/<platform>/stable/latest(-mac).yml`，发布即覆盖 | `scripts/release-one-click.mjs:629`；CDN 缓存一年，每次需刷新 | 一发即全量；无法灰度；出问题只能再覆盖一次 |
| 客户端从服务端 `/api/releases/latest` 拿 `feedUrl`，**所有版本都这样**（含 0.1.18） | `src/main/update-manager.js` checkServiceUpdates；`db608337` 同样 | ✅ 利好：服务端决定 feedUrl，就能决定每台设备看到哪个版本 |
| 客户端同时读静态签名清单 `app/updates/latest.json`，取两者中较新的 | `preferNewerUpdate` | 静态清单若领先于灰度，会绕过灰度 |
| 强制 = 单个版本上的开关，是下限 | `release-versions.js requiredVersionFor` | “最低支持版本”藏在某个版本行上，不直观；无“拉黑某版本” |
| 版本健康靠人看诊断页 | `runtime_diagnostics.app_version` 已有 | 新版本错误率变差没人知道，也不会自动停 |
| 旧安装包永远挂在七牛 | 0.1.18 的 dmg/exe 仍 200，9 月仍有 27 台新装 | 旧版本持续流入 |
| 发布参数有歧义 | `--force` 曾同时表示“覆盖目录”和“强制更新”，误标 20 个版本 | 强制这种决定没有显式确认 |

## 2. 目标模型

四个概念，各管一件事，互不借用：

1. **发布单（Rollout）**：某平台某版本的发布过程，有状态和放量比例。
2. **渠道（Channel）**：`stable` / `beta`（后续可加 `canary`）。设备属于某渠道，渠道决定能看到哪些发布单。
3. **支持策略（Support policy）**：每个 渠道×平台 一个“最低支持版本”（下限）和“拉黑版本”列表。强制升级只从这里来。
4. **健康（Health）**：每个版本的错误率 / 活跃设备，对比上一版本，给发布单打分，可自动暂停。

### 2.1 发布单状态机

```
draft ──start──▶ rolling(p%) ──raise──▶ rolling(q%) ──complete──▶ complete
                    │  ▲                                     │
                  pause resume                             supersede（被更新版本取代）
                    ▼  │
                  paused ──halt──▶ halted（中止：不再推送，已装的不受影响）
                                      │
                                   revoke（拉黑：已装的必须离开，见 2.3）
```

- 放量比例 `percent` 取值 1–100。**只升不降**（降比例不会把已装的人拿回去，语义不清，用 pause/halt 表达）。
- 同一 渠道×平台 同一时刻最多一个 `rolling` 发布单；开始新的会要求先 complete 或 halt 旧的。
- 每次状态变化写审计日志（谁、何时、从什么到什么、理由）。

### 2.2 谁拿到哪个版本（服务端唯一决策点）

`/api/releases/latest?platform&version`（请求已带 `X-Lily-Device-Id`）改为：

```
offered = 该设备所在渠道×平台中：
  最高的 complete 版本
  以及 rolling 版本（若 bucket(rolloutId, deviceId) < percent）
  取两者较高者；halted/revoked 的永不提供
```

- `bucket = sha256(rolloutId + ":" + deviceId) % 100`，与下发规则 `rolloutAllows` 同一算法（抽成共享函数）。按发布单 ID 取哈希，所以每次发布抽中的是不同的那一部分人，不会总是同一批人当“小白鼠”。
- 没有设备 ID 的请求（极老版本/匿名）：只给 complete 版本。
- 返回的 `feedUrl` 指向**该版本自己的不可变更新文件**：`auto-updates/<platform>/releases/<version>/latest(-mac).yml`。不再指向可变的 `stable/`。
  - 因为所有现存客户端都从服务端拿 feedUrl，**灰度对老客户端立即生效**，无需先发客户端。
  - 不可变路径 = 可以长缓存，不再需要每次刷 CDN。
- `stable/latest.yml` 与静态签名清单 `latest.json` 只在发布单 **complete** 时推进（它们是“全量版本”的兜底，给服务端不可达的客户端用）。这样静态兜底永远不会领先于灰度。

### 2.3 支持策略：最低支持版本 与 拉黑

新表 `release_support`（渠道×平台 一行）：`min_supported_version`、`blocked_versions[]`、`mandate_deadline`（可选）、`updated_by/at`。

客户端必须升级的条件（服务端算好随 `/api/releases/latest` 返回 `requiredVersion` + `reason`）：

- 当前版本 < `min_supported_version`（reason=`below_minimum`）；或
- 当前版本 ∈ `blocked_versions`（reason=`blocked`，目标 = 当前 offered 版本）；
- 再与下发规则里的 `policy.minAppVersion`（按范围）取高（客户端已有，`update-enforcement.js`）。

`releases.force_update` 退役：迁移时把“最高的强制版本”写入 `min_supported_version`（今天已全部清零，迁移为空）。版本页的“设为强制”改为“把最低支持版本设为此版本”，一个概念一个入口。

**限期**：`mandate_deadline` 之前按现有策略（倒计时 + 有限推迟）；过了截止时间推迟次数归零（仍等任务结束，仍不锁死）。企业客户更需要“X 日前完成”而不是“推迟 3 次”。

**不锁死不变量**（沿用）：没有可装版本到达下限、安装方式不能自更新、下载失败 → 只提示 + 手动下载。

### 2.4 渠道

- 设备渠道来源：下发规则（按分组/授权/设备），新增配置键 `policy.updateChannel`，默认 `stable`。复用已有的范围与合并逻辑，不另造一套分组。
- `beta` 渠道看到 `stable` 的全部 + 自己的发布单。内部同事、愿意尝鲜的客户放 beta。

### 2.5 健康与自动暂停

每个 rolling 发布单，每 15 分钟计算（服务端定时任务，结果存表以便趋势展示）：

- 分母：该版本过去 24h 活跃设备数（`devices.app_version` + `last_seen_at`）。
- 分子：该版本过去 24h `runtime_diagnostics`（severity=error，排除 `objective_coverage_unavailable` 这类非用户可见的内部告警——排除清单是配置，不写死）。
- 指标：每活跃设备错误数；Top 错误类型的增量。
- 对比：同平台上一个 complete 版本的同指标。
- 门槛（发布单上可配，给默认值）：活跃设备 ≥ N（默认 20）才判；比上一版差 ≥ X 倍（默认 1.5）→ 状态 `paused` + 通知（仪表盘“需要处理”+ 审计）。**第一期只告警不自动暂停**，第二期打开自动暂停。

### 2.6 升级漏斗（客户端上报）

客户端在 `update-manager` 状态变化时上报轻量事件（已有 `/api/diagnostics/runtime-traces` 通道，eventType=`update`）：`offered → download_started → downloaded → install_started → running_new_version`，失败带错误码。仪表盘每个发布单显示漏斗，能看到“卡在下载”（CDN/网络）还是“卡在安装”（签名、权限）。

### 2.7 安装包生命周期

- 发布单 `halted/revoked` 或被取代超过 N 天（默认 30）后，**官网与服务端不再提供**其安装包地址；七牛对象移到 `archive/` 前缀（可恢复，不删除）。
- 这解决 0.1.18 这类“旧直链一直有人装”：旧直链失效后，用户只能从官网拿到当前版本。
- 这一步涉及外部存储，执行前在后台列出将归档的对象并二次确认。

### 2.8 发布流程与脚本

- `release-one-click` 默认行为不变：缺省 `--rollout 100`，即立即全量（与今天一致）；`--rollout 10` 表示以 10% 开始灰度，`--draft` 只创建草稿不放量。`--mandatory` 改为“同时把最低支持版本设为此版本”，需要 `--confirm-mandatory` 或后台确认，避免再出现 `--force` 式事故。
- 每次发布都上传不可变的 `releases/<version>/` feed；`stable/` 与静态清单只在全量时写入：`--rollout 100` 发布时直接写，灰度完成后由 `release-promote.mjs` 在确认服务端已 complete 后写入。

## 3. 后台界面

版本页从“一张 415 行的表”改为“发布单”视图：

- 顶部：每个 渠道×平台 一张卡：当前全量版本、正在灰度的版本和比例、最低支持版本、低于下限的活跃设备数。
- 发布单详情：状态与操作按钮（开始 / 提高比例 / 暂停 / 继续 / 中止 / 拉黑 / 完成），每个都有二次确认说明后果；放量曲线（该版本活跃设备随时间）；健康对比（本版 vs 上一版）；升级漏斗。
- 历史版本表保留在下方（分页），作为明细。

## 4. 分期

| 期 | 内容 | 对现存客户端 | 验收 |
|---|---|---|---|
| **1** | 发布单表 + 状态机 + 服务端按设备分桶提供版本 + 不可变 feed 路径 + 静态兜底只在 complete 推进 + 后台发布单视图 + 健康对比（只展示） | 立即生效（都走服务端 feedUrl） | 本地真机：10% 桶内设备升级、桶外不升；halt 后不再提供；旧 `stable/` 未被灰度覆盖 |
| **2** | `release_support`（最低支持版本 / 拉黑 / 截止日期）替代 `force_update`；渠道 `policy.updateChannel` | 强制需新客户端；拉黑对新客户端生效 | 门禁：下限/拉黑/截止日期决策表 |
| **3** | 健康自动暂停；升级漏斗上报与展示 | 漏斗需新客户端 | 模拟错误率上升 → 自动 paused + 告警 |
| **4** | 安装包归档；旧客户端网关升级提示（前文方案，默认关，按范围开） | 旧客户端可触达 | 真机旧版本收到升级提示回复 |

## 5. 不变量与门禁（每期都要有）

- **单一决策点**：设备得到哪个版本、是否必须升级，只在服务端一个模块决定（扩展现有 `release-versions.js`），更新接口、后台、仪表盘都读它。
- **静态兜底不领先**：`stable/latest.yml`、`latest.json` 的版本 ≤ 最高 complete 版本（门禁检查发布脚本与推进步骤）。
- **比例只升不降**，halt/revoke 不可被“提高比例”绕过。
- **不锁死**：任何失败路径退化为提示 + 手动下载（沿用 `update-enforcement`）。
- **可逆**：halt 可恢复为 paused；归档对象可恢复；每次操作有审计。
- **能力不退化**：第 1 期上线时若发布单表为空，行为与今天完全一致（最高 enabled 版本即全量）。

## 6. 风险

- **macOS 自动更新需要签名 + 公证**：否则 Squirrel.Mac 不接受更新，灰度也只能提示手动下载。需确认当前 mac 包签名状态。
- **CDN 缓存**：不可变路径解决新文件，但现有 `stable/` 仍有一年缓存，推进时仍需刷新（沿用 `scripts/qiniu-ipv4-admin.mjs`）。
- **设备 ID 不稳**（0.1.18 同机多 ID）：分桶会让同一台机器在重装后换桶，影响很小，可接受。
- **诊断口径**：错误率受诊断上报版本差异影响（老版本不上报诊断），对比只在“同样上报诊断的版本之间”进行。

## 7. 待决定

1. `beta` 渠道第一批放谁（内部授权？指定企业？）。
2. 默认灰度节奏：建议 10% → 50% → 100%，每档至少 24 小时且健康通过。
3. 旧安装包归档的天数（建议 30 天）。
4. 第 1 期是否同时做“后台完成发布”按钮直接推进 `stable/`，还是仍由发布脚本推进。

## 8. 实施计划（2026-09-24 定）

**硬约束：不影响平台核心能力。**没有发布单的版本按今天的规则处理（启用即全量）；发布脚本默认行为不变（`--rollout` 缺省 = 100 = 立即全量，与今天一致）；外部存储操作与旧客户端拦截默认关闭。每期单独提交、部署、线上验证。

实现要点（由代码核实）：
- 安装包文件名含版本号、不会被覆盖，唯一可变的是 `stable/latest(-mac).yml`。不可变 feed = `auto-updates/<platform>/releases/<version>/latest(-mac).yml`，其中 `url/path` 写**绝对地址**指回 `stable/` 下的同一安装包，不复制大文件（electron-updater 的 `newUrlFromBase` 对绝对地址直接采用，已验证）。
- 静态签名清单需要发布机私钥，服务端不能签；“推进静态兜底”只能由发布机脚本执行，且脚本先向服务端确认该版本已 complete。兜底落后于灰度是安全的，领先才危险。
- 迁移编号用 `056`（`055` 已被另一路未提交的迁移占用）。

| 期 | 服务端 | 发布脚本 | 客户端 | 后台 |
|---|---|---|---|---|
| 1 | `releases.immutable_feed`、`release_rollouts`；`rollout-bucket.js`（与下发规则共用）；`release-offer.js` 单一决策点；状态机；更新接口按设备提供 | 始终上传不可变 feed；`--rollout N`/`--draft`；只有全量才写 `stable/` 与静态清单；`release-promote.mjs` | 无需改动 | 每平台卡片（全量/灰度/比例/已升级设备）+ 发布单操作 + 健康对比（只展示） |
| 2 | `release_support`（最低支持/拉黑/截止）替代 `force_update`；渠道由服务端按设备所在范围解析 `policy.updateChannel` | `--mandatory` 改为设最低支持版本（需确认） | `update-enforcement` 支持截止日期 | 支持策略编辑、渠道 |
| 3 | 健康快照与自动暂停（可关）；升级漏斗聚合 | — | 上报升级漏斗事件 | 健康曲线、漏斗 |
| 4 | 旧安装包归档（预览+确认）；网关旧客户端升级提示（默认关，按范围开） | — | — | 归档与拦截开关 |
