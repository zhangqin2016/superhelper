# Turn Block 体验方案（对标 Claude 问答体验）

## 目的

把一次问答（turn）从"过程时间线 + 最终答案气泡"两张皮，统一为**一条按时间交织的
块序列**（thinking / text / tool / todo / notice / permission），并以此为契约重建
思考展示、过程收纳、状态行和操控体验。块模型同时让渲染性能问题结构性消失：
已关闭的块永远不再重渲。

北极星拆解（Claude Code / claude.ai 的回合体验）：

1. 永远知道它现在在干什么（活动行：动词 + 已用时 + token + esc 提示）。
2. 思考可见但不抢戏（流式淡色思考，完成后折叠为"思考了 N 秒 ▸"）。
3. 过程是时间交织的叙事：思考 → 工具 → 再思考 → 正文。
4. 工具是人话卡片，结果可折叠、出错醒目。
5. 计划可见（todo 清单原地打勾）。
6. 随时可打断、可追加指令，半成品保留。
7. 完成后过程自动收纳，答案独占视觉（渐进披露）。

## 契约

```
Block = { id, kind, ts, status: streaming | done | error, ...payload }
kind  = thinking | text | tool | todo | notice | permission | question
```

- `state.timeline`（主进程）与 `live.timeline`(渲染端) 是同一形状，按事件顺序排列。
- 思考块语义：delta 追加到最近一个 `status === "streaming"` 的 thinking 块；
  **新工具块、正文开始（assistant.delta）、message_stop、turn 终态**都会封口
  （status → done）；封口后的 delta 开新块。**notice 不分割思考块**（带外事件，
  不是 content block）。
- 块 id 在 turn 内稳定（`think_1`、tool 用引擎 toolId），渲染端按 id 做 DOM patch，
  已封口的块不再触碰。
- 归档 record 直接携带 timeline，历史回看与 live 同一渲染路径。
- 主进程 `src/main/turn-timeline.js` 与渲染端 `src/renderer/modules/turn-timeline.js`
  是镜像实现，**任何语义改动必须两侧同步并各自有测试**。

## M1：块模型地基

### 第一批（已完成）

- `upsertTimelineThinking` 支持多个交织的 thinking 块（修复"全 turn 思考合并为
  单块"），块带 `id` / `status`。
- 新增 `closeOpenThinkingBlocks`；封口点：tool 块创建、`assistant.delta`、
  `assistant.message_stop`、`_finalize` 终态（主进程）；`assistant.delta`、
  终态（渲染端 store）。
- 渲染端按 `data-thinking-id` 逐块 patch；已封口块在 live 期间折叠，仅流式块
  强制展开；processStructureSig 纳入思考块 id+status，块状态变化触发重渲。
- 测试：`scripts/test-turn-timeline.mjs` 新增交织/封口/notice 不分割断言。

已验证：

- `node scripts/test-turn-timeline.mjs`
- `node scripts/test-turn-orchestrator.mjs`
- `node scripts/test-session-runtime-store.mjs`
- `node scripts/test-turn-view-renderer.mjs`
- `node scripts/test-claude-runtime-fixtures.mjs`
- `node scripts/test-turn-process-layout.mjs`

### 第二批（数据模型已完成）：text 块进 timeline

- `assistant.delta` 作为 text 块进 timeline（`appendTimelineText`）：text delta
  封口思考块，thinking delta / 工具块封口 text 块（`closeStreamingBlocks`），
  `state.assistantText` 聚合字段保留作兼容。
- 渲染端 `getRenderableTimeline` 暂时过滤 text 块——正文仍由气泡渲染，
  避免双份渲染；**按块交织渲染正文（气泡成为最后一段 text 块的视觉强调）
  移至 M2 与思考体验一并切换**。
- 归档 record 已携带含 text 块的完整块序列；`thinkingText` / `assistantText`
  在渲染切换后进入弃用期。

已验证：

- `scripts/test-turn-timeline.mjs`：think → answer → think → tool → answer
  产出 5 个有序块、封口语义断言。
- `scripts/test-session-runtime-store.mjs`：块序断言（text,thinking,tool）。
- 全量 55 个 unit 测试逐个执行，除分支既有失败 `test-scheduled-tasks.mjs`
  （与本改动无关，干净工作区同样失败）外全部通过。

## M2：思考体验 + 活动行

- 流式思考块：限高内部自动跟随，块头"正在思考…"+ 已用秒数。
- 封口后塌缩为一行"思考了 N 秒 ▸"（需要块级 startTs/endTs，M1 的 ts 已具备）。
- 活动行：`正在 <工具预览>… (Ns · Nk tokens · esc 打断)`；优先级沿用
  resolveActivityLabel：运行中工具 > 思考中 > 等待首字。
- 普通模式（非技术用户）：思考内容不展示，仅保留"正在思考…(Ns)"。
- 工具/命令执行详情**默认折叠**，预览行讲故事，点击展开；
  用户的展开选择跨重渲保留（restoreDetailsOpenState）。

### 第一批（已完成）

- 思考块带 `startTs`，封口后摘要显示"思考了 N 秒"（<1 秒回退为标题；
  i18n：zh-CN/en，ar 走回退）。`buildThinkingSummaryLabel` 接受块对象，
  字符串入参保持兼容。
- 流式思考限高收紧为 ~6 行跟随窗口（原 40vh/320px）。
- 工具卡 `row.open` 默认 false（原"运行中自动展开"取消）。
- 测试：`test-turn-view-renderer.mjs` 新增时长摘要断言。

### 第二批（已完成）：活动行 + Esc 停止

- 活动行升级为 `{N}s · {活动} · {N}k tokens · Esc 停止`（token 在 usage
  遥测到达后出现；不足 1 秒仅显示活动，避免闪烁）。
- Esc 真实接线：输入框内按 Esc 中断当前 turn（作用域限输入框，
  各弹窗自己的 Escape 处理优先；turn 空闲时不拦截）。
- 测试：`test-turn-view-renderer.mjs` 活动行断言（含 token 形态）。

### 第三批（已完成）：交织渲染 + 流式思考秒数

- 流式思考块头显示已用秒数（"思考中 12s · 预览"，秒数随最新 delta 时间戳
  跳动；不足 1 秒保持原标签）。
- **正文按块交织渲染**：气泡只显示最后一个 text 块；更早的 prose
  （工具之间写的过渡文字）以行内 Markdown 进时间线的时间序位置。
  flat 模式整条时间线严格按时序渲染（思考块归位，不再置顶）；
  折叠模式思考/text 保持时序，工具+notice 组锚定在首个工具的位置。
- 最终覆盖文案（如注入的错误消息）不等于流式聚合时仍优先占气泡；
  等于聚合时只显示最后一段，避免与时间线重复（endsWith 判定）。
- 测试：`test-turn-process-layout.mjs` 交织断言（气泡=末段、时间线保早段、
  错误覆盖优先）；`test-turn-view-renderer.mjs` 流式秒数断言。

### 待做

- 普通模式（非技术用户）隐藏思考内容——待产品定"普通/高级双模式"开关后实施。

验收：思考中途调工具时，旧块定格折叠、新块在工具卡之后出现；用户停留在
历史位置时流式更新不拽动滚动。

## M3：过程收纳 + Todo 卡

- turn 完成后过程组塌缩为"✓ 完成 · N 个步骤 · N 秒 ▸"，最终答案独占视觉。
  （部分完成：折叠组 + 步骤数已有，✓/时长形态待做；footer 已有总耗时）
- ✅ TodoWrite 清单卡（见"差距收口"第 1 条）。
- ✅ 工具卡单卡耗时：tool 块带 `startTs`，完成/失败后状态标签追加
  "· N.Ns"（<100ms 视为瞬时不显示）。
- 待做：错误态强化。

## 测试基建（已完成）

- `scripts/run-all-tests.mjs`：整链全部跑完并汇总失败（替代 && 链断裂）；
  `test:unit` 现在指向 runner，原链保留为 `test:unit:chain` 数据源。
- 修复 `test-scheduled-tasks` 既有失败：执行 prompt 与 scheduleText 已改英文
  （5c9403b 有意变更），测试断言同步到当前意图。**当前 55/55 全绿。**

## M4：操控

- turn 进行中输入回车 → 「排队稍后发 / 打断立即发」双选（interrupt-and-send
  路径已有，补 UI 选择）。
- Esc 打断保留全部已生成块，turn 标"已打断"徽章。
- 权限卡内联时间线，本次允许 / 总是允许 / 拒绝 + 快捷键。

## M5：渲染性能兑现

- text 块封口时做一次完整 Markdown 渲染（重 parse 范围有界于单块）；
  mermaid/katex/highlight 仅在块封口后执行，按内容哈希缓存（缓存已有）。
- 块组件加 `content-visibility: auto` + `contain-intrinsic-size`。
- IPC：同会话事件按帧攒批，同批文本 delta 合并；批带会话内单调序号，
  渲染端断号即拉 `state:full` 快照重建。
- 回放 benchmark 进 CI：大 transcript 10 倍速回放真实渲染管线，统计主线程
  总阻塞 / 最长帧 / 事件到上屏延迟，劣化即红。

SLO：事件到上屏 p95 < 50ms；流式期间无 >100ms 长帧；打断响应 < 200ms；
会话切换 < 100ms；任何等待 1s 内有可见状态。

## M6：多引擎归一

- 适配器声明 `capabilities = { emitsThinking, streamInput, hotEnvUpdate, ... }`，
  编排层按能力降级，无思考流的引擎优雅跳过，不伪造。
- 网关把 OpenAI 风格 `reasoning_content`（DeepSeek/Qwen）映射为
  `assistant.thinking.delta`。
- 适配器认证测试：与引擎无关的"考卷"，断言任何 adapter 产出合法块序列
  （delta 不指向已封口块、工具事件顺序、半行 JSON、进程中途被杀收敛到终态）。

## 与原生 Claude CLI 的差距收口（已完成第一轮）

对照 Claude Code 终端体验的 8 项差距，全部落地：

1. **TodoWrite 清单卡**：识别 TodoWrite 工具，渲染为 ✓/▸/○ 清单卡，最新快照
   展开、历史塌缩为进度行；折叠模式下保持时序在工具组之外（计划≠过程）。
   解析器 `parseTodoEntries` 容错（未知状态降级 pending、半截 JSON 返回空）。
2. **子代理嵌套**：timeline 工具条目携带 `parentToolUseId`，子工具递归嵌套进
   父 Task 卡（`assistant-subagent-tools`），主时间线和折叠组只显示顶层工具。
3. **compact 可见**：`compactBoundary/compactComplete` 不再静默（notice 源
   panel:true + 策略两端镜像放行），用户能看到"整理上下文中…/完成"。
4. **"批准并记住"真持久化**：修复 remember 规则形状为 CLI PermissionUpdate
   规范（addRules + destination: localSettings）；CLI 建议的 session 级规则
   提升为 localSettings。⚠ 旧形状 `{type:"allow"}` 疑似一直无效，需真机验证
   新形状在内置 CLI 版本上生效。
5. **检查点/恢复原样**：同文件多次编辑保留 turn 首个 before-state（checkpoint
   语义）；`revertTurnChanges` 一键恢复整轮（新增文件删除）；改动文件组加
   "恢复原样"按钮（危险确认）；单文件"拒绝"现在能删除新增文件。
   限制：快照在内存中，应用重启后不可恢复。
6. **Plan 模式审批卡**：ExitPlanMode 权限请求渲染为方案卡（Markdown 正文 +
   批准执行/继续完善），plan 权限模式本身已存在于会话权限设置。
7. **@文件引用**：composer 输入 @ 触发工作区文件模糊补全（主进程有界递归
   搜索：深度 6、扫描上限 5000、跳过 node_modules 等），选中插入相对路径。
8. **忙碌时发送双选**：turn 进行中发送弹「排队稍后发 / 打断立即发」三态对话
   框（Esc/点外=取消且保留草稿），打断路径走已有 interruptAndSend。

## 守门纪律

- ✅ Claude 适配层已落位 `src/main/runtime/adapters/`（claude-cli-adapter /
  claude-event-normalizer / engine-event-notices），与 roadmap 约定一致。
- ✅ `scripts/test-runtime-boundary.mjs`（已入 test:unit）：原始 Claude 线协议
  形状只允许出现在 adapters 目录；遗留豁免名单（agent-session.js、
  control-protocol.js）**只许缩小**，二者将随 Agent SDK 迁移消失；
  adapters 模块只允许 session host 引用。
- timeline 语义改动必须主进程 / 渲染端镜像同步。
- 每个里程碑独立可发版，完成时在本文件回写 Status 与验证清单
  （格式同 experience-stability-roadmap.md）。
