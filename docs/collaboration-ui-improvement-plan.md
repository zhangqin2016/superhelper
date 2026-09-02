# 协作中心（IM）UI 体验改进方案

> 状态：待评审 · 目标：把"能收发"的半成品，补成"呈现已有能力"的可用 IM。
> 范围：`src/renderer/modules/collaboration-*.js`、`src/renderer/styles/collaboration.css`、
> `src/renderer/index.html`（协作面板 DOM）、`src/renderer/i18n/locales/*.json`（文案）、
> 必要时 `src/preload.js` + `src/main/ipc-collaboration.js`（新增头像对象 IPC）。

## 目的

协作中心（顶部"协作"入口，即 IM 功能）的功能骨架是完整的：收件箱/联系人/团队三栏、
私聊/群聊/频道、@提醒、附件加密传输、撤回/编辑的数据模型、已读水位、好友/团队/频道
权限模型全部已在主进程实现。但**渲染层只接上了"能收发消息"这一半**，身份展示、
空状态引导、可发现性，乃至"后端已写好但前端没接"的动作（消息编辑/撤回、未读角标、
搜索）全部缺失。结果是：界面到处是原始 `usr_` ID、开发者术语、死胡同空状态和无意义
的字母头像——"比 demo 都差"不是差在功能，是差在**没把已经做好的东西呈现出来**。

本方案的北极星：

1. 列表/成员/提及里**永不裸显 `usr_` 内部 ID**，头像至少是"有意义"的。
2. 界面文案说人话，不出现"精确用户标识 / 缓存 / 组织设置"等内部术语。
3. 每个空状态都有明确的下一步动作，不把用户丢进死胡同。
4. 所有动作对鼠标、键盘、触屏都可达（不能 hover 才可见）。
5. 后端已具备的能力（编辑/撤回/未读/搜索）必须在 UI 上可用。

## 现状诊断（按层，附源码依据）

### L0 · 身份与头像（最伤）

- 无昵称/无 Lily ID 时显示 `usr_xxx · usr_xxx`，同一串内部 ID 出现两遍。
  来源：`social-ui.js:29` `socialPerson()`、`teams.js:111`、`friends.js:43` 均为
  `displayName || lilyId || userId` 一路兜底到 `userId`。
- 头像完全没接：每个 profile 数据里都有 `avatarObjectId`
  （`src/main/collaboration/directory-projection.js:15`、`collaboration-store.js:464`），
  但渲染层从头到尾没用它；且 **preload 未暴露任何取头像对象的 IPC**
  （`preload.js:451-490` 无 avatar/object 接口）。结果头像永远取首字母 → 所有
  `usr_` 用户都是同一个 "U"。
- @候选人同样漏身份（`mentions.js:23`）。

### L1 · 文案术语泄漏

- `成员（精确用户标识）`、`完整 Lily ID`、`我的 Lily ID`
  （`zh-CN.json` `social.members` / `exactLilyId` / `myLilyId`）。
- `暂无缓存的团队成员关系。请在现有组织设置中管理团队。`（`noTeams`）——"缓存"、
  "组织设置"是内部概念，且下文是死胡同。
- 送达态一整套黑话：`送达结果未知，请重试或同步`、`密文已上传，等待验证`、
  `已绑定消息`（`transfer.*` 全家族）。

### L2 · 空状态与引导

- 团队空状态只有一行 `<p>`，无任何入口（`teams.js:104`）。
- 收件箱空状态"选择一个对话开始协作"无下一步 CTA。
- 联系人空状态"还没有联系人"无引导。

### L3 · 可发现性

- 操作按钮 `opacity:0` 直到 hover（`collaboration.css:997`）——触屏/键盘不可达。
- "创建个人群 / 发送好友申请 / 创建频道"全用 `<details>/<summary>` 折叠
  （`social-ui.js:14` `socialDisclosure`），视觉像链接、用完即收。
- 成员管理埋在会话行一个"members"图标里，路径不直观。

### L4 · 后端有、前端没接的核心能力（优先补）

- 消息编辑/撤回 UI 完全缺失：后端有 `collaboration:edit`、`collaboration:revoke`
  （`preload.js:475,478`）、`getEditDraft/saveEditDraft`，但 timeline 只渲染
  "回复"和"下载附件"两个动作（`timeline.js:133`），没有编辑/撤回按钮。
- 未读角标是死代码：`collaborationUnreadBadge`（`index.html:174`）定义了，
  `collaboration-center.js` 从未更新它——顶部"协作"按钮永远不显示未读数。
- 没有搜索：收件箱/联系人/团队三栏全无搜索过滤。
- 没有在线状态 / 正在输入：presence/typing 完全缺失。
- 媒体无缩略图：附件只有"下载并验证附件"文字按钮，无图片/文件预览。

### L5 · 消息流体验

- 无日期分隔（今天/昨天），只有单条时间戳（`timeline.js:108-114`）。
- @提及只在气泡下加小字"提及你"，正文里 @名字 没有内联高亮。
- 链接不可点、纯文本无富文本。
- 消息动作按钮绝对定位在气泡上方，滚动到顶会溢出裁剪。
- 送达/已读只有小字文本，无 ✓✓ 直观图标。

### L6 · 视觉与一致性

- 发送按钮/气泡用 WhatsApp 绿 `#25d366`，与应用 accent 冲突
  （`collaboration.css:13,15`）。
- 深色模式 outgoing 绿底白字对比度存疑。
- docked 侧栏与主聊天区并存，视觉上"两个聊天"打架。

### L7 · 无障碍

- 内联确认框 `role=alertdialog` 无焦点陷阱。
- Enter 发送无"Shift+Enter 换行"提示。
- hover-only 动作对键盘/触屏不可达（与 L3 同源）。

## 改动计划（分四阶段，每阶段独立可验证）

### M1 · 止血：身份 + 文案（纯渲染层，低风险）

| 项 | 改动 | 文件 |
|---|---|---|
| 身份兜底 | 新增统一的 `displayName(person)`：有昵称用昵称；无昵称但有 Lily ID 用 Lily ID；都无则「成员 + 短 ID 尾号」友好占位，永不裸显 `usr_...` | `social-ui.js`、`teams.js`、`friends.js`、`inbox.js`、`mentions.js`、`timeline.js` |
| 头像 | 确定性彩色字母头像：从 userId 哈希选色 + 取昵称/ID 首字母，替代"一律 U" | `social-ui.js`、`collaboration.css` |
| 文案 | 去术语：`成员（精确用户标识）`→`成员`；`完整 Lily ID`→`对方 Lily ID`；`noTeams` 改人话并带入口 | `zh-CN.json` + `ar/en` 同步 |
| 送达态文案 | `送达结果未知…`→`发送中/已发送/失败`三态人话 | `zh-CN.json` |

验证：空昵称成员不再显示 `usr_`；三语言下无"缓存/精确标识"字眼。

### M2 · 补上"后端已写好但前端没接"的缺口（核心价值最大）

| 项 | 改动 | 文件 |
|---|---|---|
| 消息编辑/撤回 | timeline 动作区加"编辑""撤回"（仅自己的消息）；编辑走 `saveEditDraft`/`edit`，撤回走 `revoke`；撤回后气泡显示"消息已撤回"（`messageRevoked` 已存在） | `timeline.js`、`center.js`、`zh-CN.json` |
| 未读角标 | `load()` 聚合 `conversation.unreadCount` 更新 `collaborationUnreadBadge`；进会话 `markRead` 清零 | `center.js` |
| 搜索 | 收件箱/联系人/团队各加过滤输入框，前端本地过滤（数据已在内存） | `inbox.js`、`friends.js`、`teams.js` |
| 空状态引导 | 团队页加"邀请成员/创建团队"入口；收件箱空态加"发消息/加好友/建群"引导 | `teams.js`、`inbox.js` |

验证：自己的消息能撤回并显示占位；顶部角标显示未读数；输入关键字能过滤列表。

### M3 · 交互与消息流体验

| 项 | 改动 | 文件 |
|---|---|---|
| 操作常显 | 动作按钮改为常显（低对比）或至少触屏/键盘可达，hover 仅增强 | `collaboration.css` |
| 折叠改表单 | "创建个人群/加好友/建频道"从 `<details>` 改为显式主按钮 + 弹层/内联表单 | `social-ui.js`、`teams.js`、`friends.js` |
| 日期分隔 | 消息流加"今天/昨天/日期"分隔条 | `timeline.js` |
| @内联高亮 | 正文里高亮被提及的名字 | `timeline.js` |
| 送达图标 | 用 ✓/✓✓ 替换纯文本送达态 | `timeline.js`、`css` |

验证：键盘 Tab 能到所有操作；消息流出现日期分隔；@名字有高亮。

### M4 · 真实头像 + 视觉收口（含后端）

| 项 | 改动 | 文件 |
|---|---|---|
| 真实头像 | 新增 `collaboration:get-avatar-object` IPC（读 `avatarObjectId` → 本地/远端对象 → data URL/路径）；渲染层 `<img>` 显示，失败回退 M1 的字母头像 | `preload.js`、`ipc-collaboration.js`、新增 main 侧读取 + renderer 头像组件 |
| 品牌色 | 去掉 WhatsApp 绿，改用应用 accent 作为发送色，深色模式重调对比度 | `collaboration.css` |
| 无障碍 | 确认框加焦点陷阱；发送框加"Enter 发送 / Shift+Enter 换行"提示 | `social-ui.js`、`index.html` |

## 待决策项

1. 头像优先级：M1 用"确定性彩色字母头像"顶住，真实头像（需后端 IPC）放 M4。是否认可？
2. 在线状态 / 正在输入：纯新增能力，后端目前无 presence 通道，建议本版不做。是否认可？
3. 品牌色：去掉 WhatsApp 绿、跟随应用 accent，还是保留独立绿色作"协作"视觉识别？
   倾向前者（一致性）。
4. 建议首轮只做 M1 + M2，跑通验证后再决定是否继续 M3、M4。

## 验证标准

- 空昵称成员不出现 `usr_` 原始 ID；头像为确定性彩色字母（非清一色 "U"）。
- 自己的消息可编辑/撤回，撤回后显示占位文案。
- 顶部"协作"角标显示未读总数，进会话后清零。
- 三栏支持关键字过滤；每个空状态都有可点击的下一步。
- 动作按钮键盘/触屏可达（无 hover-only）。
- 文案三语言（zh-CN / en / ar）无内部术语泄漏。

---

## 差距分析 vs 顶级 IM（补充）

### 三层全栈成熟度

| 层 | 现状 | 成熟度 | 是否重构 |
|---|---|---|---|
| Server 后端 | `sync-service` + `realtime-gateway/dispatcher` + `message-crypto` + `object-store` + `receipt-view`（已读回执）+ `ws-ticket`（WS 票据）+ `team-scopes`；迁移 032-040 | 高 | 不重构，是资产 |
| Electron 主进程 | `client.js`（token 不出主进程）+ `sync-engine` + 幂等 `outbox` + 加密 `transfer-manager` + `directory-projection` + `read-checkpoint`；schema 16 次迁移 | 高 | 不重构，是资产 |
| 渲染层 | 13 个 `collaboration-*.js` 手写 DOM，无状态层、无组件、无虚拟列表、无设计 token、字母头像、死角标、hover-only | 低 | **重点重构** |

结论：加密、同步、幂等、离线、已读回执等"难的部分"早已完成；"简单的部分"（列表、
头像、编辑/撤回按钮、未读角标、搜索框）没做或没接。典型的"引擎很强、门面很糙"。

### 能力矩阵（按消费级 IM 公共基线逐项对）

| 能力 | 顶级基线 | 我们 | 差距类型 |
|---|---|---|---|
| 真实头像 | 处处头像 | 字母头像；`avatarObjectId` 数据有但没接、无 IPC | 缺 |
| 身份名 | 显示名/昵称 | 裸 `usr_` ID 两遍 | 坏 |
| 在线/输入状态 | presence + typing | 无（server 有 WS 基础设施可扩展，但无 presence 功能） | 缺 |
| 消息编辑/撤回 | 悬浮/长按即得 | 后端 `edit`/`revoke` 在，UI 没接 | 断线 |
| 已读回执 | ✓✓ / 已读 | server `receipt-view` 有，UI 只显示文字 | 断线 |
| 未读角标 | 全局 + 会话级 | 角标 DOM 在，`center.js` 从不更新 | 断线 |
| 搜索 | 全局 + 会话内 | 无 | 缺 |
| 富媒体预览 | 图片/文件缩略图 | 只有"下载并验证附件"文字按钮 | 缺 |
| 表情回应 | reaction | 无（全栈无） | 缺 |
| 引用/回复 | 气泡内引用 | 有，但 hover 才出现、溢出裁剪 | 半 |
| 日期分隔 | 今天/昨天 | 无 | 缺 |
| 通知中心 | 系统通知 + 汇总 | 无 | 缺 |
| 虚拟列表 | 万级消息流畅 | 全量 DOM 重渲 | 性能隐患 |

关键洞察：**"断线"类是性价比最高的修复**（edit/revoke、已读回执、未读角标三项，后端
数据已就绪，纯渲染层补丁即可上线）；**"缺"类**（presence/typing/reaction/全局搜索/
富媒体预览/通知）要动 server + 主进程 + 渲染三层，是真正的硬骨头。

### 渲染层差的根因

1. 无状态层：`collaboration-center.js` 里 `directory`/`historyMessages`/
   `activeConversationId` 都是闭包散变量，靠 `generation`/`epoch` 手工防竞态。
2. 无组件/设计系统：各模块各自 `document.createElement`，`socialAvatar`/
   `socialButton` 是最原始原语，无 MessageRow/Avatar 等可复用组件。
3. 无虚拟列表：`renderCollaborationTimeline` 全量 DOM 重建（`timeline.js`）。
4. 能力漏接：edit/revoke/receipt/unread/avatar 的数据与 IPC 都在，渲染层未消费。

## 重构路线（补充）

### 三层推进（不重写引擎）

1. **渲染层地基**：轻量 view-model/store（对齐主进程 store 风格）；抽组件
   （`Avatar`、`IdentityName`、`MessageRow`、`ConversationRow`、`EmptyState`、
   `SearchField`、`ActionMenu`）；虚拟列表；设计 token 收口（去 WhatsApp 绿）。
2. **能力接线（快速回血）**：edit/revoke、已读回执 ✓✓、未读角标、头像对象 IPC、
   本地搜索、空状态引导、操作常显。
3. **补齐缺失能力（真正追平）**：presence、typing、reaction、会话内+全局搜索
   （SQLite FTS5）、富媒体缩略图、通知中心——按依赖排序，不并排乱开。

### 里程碑路线图

| 里程碑 | 内容 | 类型 | 依赖 |
|---|---|---|---|
| M0 | 渲染层地基：store + 组件 + token + 虚拟列表 | 重构 | — |
| M1 | 止血+接线：身份/头像/文案 + edit/revoke/已读回执/未读角标/本地搜索 | 回血 | M0 |
| M2 | 会话内搜索 → 全局搜索（FTS5） | 能力 | M1 |
| M3 | 富媒体缩略图预览 | 能力 | M1 |
| M4 | 在线状态 + 正在输入（复用 server WS 通道） | 能力 | M2 |
| M5 | 表情回应 + 通知中心 | 能力 | M4 |

### 与上文"改动计划 M1-M4"的关系

上文"改动计划"是战术级修复序列，本"重构路线"是战略级骨架。对应关系：

- 重构 M0（渲染地基）是新增前置项，先立骨架再做功能。
- 重构 M1 ≈ 上文 M1（止血）+ M2（接线）合并。
- 重构 M2-M5 ≈ 上文 M3-M4 的扩展 + 新增能力层（presence/reaction/全局搜索/通知）。

### 关键决策

1. 渲染层引不引框架：建议**不引**，手写 + 轻 store 已够，引框架破坏既有风格。
2. IM 是侧栏还是全屏 surface：决定导航模型（docked 侧栏 vs 独立三栏 surface）。
3. presence/reaction 是否上：依赖 server 改动（server 是自有的，`realtime-gateway`
   已具备 WS 通道，但 presence/reaction 功能未实现），属 M4/M5 硬骨头。
4. 全局搜索用 FTS5 还是先内存过滤：FTS5 需加迁移，内存过滤可立刻上。

建议先做 M0 + M1：先把渲染层骨架立起来，再把"后端已做完但没接"的 edit/revoke、
已读回执、未读角标、头像接上线——一行引擎/后端代码都不用动，即可从"能发消息的壳"
变成"有身份、有反馈、有未读、能撤回"的真 IM。

### 执行记录（2026-09-02，全栈追平轮的实测结论）

**已落地（渲染层，零后端风险，测试全绿）**
- M1 日期分隔条（Telegram 式胶囊：今天/昨天/日期）+ 送达态图标（pending 转圈 / delivered ✓ /
  error ✕，图标为 CSS 伪元素，文字留 DOM 保可访问性与翻译安全）+ 连续气泡分组收口 +
  时间戳 hover 底色。DOM 测试 11/11 通过；`output/m1-preview.png` 为真实渲染截图。
- M3 媒体预览：主进程 `resolveTransferPreview`（transfer-manager.plaintextFile → 仅
  direction=download & state=ready & guard/assertAuthorized 放行 → transfer-ipc 脱敏为
  `app-file://` URL，绝对路径永不进渲染层）→ preload `resolveTransferPreview` → 附件列表
  ready 项「预览」按钮 → `openImageViewer`。防回归测试 `test-collaboration-download-preview.mjs`。

**协议阻断（有源头才能做，否则是死代码；本轮实测确认源头缺失）**
- M2 真实头像：server 对象 purpose 仅 `attachment|workspace`，无 avatar 上传/分发通道；
  `avatar_object_id` 仅是同步透传字段。接入前提：server 新增 avatar purpose + 上传入口 +
  可见性授权。渲染层 data 面已含 avatarObjectId，只等源头。
- M4 presence/typing：server realtime-gateway 能转发 typing/presence 帧，但 outbound
  不含 sender 身份（收端无法显示"谁在输入/谁在线"），且客户端 realtime-client 无收发链路。
  接入前提：server 协议注入 origin user + 客户端发送节流 + service/IPC 分发 + 渲染层展示。
