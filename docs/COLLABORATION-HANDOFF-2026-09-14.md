# Lily Workbench 协作核心交接 — 2026-09-14（checkpoint 69 后更新）

本文用于直接接手，不代表发布。

## 1. 从哪里继续

- 工作目录：`/Users/zhangqin/.codex/worktrees/43ee/ceshitermianl`，分支 `codex/collaboration-core`，最新提交见 `git log -1`（checkpoint 69）。
- 原始目录 `/Users/zhangqin/aicode/ceshitermianl` 有用户未提交改动，**不要修改、覆盖或把此分支直接合并进去**。仅借用其已安装依赖与 `bundles/darwin-arm64/runtime`（Python 3.12 + docx/openpyxl/pptx + LibreOffice 25.8.7.3）。
- 未部署、未安装新版本、未修改生产开关、没有对外发消息。

## 2. 完成状态

| 范围 | 状态 |
| --- | --- |
| A 持久工作空间绑定、会话任务卡 | 已勾选 |
| B 真实 Git changeset | 已勾选 |
| C1 持久意图/租约/工作空间级写入协调 | 已勾选（Windows、跨 profile 验收仍属 D3） |
| C2 共享候选：确定性合并 → 模型修复 → 校验 → CAS 发布 | 已勾选（checkpoint 63-65） |
| C3 本地 A/W/M 候选、日志复核、撤销、外部锁重试 | 已勾选（checkpoint 62、64、69） |
| D1 Office（Word/Excel/PPT/宏）双链合并 + LibreOffice 渲染验证 | 已勾选（checkpoint 66） |
| D2 流式枚举、单进程物化、容量策略、在线清单、并发上传 | 已勾选（checkpoint 67-68） |
| D3 规模/故障测量、HTTP+PG 集成、双窗口 UI | 已完成子项；**两台完整客户端/安装包/物理机/Windows 仍未勾选** |

D3 未勾选项的阻塞：需要真实测试账号与服务实例、以及对两个完整 app 实例的原生 UI 驱动；2026-09-07/08 的手工流程见 `docs/remote-task-live-acceptance.md` 与 `docs/remote-task-workspace-ui-acceptance.md`。

## 3. 关键实现入口（本轮新增）

- 校验覆盖：`check-imports.js`（helper 钉住/依赖清单）、`node-check-policy.js`（只读项目 node_modules、`DEPENDENCIES_UNAVAILABLE`、`CANDIDATE_NODE_MODULES`）。
- 模型修复：`model-direct-completion.js`、`conflict-repair.js`、`shared-git.js`（`resolve` 钩子、`repairInputs`、`amend`）、`shared-publication.js`（`repairFailure`、按回答集限次）、`integration-status.js`（`decision_required` + questions）、workflow `answerIntegration`。
- Office：`resources/runtime-scripts/merge_office.py`（`office-parts-v2`）、`office-merge.js`（渲染验证）、`task-local-candidate.js`、`shared-git.js` 的 `resolveOffice`。
- 规模：`task-git.js`（流式 ls-tree、`cat-file --batch`、批量 capture、`materializePaths`）、`resource-policy.js`、workflow `inventory`/`materialize`、`transfer-manager.js`（`LILY_COLLAB_UPLOAD_CONCURRENCY`）、`task-application.js`（`LOCKED`）。

## 4. 运行与验证

```sh
export NODE_PATH=/Users/zhangqin/aicode/ceshitermianl/node_modules
node scripts/test-<suite>.mjs                    # 见计划 checkpoint 62-69 列表
LILY_TEST_GIT_PROTOCOL=1 node scripts/test-remote-task-workflow.mjs
R=/Users/zhangqin/aicode/ceshitermianl/bundles/darwin-arm64/runtime
LILY_TEST_OFFICE_PYTHON=$R/venv/bin/python3 LILY_RUNTIME_ROOT=$R node scripts/test-office-local-candidate.mjs
$R/venv/bin/python3 -m unittest scripts/test_office_merge.py
LILY_SCALE_REPORT=docs/research/x.json node scripts/test-collaboration-scale-report.mjs
Electron scripts/test-remote-task-workflow-ui.cjs
Electron scripts/test-session-task-cards-ui.cjs   # 需临时 node_modules/{morphdom,lit-html,jszip} 符号链接，跑完删除
DATABASE_URL=<从 docker inspect lily-collaboration-verify-pg 组装，密码需 URL 编码> node server/scripts/collaboration-objects-http-integration.mjs  # 需临时 server/node_modules 链接
```

证据日志在本会话 scratchpad `lily-62..70-*.log`；测量报告在 `docs/research/2026-09-14-collaboration-*.json`。

## 5. 接手优先顺序

1. D3 未勾选项：准备两个测试账号与服务实例，用原生 UI 驱动两个 `LILY_USER_DATA_DIR` 隔离的完整客户端跑一遍 创建→接收→交付→验收→应用→撤销→冲突问答→在线清单下载，逐条更新门控。
2. 安装包、两台物理机、Windows 前台写入协调与外部锁行为。
3. 真实对象提供商吞吐测量（当前数字来自本地 fixture）。
