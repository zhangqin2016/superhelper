# 能力分档 → 差异化放权（第 2 层：强模型不变笨、也更聪明）

状态：代码与无网络自动门禁已实施（2026-07-10）。探针 v6 只在重复、完整、可见的成功证据下确认 `lite`，旧版或不确定证据保持 `standard`；env 下发、lite 运行时收紧、kill switch、当前回合恢复，以及探针/分档/恢复 mock 矩阵均已落地。`scripts/test-model-eval-policy.mjs` 进一步把实机 eval 变成确定性发版门禁：完整运行缺失/损坏 baseline、结果为空或 case 覆盖不全返回 2，显式单 case 失败或 baseline 由通过变失败返回 1。实机路径复用生产 profile→env 映射（overlay、prompt cap、tool compat、确认后的 grade、recipes）、`buildSharedBaseConfig`、Lily persona 和 runner 的 lite/recipe 指南；直接 CLI 无法覆盖的 Electron 会话 MCP 路由与 turn orchestration 仍由聚焦自动测试守门。

**probe v4 配方校准已追加**：信号失败时多测一形态，胜者写 capability.recipes（instructionLanguage → 救援提示语言；toolCallHint → 指南追加原生调用示例段并计入分档，可把模型从 lite 升 standard/full）；env LILY_MODEL_RECIPES。

实机验收仍依赖模型地址/密钥：需重新跑真实弱模型并人工复核后更新 baseline、验证配方实际收益；还需建立并复核强模型基线，确认分档前后结果无回退。现有 Qwen baseline 早于完整 Lily persona eval 路径，不能代替这轮凭证依赖的现场复跑。自动化门禁已完成不等于这些实机结论已经验证。

共享 OpenCode serve 的 stdio MCP 调用目前不携带来源 Lily 会话元数据，因此共享 tool broker 明确使用稳定的 `platformOnly` 上下文，避免把一个会话的身份/技能误给另一个会话，也避免每个普通会话生成不同 serve signature。真正隔离的 transport 仍可通过 `writeActiveMcpConfig(..., context)` 传入会话上下文；共享 transport 若要恢复会话级 broker 状态，需要未来增加请求级会话元数据。`learned-*` Web 系统仍沿用既有的按启用技能隔离，不能改成跨会话全局暴露。

## 目标

同一套平台，保留相同的可执行能力面，按模型实测能力提供不同的认知支架：
- **强模型**：全量工具面 + 完整指南 + 子任务代理 → 上限不被平台拖累（不变笨），未来还能放开更多（更聪明）
- **弱模型**：保留全量可执行工具面，只追加更短、更确定、经过探测的协议/配方；可减少并行与子代理复杂度，但不能删除完成真实任务所需的 MCP 能力

### 任务级能力就绪（2026-07-11）

模型分档不再承担依赖路由。每个真实任务由 `capability-readiness` 只判断“当前任务硬需要什么、什么只是增强”，再经统一 coordinator 去重、限并发、可恢复下载、校验和、临时目录健康探测，必要时仅在首次发送前刷新空闲 runner/MCP，最后把同一用户消息发送一次。技能预设不预装重依赖；普通 PDF 不因启用 Office 预设就下载 Docling。规划或准备异常时保持 strong baseline 原文和完整执行面；缺包时只追加有界的降级证据说明，不自动换弱模型、不重复副作用。

正式发布由 `runtime-pack-lock.json` 锁定 darwin-arm64、darwin-x64、win32-x64 的逐包版本、哈希、大小和健康探针。只有目标主机实测通过的构建脚本可以写锁；缺失平台产物属于发布阻断，不转嫁给最终用户。

## 硬约束（能力门禁 Rule 13）

1. 默认档 = `standard` = **今天的行为原样**；没有探测证据永远不偏离
2. 分档只作用于打了分的自定义模型；内置模型、Anthropic 协议模型不经过此路径
3. kill switch：`LILY_ENABLE_CAPABILITY_GRADING=0`
4. 发版门禁：强模型基线（eval baselines）在分档功能开启前后必须逐字节一致

## 实施步骤

### 1. 探针测能力（model-compatibility-probe.js，probeVersion 2→3）

在现有 conformance 探测后追加两个廉价信号（各 1-2 个请求，复用 postChat）：

- `instructionFidelity`：发"回复且仅回复大写 PONG"（max_tokens 8，带 overlay）→ 输出精确匹配 = true
- `toolChoiceAuto`：带 lily_probe_tool 但 `tool_choice:"auto"` + 明确需要调用的提示 → 模型主动发起结构化调用 = true

分档规则（保守，宁高勿低——降档才有风险）：
- 两项皆过 → `full`；仅 toolChoiceAuto 过 → `standard`；toolChoiceAuto 不过 → `lite`
- 探测异常/超时 → 不写 capability 字段 = standard（fail-open）

档案新增：`capability: { grade: "full"|"standard"|"lite", signals: {...} }`。probeVersion 升 3 → 存量档案自动重探（棘轮已建成，无需新代码）。

### 2. env 下发（model-presets.js，两处 env builder）

`compatibilityProfile.capability.grade` → `LILY_MODEL_CAPABILITY_GRADE`。normalizeCompatibilityProfile 保留 capability 字段（仿 toolShapeCompat 的写法）。

### 3. 运行时差异化（session-runner-pool.js）

`_opencodeMcpServers(activeSkillIds, { toolCompat, capabilityGrade })`：

- `lite`：MCP 可执行面与强默认保持一致；只追加更短、更确定的执行协议和已探测的兼容配方。不能通过删除 file-intelligence、process-jobs、mail、Playwright 或 `web_*` 来“简化”，因为这会让真实任务无强模型回退地失去能力。
- `standard`/`full`/无档：完全不动（现状）
- lite 同时下发 `LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS` 已有机制的更紧默认（如 min(测得值, 8000)），并加入 disallowedTools: ["task"]（关子代理，弱模型带不动）

`full` 第一期不加东西（现状即全量）；后续在此挂"更多工具/更高并行/更长自治"的增益。

### 4. 测试与验收

- 探针 mock：三种网关（全过/仅 auto 过/都不过）→ 断言 grade；异常 → 无 capability 字段
- presets：grade → env 断言
- runner-pool：lite 时 MCP 集合断言（借 test-turn-orchestrator 的 harness 或独立小测）
- **eval 闭环**：对真实弱模型（公司网关 Qwen3.5-27B 可当 standard 样本）跑 `npm run eval:model` 建基线；强模型基线前后 diff 必须为零

### 5. 顺带补的两个小尾巴（上两轮遗留）

- renderer 监听 `turn.self_heal_retry` → 气泡"已自动修复模型兼容配置，正在重试…"
- 自愈失败特征库扩充：把 `MODEL_STREAMING_NO_CONTENT` 对应的运行时特征接进 HEALABLE_CODES 的评估
