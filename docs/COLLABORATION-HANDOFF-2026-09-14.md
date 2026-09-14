# Lily Workbench 协作核心交接 — 2026-09-14（checkpoint 62 后更新）

本文用于直接接手，不代表完成或发布。

## 1. 从哪里继续

- 工作目录：`/Users/zhangqin/.codex/worktrees/43ee/ceshitermianl`
- 分支：`codex/collaboration-core`
- 最新代码提交：`git log -1`，标题 `feat(collaboration): undo a contribution through its durable inverse`（checkpoint 62）。
- 没有仍在等待的工具句柄或测试进程。PostgreSQL 测试容器状态未在本轮确认。
- 原始目录 `/Users/zhangqin/aicode/ceshitermianl` 有用户未提交改动，**不要修改、覆盖或把此分支直接合并进去**。仅借用其已安装依赖。
- 未部署、未安装新版本、未修改生产开关。用户已允许分阶段实现和提交，没有授权外部发消息或生产发布。

## 2. 完整目标与实际进度

目标仍是 A–D 全部完成，不能以当前已实现的部分重新定义完成标准。

| 范围 | 当前状态 | 仍需完成 |
| --- | --- | --- |
| A 持久工作空间绑定、会话任务卡 | A1–A4 已勾选 | 完整客户端验收仍属于 D3 |
| B 真实 Git changeset | B1–B3 已勾选 | 大目录流式/懒加载和规模验收 |
| C 双链自动合并与恢复 | 底层路径 + 贡献撤销（checkpoint 62）已接通；C1/C2/C3 **仍未勾选** | 原始测试 helper/依赖覆盖、未解决冲突进入现有模型修复流程、跨平台/完整客户端 |
| D Office 和大文件 | DOCX 私有候选保守结构合并；复用加密 multipart 和 Git 对象路径 | 共享链 Office、Excel/PPT/宏与渲染保真、流式枚举/有界并发/懒加载、实际规模和双客户端验收 |

权威范围：

1. `docs/superpowers/plans/2026-09-14-collaboration-core.md`：完整计划及 checkpoint 0–62。优先读顶部要求、"Next execution target" 段和最后几个 checkpoint。
2. `docs/research/2026-09-14-collaboration-git-ai-research.md`：用户研究/目标。
3. `CAPABILITY-GATE.md`：能力门控与验收限制。
4. `docs/remote-task-collaboration-design.md`：早期设计。其手动预览/接受流程不应覆盖较新计划中的自动集成目标。

## 3. 最近提交及可用实现

| 提交 | 实现 |
| --- | --- |
| checkpoint 62 | 贡献撤销服务 `local-contribution-undo.js` 接入身份型 rollback 操作；inverse 记录、undone 状态、重启对账、三语文案 |
| `31a10523` | 从真实应用 before/after 备份生成贡献反向候选 |
| `48da7b03` | 任务卡和任务详情显示持久本地应用状态 |
| `a7403288` | 前台空闲后退役空闲引擎组，完成共享发布的任务自动继续本地应用 |
| `6a642a9f` | 引擎、legacy/durable jobs 在执行命令前注册 POSIX 进程组 |
| `1d151e73` | 本地候选验证后写入 W，个人恢复记录、应用回执和 A 更新同一事务提交 |
| `568f7d27` | DOCX 私有候选保守结构合并 |

符号：H 是共享历史；D 是交付贡献；M 是共享合并结果；A 是此设备上次同步的共享基线；W 是当前用户工作文件。私有 W/验证提交不能进入共享对象库。

## 4. 贡献撤销（checkpoint 62）已落实的语义

- 入口：任务详情"撤回本次本地应用"按钮 → renderer `rollback`（只带 conversation/task/application 身份）→ `task-workflow.js`：`materialization` 记录走 `undo().undo(id)`，`inverse` 记录走 `undo().recover(id)`，旧 `application` 记录仍走整文件 rollback。已 applied/undone 的 materialization 拒绝整文件 rollback（`COLLAB_LOCAL_APPLICATION_INVERSE_REQUIRED`）。
- 撤销 = 新的私有 W 修改：以原 after 为 base、before 为 incoming、当前 W 为 local 合并；后续无关编辑保留，重叠编辑返回 `COLLAB_LOCAL_UNDO_CONFLICT` 且不写任何文件。**不回退 A、不重写共享历史**。
- 持久化：写入前先存 `kind:"inverse"` 个人恢复记录（`undoOf` 指回原记录，原记录 `undoApplicationId` 指向当前尝试）；最终 journal applied、全候选哈希复核、原记录 `undone`、job 记录 `undone` 同一 SQLite 事务提交。job 更新是尽力而为：会话被撤销/退役不阻止个人撤销。
- 幂等/历史：重放已完成撤销只返回历史结果，不碰撤销后的编辑；已完成的 inverse 永不被 rollback（`NOT_RECOVERABLE`）。同一共享 M 不再自动重放已撤销贡献（`local-materialization.prepare` 直接返回 undone 记录）；更新的 M 才重新准备候选。
- 崩溃恢复：中断的 inverse 恢复到 inverse 写入前的 W（不是贡献之前）；入口有三处：`undo.recover`、启动 `recoverLocalWrites`、个人恢复列表的 rollback。恢复后可作为新 attempt 重试。
- 文件 mode：原贡献删除的文件恢复时保留原 mode；`fileModes` 进入 broker 不可变 binding/plan hash 和 `task-recovery` 闭合输入校验，不是旁路参数。
- 投影：`integration-status` 新增 `undone` localStage（需 receipt + undoApplicationId），`localApplicationStatus` 返回 `undone`（admission 落 `COLLAB_LOCAL_APPLICATION_UNDONE`），`recoveries` 隐藏已完成撤销/隐藏已 applied inverse、列出中断 inverse，`drafts` 隐藏 inverse 内部记录并以 undone 投影原应用。英/中/阿三语文案：`collaboration.task.integration.local.undone`、`collaboration.task.undone`、`collaboration.task.undoConflict`。

已知未覆盖：跨 profile/完整客户端、Windows、DOCX 以外 Office 的 inverse、checkpoint 57 之前格式的旧 journal。

## 5. 运行与验证

已装运行时：

- Node：`/Users/zhangqin/.nvm/versions/node/v22.19.0/bin/node`
- Electron：`/Users/zhangqin/aicode/ceshitermianl/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`
- Python：`/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3`

本轮通过的测试（均需 `NODE_PATH=/Users/zhangqin/aicode/ceshitermianl/node_modules`）：

```sh
node scripts/test-local-contribution-undo.mjs            # 也在 ELECTRON_RUN_AS_NODE=1 Electron 下通过
node scripts/test-local-contribution-inverse.mjs
node scripts/test-local-materialization-apply.mjs
node scripts/test-remote-task-recovery.mjs
node scripts/test-task-integration-status.mjs
node scripts/test-remote-task-application.mjs
node scripts/test-task-local-candidate.mjs
node scripts/test-remote-task-writer.mjs
node scripts/test-remote-task-workflow.mjs               # 及 LILY_TEST_GIT_PROTOCOL=1
Electron scripts/test-remote-task-workflow-ui.cjs        # 无需依赖链接
Electron scripts/test-session-task-cards-ui.cjs          # 需临时 node_modules/{morphdom,lit-html} 符号链接指向原目录，跑完删除
```

Renderer/ESM 测试若缺依赖，只在本 worktree 建 `node_modules` 下精确依赖 symlink 指向原目录；完成后仅删除 readlink 匹配的链接，绝不能删除真实依赖目录。交接时没有遗留链接。

近期证据日志（本机临时文件，不是发布证明）：`/private/tmp/claude-501/-Users-zhangqin-aicode-ceshitermianl/3397cc85-04b2-4d75-a3ea-94c929addec7/scratchpad/lily-62-*.log`；更早见 `/private/tmp/lily-59..61-*.log` 和计划 checkpoint 56–61。不要把历史 PASS 当成新改动已回归。

完整 HTTP 测试入口：`server/scripts/collaboration-objects-http-integration.mjs`（含 `collaboration-task-git-http-fixture.mjs`），依赖测试容器 `lily-collaboration-verify-pg`、DATABASE_URL 和原依赖；本轮未重跑。

Git worktree 元数据在原仓库，add/commit 可能需要 sandbox escalation。只暂存明确文件。

## 6. 接手优先顺序

1. C2/C3：原测试 helper/依赖覆盖，未解决冲突进入现有模型修复流程；不能靠额外守卫替代目标行为。
2. D1：Office 共享链/多格式/保真验证（Excel/PPT/宏、渲染），Python 适配器。
3. D2：真正有界流式大目录枚举、有界并发哈希/上传、懒加载清单；不把已有 multipart 等同于完成。
4. D3：有实际 bytes/RSS/时间数据的规模/故障和两完整客户端验收，逐条更新门控。
5. 用户明确不满耗时；优先交付可使用的端到端阶段，简短报告真实可用结果。不要无限拆分基础设施；没有全范围证据不得声称完成。
