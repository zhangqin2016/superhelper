# 智能体管理（Agent Management）设计分析

> 状态：**已实施（2026-09-14，feat/opencode-engine 未提交）** — 见文末「实施状态」
> 日期：2026-09-14
> 关联：`src/main/character-worlds/`、`src/main/skill-manager.js`、`src/main/workspace-share.js`、`server/migrations/014_skill_packages.sql`、`CONFIG-DISTRIBUTION-PLAN.md`、`memory/config-delivery-scopes.md`、`memory/no-ui-natural-language.md`

## 0. 一句话结论

Lily 不需要再造一个"智能体系统"。智能体所需的 7 个维度（人设指令、技能、模型、工具、自主度、知识、定时）在代码里都已存在，只是各自独立、作用域不一。要做的是：**用一个宿主拥有的"智能体定义"把它们绑成一卷，激活时逐维调用现有 setter，再复用技能包 registry + config profile 六级 scope 做分发。**

## 1. ChatGPT 是怎么做的

### 1.1 GPTs（2023 年 11 月起，个人用户）

一个 GPT 是一个打包：

| 元素 | 内容 |
|---|---|
| 名称 / 描述 / 头像 | 目录展示 |
| Instructions | 系统提示：角色、语气、行为规则、边界 |
| 对话开场白 | 若干建议问题 |
| Knowledge | 上传文件，2026 年初上限 20 个（PDF/TXT/DOCX/CSV/JSON 等） |
| Capabilities | 联网、生图、代码解释器（数据分析）、画布 |
| Actions | OpenAPI schema 接外部 API，带鉴权 |
| 分享 | 仅自己 / 链接可见 / GPT Store 公开；企业版可限工作区内 |
| 使用 | 侧栏入口；聊天里 `@` 某个 GPT 临时切换 |

创建方式：GPT Builder。先"Create"页对话式起草（跟 builder 描述想要什么，它写好指令和开场白），再"Configure"页表单微调。

### 1.2 Workspace Agents（2026 年 4 月，Business / Enterprise / Edu）

OpenAI 明确定位为 GPTs 的继任者，企业版 GPTs 将在未定日期强制迁移；个人 GPTs 保留。相比 GPTs 多出四类东西：

1. **长时间运行**：多步工作流，跨会话、跨天持续，可写入外部系统（Slack、Salesforce、Drive、Notion、Atlassian、Microsoft）。
2. **触发器**：人触发、定时触发、API 触发（bearer token 从后端触发已发布的智能体）。
3. **记忆**：跨次运行的持久状态，按用户隔离。
4. **治理**：
   - 管理员按角色控制成员能否 **浏览/运行**、**构建**、**发布到工作区目录**；
   - Connector Registry 统一管连接器与可用动作（含只读 / 读写粒度）；
   - 写操作默认 "Always ask"（人工批准）；
   - 鉴权分"终端用户身份"与"智能体自有账号"两种模式；
   - 可立即暂停某个智能体；合规 API 输出审计；
   - 企业工作区默认关闭，需管理员开启；按 credit 计费，工具越重越贵。

创建方式仍是**跟 builder 聊天**：描述任务、成功标准、约束，builder 生成分步工作流并引导接入连接器；发布前可测试。

### 1.3 对 Lily 有用的两个信号

- **可视化画布失败了。** OpenAI 2026 年 6 月宣布关停 AgentKit 里的拖拽式 Agent Builder（11 月 30 日下线），建议用 Agents SDK 或 Workspace Agents。面向普通用户，"对话式创建 + 少量配置项"胜过流程画布。这正是 Lily "不堆 UI、自然语言驱动"的立场。
- **方向是"数字同事"而非"聊天助手"。** 团队共享、可定时、可治理、有审计。Lily 已有企业组织、协作、定时任务、证据账本底座，这条路对 Lily 并不远。

### 1.4 明确不抄的

- 面向公众的 UGC 商店：服务端刻意不收用户内容（`server/src/services/character-worlds-policy.js:1-13`），且有 PHI 场景。
- 可视化流程画布：OpenAI 刚关停。
- OpenAPI Actions：Lily 的 MCP + 连接器 + 网页系统学习已是更强的等价物。

## 2. Lily 现状盘点（证据）

### 2.1 智能体的每个维度今天在哪

| 维度 | 作用域 | 存储 | 注入点 |
|---|---|---|---|
| 人设 / 指令（角色） | 每会话绑定 | sqlite `character_session_bindings`（`character-worlds/conversation-config-repository.js:44-60`） | `turn-orchestrator.js:1355` 编译 → `runtime/opencode-message-parts.js:420` `applyCharacterContextToBody` → 作为低权威后缀追加到每请求 `body.system`（`runtime/opencode-character-context.js:96-136`） |
| 技能集 | 每会话，回落全局 + 项目 | `session.enabledSkillIds`（`session-manager.js:918`），全局 `skills-state.json` | `resolveSessionSkillIds()` `skill-manager.js:203` → 每次发送重建 AGENT.md（`skill-manager.js:862`）→ `body.system` |
| 岗位包（skill presets） | **仅全局** | `skill-presets.js:50` | 无每会话路径 |
| 模型 | 每会话可覆盖 + 每轮路由 | `userData/model-selection.json`（`model-selection-catalog.js:14-31`） | `body.model`（`opencode-message-parts.js:420-422`）；provider 块变化 → 引擎重启（`opencode-agent-session.js:254-300`） |
| MCP / 工具 | **全局**，按技能过滤 | `userData/opencode-mcp.json`（`mcp-config.js:280`） | serve `config.mcp`（`opencode-config-builder.js:76`）；集合变化 → 回收引擎 |
| 连接器 | **全局** | `ipc-connectors.js:25-160` 全部无 scope | MCP env（`mcp-config.js:123-135`） |
| 自主度 / 权限模式 | 每会话 | `session.permissionModeId` | 宿主侧执行，热更（`opencode-agent-session.js:705-711`） |
| 知识 | 项目 = `{id,name,path}` | `projects.json`（`project-manager.js:284-294`）；learned conventions `learned-context.js:46` | 路径成 cwd；conventions 追加到指南（`skill-manager.js:876-882`） |
| 定时任务 | 每会话 / 每项目 | `scheduled-tasks.json`，任务 = `{prompt, scheduleText, originSessionId, projectId, permissionMode}`（`scheduled-tasks.js:141-170`） | 派回原会话执行（`automation-session.js`） |
| 引擎 agent 名单 | **全局常量** | `opencode-config-builder.js:19-30` | `body.agent` 恒为 `"build"` |

### 2.2 三个关键事实

**(a) 角色系统是最好的骨架，但刻意只做"声音层"。**
- 数据模型是 Character Card V2/V3（`card-parser.js:34-68`）：name、description、personality、scenario、firstMessage、systemPrompt、tags…全是叙事文本。**没有模型、工具、技能、知识、权限字段。**
- 工程质量很高：不可变修订 + `bindingVersion` CAS、owner scope 宿主侧派生、每轮 admitted snapshot、指纹化 + 预算化 + 受回执的注入、敌意导入加固、试聊（preview）先于绑定、`lily_character_draft` 让 agent 起草 + 人工批准（`agent-draft-tools.js:261`）、69 个官方角色三语。
- 角色激活契约（`role-activation-contract.js:78-90`）明确列出 tools / permissions / safety / code / paths / citations 是角色**永不可改**的领域。
- 全项目唯一的能力耦合是一处硬编码：`if (officialId === "lily-cn-legal-counsel")` 触发法律知识包下载（`legal-kb/legal-kb-character.js:5-19`）。
- 服务端刻意无库、默认关闭（签名 policy 仅 on/off + 最低客户端版本）；persona / world book 已被 `character-card-only.js:13-28` 产品级关闭。

**(b) 工作区包 `.lilyspace.zip` 已是半个"智能体包"。**
`workspace-share.js:380 exportWorkspacePack` 打包：工作区文件、learned conventions、`requiredSkills`、工作区技能、定时任务模板（导入默认暂停）、角色卡（`character-worlds/workspace-portability.js`）、应用清单（appId / version / publisher / requiredRuntimePacks）。缺的只是模型、工具白名单和一个统一入口。

**(c) 热路径与冷路径已经划清。**
- 热（下一条 prompt 生效，零重启）：整个 AGENT.md 指南（技能列表、工作区摘要、conventions、自主度块）、权限模式、每轮模型选择、角色上下文。
- 冷（重启引擎会话）：模型 provider 块、MCP 集合、serve 配置内任何东西（基础 prompt、steps、compaction、基础权限集）。serve 以整体配置签名为 key（`opencode-shared-server.js:526`），每个不同的 per-agent serve 配置都会 fork 一个 serve profile。

### 2.3 分发层已有的模板

- **技能包 registry**：`skill_packages` 表（`014_skill_packages.sql`），admin CRUD + Qiniu 上传 + sha256 + 渠道 + 版本 + 发布前质量门禁 `SKILL_QUALITY_GATE_FAILED` + 全量审计（`routes/admin/skill-packages.js`）；公开 `GET /api/skills/registry`（`routes/public/skills.js:17`）；客户端 `skill-manager.js:1216 fetchServiceRegistry` 拉取 + 缓存 + 剪枝。
- **config profile 六级 scope**：`global | group | license | device | user | organization`（`routes/admin/config-profiles.js:25`），`resolveEffectiveConfig` 按 priority 深合并、签名下发；`user` / `organization` 由账号 token 匹配。**客户端无需改动即可支持新 scope。**
- **媒体三层模板**（`CONFIG-DISTRIBUTION-PLAN.md`）：profile 里 `config.media = {providers:[...], default}` → 服务端 `resolveMediaSelection` 与可用集合求交、校验 default、fail-open → 客户端 `media-provider-settings.js` 老服务器返 null → admin 表单 MultiSelect + default radio。
- **企业组织**：`organizations` / `organization_members`（role: owner/admin/member，`028_enterprise_organizations.sql`），`roleAtLeast`，`x-lily-organization-id`，平台 admin 治理范围刻意收窄。
- **协作**：只传加密 workspace 包（`workspace_shares`、远程任务包），**没有"共享一个定义（会话/技能/智能体）"的概念**。

## 3. 方案

### 3.1 数据模型：智能体定义是宿主拥有的配置，不是提示词

在角色卡之上增加一层，沿用角色系统的不可变修订 + CAS 模式：

```jsonc
{
  "id": "agent_xxx", "version": 3,
  "name": "合同审查助手", "description": "…", "icon": "…",
  "publisher": { "kind": "official|org|user", "id": "…" },
  "scope": "personal|org|official",

  "role": { "characterRevisionId": "…" },      // 人设与指令：复用角色卡，不复制字段
  "starters": ["帮我审这份采购合同", "…"],       // 开场建议
  "skills": { "required": ["lily-doc-review"], "enabled": ["…"] },
  "knowledge": { "packRef": "…" | "workspacePath": "…", "indexOnActivate": true },
  "model": { "presetId": "…" | "inherit" },
  "tools": { "mcpAllow": ["…"], "connectors": ["…"], "disallow": ["…"] },
  "autonomy": { "permissionModeId": "…" },
  "automations": [ /* 定时任务模板，导入默认暂停 */ ]
}
```

**为什么这样切**：叙事文本（角色卡）依旧是低权威后缀；工具、权限、模型由宿主按定义在**配置层**设置。角色契约"角色不可改工具"不用推翻，改的是宿主。这保住了现有的安全不变量，也符合 Workspace Agents "写操作默认询问、权限由管理员而非提示词决定"的方向。

### 3.2 绑定到会话：激活即逐维调用现有 setter

- `sessions.json` 增加 `session.agentId`，与 `enabledSkillIds`、`permissionModeId` 并列；记录 admitted 的 agent revision，中途改定义不改写历史（同角色 snapshot 语义）。
- 激活顺序：角色 `set-binding` → 会话技能设置 → 模型选择 → 权限模式 → 打开 / 索引知识路径 → 挂载定时模板（暂停态）。
- **热维度**（指令、技能、自主度、知识摘要）零重启；**冷维度**（模型、MCP 白名单）只在**新建会话时**一次性完成，代价等同今天换模型，不在会话中途切换。
- 每个维度缺失或不可用都回落到今天的默认（技能缺 → 提示安装或降级；模型不可用 → inherit；MCP 不可用 → 现状），满足 `CAPABILITY-GATE.md`。
- `lite` 能力等级下：不加载定义里的 MCP 白名单与子代理相关项，只保留角色 + 技能 + 自主度（与现有 lite 收紧一致）。

### 3.3 创建与使用：对话式起草，库面复用

- `lily_character_draft` 扩展为 `lily_agent_draft`：用户说"做一个审合同的智能体"，agent 起草整份定义（含推荐技能 / 模型 / 自主度），走现有的 draft → 试聊 → 人工批准 → 绑定链路；不新增表单。
- 角色库 → 智能体库：分组沿用精选 / 行业 / 官方 / 我的 / 最近 / 归档；详情页增加"能力"区块（技能、模型、工具、自主度）作为只读观测，编辑仍走自然语言。
- 聊天里 `@智能体`：复用角色中途切换 + snapshot 机制，仅切热维度；冷维度不同则提示"新开会话"。
- 岗位包（skill presets）从"全局安装批"降级为"官方智能体的 skills.required 来源"，不再单独暴露。

### 3.4 分发四步，每步有现成模板

| 步 | 内容 | 模板 |
|---|---|---|
| P0 本地 | 定义导出 / 导入并入 `.lilyspace.zip`，新增 `.lilyspace/agent.json`；导入 = 逐维 reconcile（技能对照已安装、模型对照可用预设） | `workspace-share.js` + `workspace-portability.js` |
| P1 官方目录 | 内置官方智能体，随包分发。**法律顾问是第一个**：把 `legal-kb-character.js` 的硬编码泛化成 `knowledge.packRef` + `tools.mcpAllow: ["lily_legal_search"]` | `official-character-catalog.js` |
| P2 企业发布 | `047_agent_packages.sql`（镜像 `skill_packages`：agent_id / version / channel / enabled / publisher / definition jsonb / min_app_version / featured）；admin `routes/admin/agent-packages.js` + `/admin/agents` 页放**分发**分组与技能包并列；公开 `GET /api/agents/registry`；profile 里加 `config.agents = {available:[ids], default}`，服务端 fail-open 解析后自动继承六级 scope；企业 owner/admin 发布，成员按 `organization` scope 收到；客户端 `agent-manager.js` 镜像 `skill-manager.js` 的 registry 拉取 / 缓存 / 剪枝 | 技能包 registry + 媒体三层 + 企业角色 |
| P3 数字同事 | 智能体自带定时模板（已有）、写操作默认询问（复用权限模式）、跨次运行记忆（按 agentId 分区的 learned conventions / memory）、协作里"把智能体派给同事"（远程任务包已可承载） | 定时任务 + 协作远程任务 |

### 3.5 需要拍板的决策

1. **角色系统默认开启。** 服务端 policy 目前默认 disabled；智能体以它为骨架，必须先翻开（保留 `LILY_CHARACTER_WORLDS=0` kill switch）。
2. **限制 serve profile 分叉数。** 每个不同模型 / 工具集的智能体 fork 一个 serve 配置。建议：并发 distinct 配置上限（如 3），超出则只应用热维度并提示；鼓励官方智能体优先只用热维度。
3. **企业智能体谁能发布。** 建议对齐 Workspace Agents：org owner/admin 可发布到组织目录；member 只能建"我的"；平台 admin 只管开关 / 暂停 / 审计，不碰内容（与现有企业治理范围一致）。
4. **要不要做 P2P 分享。** 协作层今天只传加密包。第一版建议：个人智能体本地 + 导出文件；组织智能体走服务端发布。真正的"发给同事"放 P3。

### 3.6 不做的

面向公众的 UGC 商店、可视化流程画布、OpenAPI Actions（见 §1.4）。也不新增独立的"智能体设置面板"：观测走库 + 会话头部横幅，操作走自然语言（`memory/no-ui-natural-language.md`）。

## 4. 建议顺序

1. 数据模型 + 激活链路（3.1 / 3.2）+ 法律顾问泛化作为验证 + 能力门禁测试（激活失败 → 与今天完全相同）。
2. `lily_agent_draft` + 库面改名 + `@智能体`（3.3）。
3. `.lilyspace` 携带 `agent.json`（P0）。
4. `agent_packages` + `config.agents` + admin 页（P2）。
5. P3 按需。

## 5. 参考

- Introducing GPTs — https://openai.com/index/introducing-gpts/
- GPTs in ChatGPT (help center) — https://help.openai.com/en/articles/8554407-gpts-in-chatgpt
- ChatGPT Workspace Agents for Enterprise and Business — https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business
- Introducing workspace agents in ChatGPT — https://openai.com/index/introducing-workspace-agents-in-chatgpt/
- Workspace Agents (developers) — https://developers.openai.com/workspace-agents
- VentureBeat: Workspace Agents, a successor to custom GPTs — https://venturebeat.com/orchestration/openai-unveils-workspace-agents-a-successor-to-custom-gpts-for-enterprises-that-can-plug-directly-into-slack-salesforce-and-more
- Agent Builder (wind-down notice) — https://developers.openai.com/api/docs/guides/agent-builder
- Introducing AgentKit — https://openai.com/index/introducing-agentkit/

## 6. 实施状态（2026-09-14）

四个决策已按 §3.5 建议拍板：角色系统服务端默认开启（`CHARACTER_WORLDS_ENABLED` 默认 true，显式 `false` 关闭）；serve 分叉上限 3（`LILY_AGENT_SERVE_FORK_LIMIT`）；企业 owner/admin 发布；第一版不做 P2P 分享。

### 6.1 客户端（主进程）— `src/main/agents/`

| 模块 | 职责 |
|---|---|
| `constants.js` | 限额、维度热/冷分类、`LILY_AGENTS=0` 总开关、分叉上限 |
| `agent-definition.js` | 唯一校验入口 `normalizeAgentDefinition`（AGENT_DEFINITION_INVALID 带 field）、hash、hot/cold 判定、渲染安全投影 |
| `agent-repository.js` + `store/agent-schema-migration.js` | messages.db 四张表：`agent_entities` / 不可变 `agent_revisions` / `agent_session_bindings`（CAS）/ 追加式 `agent_binding_events`；`MessageStore.agents()` |
| `official-agent-catalog.js` | 9 个官方智能体三语；法律顾问把 `legal-kb-character.js` 的硬编码泛化为 `knowledge.packs` + `tools.mcpAllow` |
| `knowledge-packs.js` | 知识包注册表（首个 `legal-cn-enterprise`）；`legal-kb/turn-preparation.js` 已泛化为「角色规则 ∪ 智能体 packs」 |
| `agent-activation.js` | 逐维调用现有 setter；每维独立 fail-open 并写回执；冷维度受分叉预算；`previous` 快照精确还原 |
| `agent-guidance.js` + `session-agent-policy.js` | 热路径：AGENT.md 追加一段智能体指南（`skill-manager.setSessionGuideExtension`）；运行时策略读取（`ipc-utils` 把 `tools.disallow` 合入 serve 禁用表） |
| `agent-draft-tool.js` | `lily_agent_draft` 平台工具（惰性、只写库、不绑定）；`authoring-intent.js` 识别「做一个…智能体」并强制该工具 |
| `workspace-portability.js` | `.lilyspace/agents.json` 段（仅定义；本地角色卡按需内嵌；导入去重再校验） |
| `agent-distribution.js` | 拉取 `GET /api/agents/registry`（登录时带 Bearer）、缓存、按签名配置 `config.agents.{available,default}` 收窄、装为 `distributed` 修订；默认智能体在 `session:create` 时绑定 |
| `ipc-agents.js` + `preload.js agents` | 库 CRUD、官方安装、激活/停用、知识包、单文件导出导入、分发刷新 |

能力门禁：`agent-management`（10 个测试）。

### 6.2 服务端 / 管理后台与渲染层
分别由并行实施记录：`docs/agent-distribution-server.md`（`agent_packages` 表、admin/enterprise/public 路由、`config.agents` 解析）与渲染层智能体库 Tab、会话横幅、开场提示（见测试 `scripts/test-agent-library-ui.cjs`）。

### 6.3 已知边界
- `tools.mcpAllow` / `connectors` 为建议性（走指南），只有 `tools.disallow` 进入 serve 权限表；`model` 与 `tools.disallow` 只在新建/重建引擎会话时生效。
- 停用还原的是「激活前快照」；用户在激活期间手动改的技能/权限会一并回到激活前。
- 聊天中 `@智能体` 未做；切换走会话横幅弹层。
