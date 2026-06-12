# Self-Challenge System

开发者自测试系统：自动检测代码变更，生成挑战任务，执行并自评，记录能力画像。

**注意：此工具仅用于开发，不进产品包。**

## 快速开始

```bash
# 干跑模式（不实际执行引擎，快速验证流程）
npm run challenge:dry

# 真实执行（需要引擎可用）
npm run challenge
```

## 设置 cron 自动运行

```bash
# 编辑 crontab
crontab -e

# 每小时运行一次
0 * * * * cd /Users/zhangqin/aicode/ceshitermianl && /usr/local/bin/node scripts/dev-self-challenge/run.mjs >> .lily-work/challenges/cron.log 2>&1
```

## 手动运行测试

```bash
# 运行全部自挑战测试（7 个套件）
node scripts/test-self-challenge-store.mjs
node scripts/test-self-challenge-capability.mjs
node scripts/test-self-challenge-diff-analyzer.mjs
node scripts/test-self-challenge-generator.mjs
node scripts/test-self-challenge-executor.mjs
node scripts/test-self-challenge-evaluator.mjs
node scripts/test-self-challenge-run.mjs
```

## 数据文件

| 文件 | 说明 |
|------|------|
| `.lily-work/challenges/history.json` | 挑战历史记录（最多 500 条） |
| `.lily-work/challenges/capabilities.json` | 能力维度画像 |
| `.lily-work/challenges/lock` | 运行锁（防并发） |

## 工作原理

```
cron (每小时)
  → run.mjs
    → Lock Check（防并发）
    → git diff HEAD~1（检测变更）
    → ChallengeGenerator（选题：diff-driven 优先，3 轮无变更则能力补题）
    → ChallengeExecutor（spawn 引擎执行）
    → ChallengeEvaluator（spawn 引擎评估，5 维度打分）
    → ChallengeStore + CapabilityTracker（存档）
```

## 能力维度

| 维度 | 分数趋势 | 说明 |
|------|---------|------|
| code-analysis | ↑↓→ | 分析模块依赖和职责划分 |
| refactoring | ↑↓→ | 拆分大文件和消除重复 |
| error-handling | ↑↓→ | 边界条件和异常处理 |
| test-generation | ↑↓→ | 测试覆盖补充 |
| multi-locale | ↑↓→ | 多语言国际化检查 |
| cross-module | ↑↓→ | 跨模块耦合分析 |

连续 2 次失败 = 该维度暂停，等待人工介入。
