# Self-Challenge System Design

> 开发者自测试系统：通过自动生成和执行代码挑战，推动 Lily Workbench 自我成长。
> **非产品功能** — 不进 asar 包，不注册 IPC handler，仅开发者使用。

**Goal:** 自动检测代码变更，生成针对性技术挑战，执行并自评，输出改进建议和能力画像。

**Scope:** 独立 CLI 脚本系统，数据存 `.lily-work/challenges/`，由系统 cron 驱动有序执行。

---

## 一、边界约束

- **不进产品包**：所有代码位于 `scripts/dev-self-challenge/`，不在 Electron asar file 列表中
- **独立入口**：`node scripts/dev-self-challenge/run.mjs`，不依赖 Electron 主进程
- **复用基础设施**：通过 `require()` 引用已有的 `TurnOrchestrator`、`SessionManager` 等模块，不改动已有代码
- **幂等设计**：相同输入产生相同输出，cron 重复触发安全
- **并发保护**：lock 文件确保同时只有一个挑战在运行

---

## 二、挑战生命周期

```
cron/npm run challenge
  → 准入检查（lock + 冷却）
  → 选题（diff 分析 or 能力补题）
  → 生成挑战 prompt
  → 执行挑战（独立 session, permission=dontAsk）
  → 自评估（另一 session 审查结果）
  → 存档 + 更新能力画像
```

---

## 三、选题策略

1. **有 git diff**（距离上次挑战后有新提交）→ 分析变更范围，生成针对性挑战
2. **无变更超过 3 轮** → 从能力维度矩阵中选择当前分数最低的维度出题
3. **连续 2 次失败** → 暂停该维度，记录待人工介入

### 能力维度

| 维度 | 说明 |
|------|------|
| code-analysis | 分析陌生模块、追踪调用链 |
| refactoring | 拆分大函数、消除重复 |
| error-handling | 边界条件、异常恢复 |
| test-generation | 为无测试代码写测试 |
| multi-locale | 多语言（中英阿）场景 |
| cross-module | 跨多文件的复杂实现 |

---

## 四、模块结构

```
scripts/dev-self-challenge/
├── run.mjs                  ← 唯一入口
├── challenge-generator.js   ← diff 分析 + 能力画像 → 挑战 prompt
├── challenge-executor.js    ← 调用 TurnOrchestrator 执行挑战
├── challenge-evaluator.js   ← 调用另一个 session 审查结果并打分
├── capability-tracker.js    ← 维度画像 + 分数趋势 CRUD
├── challenge-store.js       ← 挑战记录 JSON 持久化
└── lib/
    ├── diff-analyzer.js     ← git diff 解析，提取变更文件与模块
    ├── prompt-templates.js  ← 挑战 prompt 模板 + 评估 prompt 模板
    └── metrics.js           ← 耗时、token、成功率指标采集
```

每文件目标 ≤200 行，职责单一。

---

## 五、数据文件

```
.lily-work/challenges/
├── history.json        ← [{id, type, prompt, result, score, timestamp, ...}]
├── capabilities.json   ← {dimension: {score, lastTested, trend}}
├── lock                ← 进程锁
└── suggestions/        ← 改进建议（如规则更新 diff），待人工审核
```

---

## 六、执行与评估

### 执行器

- 复用 `TurnOrchestrator.sendUserMessage()`
- 创建独立 session，`permissionMode: "dontAsk"`（无人值守）
- 采集：耗时、token 消耗、是否报错、输出内容

### 评估器

- 创建另一个独立 session 作为审查者
- 输入：原始任务 + 执行输出 + 变更文件内容
- 输出：5 维度评分（completeness, correctness, style, scope, robustness），总分 0-10
- 附加：verdict（pass/fail/partial）、issues 列表、改进建议

### 终止条件

- 超时：单次挑战最长 15 分钟
- 失败：执行报错或评估 verdict=fail
- 成功：评估 verdict=pass 且 totalScore ≥ 6

---

## 七、有序重启依赖 cron

```
cron 控制节奏：
  - 每小时触发（可由开发者调整）
  - 每次触发是独立进程，崩溃不影响下次
  - lock 文件防止并发
  - 幂等保证了重复运行安全
```

无需应用内重启逻辑。cron 是天然的确定性调度器。

---

## 八、不进产品包

`package.json` 的 `build.files` 只白名单了 `src/**/*` 等必要路径。`scripts/dev-self-challenge/` 不在列表中，天然不进 asar。`.lily-work/` 目录也在 asar 之外。
