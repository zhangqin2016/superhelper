# 能力分档 → 差异化放权（第 2 层：强模型不变笨、也更聪明）

状态：已实施（2026-07-10）。探针 v3（instructionFidelity + toolChoiceAuto → capability.grade）、env 下发（LILY_MODEL_CAPABILITY_GRADE）、lite 运行时收紧（MCP 留 tool broker + file_intelligence / task deny / prompt≤8000）、kill switch、测试（scripts/test-capability-grading.mjs + 探针 mock 矩阵）全部落地；第 5 节两个小尾巴一并完成（self_heal_retry 事件通路+气泡、RESPONSE_ERROR 进 HEALABLE_CODES）。

**probe v4 配方校准已追加**：信号失败时多测一形态，胜者写 capability.recipes（instructionLanguage → 救援提示语言；toolCallHint → 指南追加原生调用示例段并计入分档，可把模型从 lite 升 standard/full）；env LILY_MODEL_RECIPES。

待办：对真实弱模型跑 `npm run eval:model` 建 lite 样本基线、验证配方实际收益，并复核强模型基线前后 diff 为零。

## 目标

同一套平台，按模型实测能力给不同的"装备"：
- **强模型**：全量工具面 + 完整指南 + 子任务代理 → 上限不被平台拖累（不变笨），未来还能放开更多（更聪明）
- **弱模型**：自动收紧工具面、精简指南、关子代理 → 从"29 个工具糊脸然后乱调"变成"少而准"

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

- `lite`：MCP 只保留 `lily_tool_broker`（能力目录是平台合同，必须在）；file-intelligence/process-jobs/mail/web_* 全部不挂——弱模型用 opencode 核心工具就够
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
