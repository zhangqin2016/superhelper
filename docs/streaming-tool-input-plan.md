# 工具入参实时流式显示（容错增量解析）— 实现方案备查

Date: 2026-06-19
Status: **未实施**（第 1 步"默认折叠"已上线于 commit 8b69f4d；本文件是第 2 步的待办方案）

## 目标

让 Write/Edit 写代码等工具，入参（尤其大段 `content`/`command`）**边写边逐步显示**，
而不是等 `tool.input.done` 整块出现。配合已上线的"默认折叠"：**默认折叠，展开后能看到
代码逐步写入**，主视图保持干净。助手正文的实时流式不受影响（本就实时）。

## 根因（当前为何不实时）

工具入参以流式 JSON 片段（`input_json_delta`）传来，拼成完整字符串前是**半截 JSON**，
现有管线用严格 `JSON.parse`，只有完整有效才显示：

- `agent-session.js` `stream_tool_input_delta`（~1296）：只把碎片累加进 `_streamingToolInputs`，
  **不逐步 emit**；到 `stream_content_block_stop`（~1305）才 `JSON.parse` 并 emit `tool.input.done`。
- 渲染层 `src/renderer/modules/turn-timeline.js`（~46）：`JSON.parse(tool.partialJson)` 对半截
  JSON 失败 → 回退，所以展开也看不到增长的代码。
- 增量其实**已一路到渲染层**：normalizer→`tool.input.delta`→adapter→`turn-orchestrator.js`（~289）
  累加 `tool.partialJson` 并重发 `tool.input.delta`。缺的只是"对半截 JSON 容错提取字段"。

## 方案

### 1. 新增容错增量 JSON 字段提取器（核心、可单测）

新文件 `src/main/partial-json.js`（或 `src/shared/`，需主进程+渲染层共用）：

- 输入：累加中的半截 JSON 字符串 + 关心的字段名集合
  （`content` / `command` / `new_string` / `old_string` / `new_source` / `file_path`）。
- 输出：best-effort 的已知字段值（字符串字段返回到目前为止已流入、已反转义的内容）。
- 要求：**绝不抛异常**；处理未闭合字符串、**结尾半截转义**（`\` 或 `\uXX` 截断要丢弃尾部不完整片段）、
  Unicode 代理对被切断的情况（缓冲到下次）。不依赖 minified 内部结构，只按 JSON 文本解析。

### 2. 接线（建议：渲染层为主，主进程不变 / 最小变更）

- 渲染层 `turn-timeline.js`：把严格 `JSON.parse(tool.partialJson)` 换成调用上面的容错提取，
  得到流式 `input` 预览；`turn-view-renderer.js` 在**展开**的工具行 body 里渲染这个增长中的
  代码块（code block），随每个 `tool.input.delta` 更新。
- 折叠头（常驻）显示 live 指示：如 `Write game.js · 正在写入 120 行`（行数从流式 content 估算）。
- **定稿**：`tool.input.done` 到达后，用权威完整 `input` 覆盖流式预览，纠正任何容错解析的瑕疵。
- 保持第 1 步：工具行 `row.open=false` 默认折叠不变。

### 3. 风险与对策

- **半截转义/代理对**：提取器丢弃不完整尾部，下次 delta 再补——必须单测覆盖。
- **大内容重渲染抖动**：合并/节流 delta（rAF 或按时间窗 coalesce）再更新 DOM，避免每片重排。
- **非字符串字段**（如 MultiEdit 的 edits 数组）：容错失败时回退到"正在写入…"指示，不强解析。
- **与最终 diff/changes 组重复**：流式预览只活在 live 阶段；定稿/sealed 仍以 changes 组为准，
  避免双重展示。

### 4. 涉及工具（按可见度）

Write(`content`) > Edit/MultiEdit(`old/new_string`) ≈ NotebookEdit(`new_source`) ≈ Bash(长 `command`)。
Read/Grep/Glob 入参极小，无感，无需特殊处理。

### 5. 测试（Rule 9）

- `scripts/test-partial-json.mjs`：喂入逐步增长的半截 JSON（含 mid-escape、未闭合、嵌套、数组），
  断言每步提取的字段值单调正确、且 done 时等于严格 `JSON.parse` 结果。
- 渲染层回归：流式工具行展开时 body 内容随 delta 增长、`tool.input.done` 后等于权威内容。

## 为何当前不做

第 2 步只在"用户主动展开正在写入的工具"时才有可见价值，收益/复杂度比一般；第 1 步默认折叠
已解决"刷屏污染全局"的主诉求。容错解析的边界（转义/代理对/节流）需要扎实单测，留作独立任务。
