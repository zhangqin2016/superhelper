# Character Worlds — 极细条款差距追踪（设计文档 vs 实现）

Date: 2026-08-01
方法：逐章核对 `docs/superpowers/specs/2026-07-29-character-worlds-design.md`（22 章）与
代码/测试实现，记录每个已发现条款的状态。已补齐项标记 ✅ + 提交；剩余项标记 ⬜ + 建议。

## 本轮已补齐（✅）

| # | 设计条款 | 提交 |
|---|---|---|
| 1 | §14.4.7 导入后绑定恢复预览接线（restoreBindingPreview → workspace-import-service） | 4b94dab |
| 2 | §15 `scene:get` / `scene:update` IPC 通道（场景从 renderer 驱动，白名单校验） | fa60aa1 + 1c3f066 |
| 3 | §10.3 creatorNotes 入编译 envelope（imported_lower_authority block） | 127f24d |
| 4 | §20 observability `compiledAt` trace 字段（+ 白名单同步） | e5ce1ea |

## 剩余可代码项（⬜，按价值排序）

| # | 设计条款 | 状态说明 |
|---|---|---|
| 5 | §4.3 world 条目内容宏展开（{{char}} 等） | ✅ 已补（04b362b） |
| 6 | §13.1 会话头部 persona/world 指示器 | renderer session-control 只渲染 monogram+名字；persona/world pin 不显示 |
| 7 | §13.2 导入方式（拖放/粘贴/本地路径） | 仅 file picker；拖放/粘贴走普通附件路径，无卡片检测 |
| 8 | §10.4.1 多书 merge strategy（chat/persona/global） | 真实差距：binding 仅单 book pin，无 merge 概念 |
| 9 | §10.4.1 `@@is_greeting` 激活 | 延后项（非缺陷）：decorator 已实现，但 greetingIndex 未接入 binding；上下文无法确定 greeting 时按 CCV3 合规忽略（world-book-activation.js 注释已文档化） |
| 10 | §13.1 "编辑当前角色"直接命令 | 只能间接走库管理→编辑 |
| 11 | §13.2 Delete 直接删除（设计并列，实现用 archive 取代） | 需确认产品决策 |
| 12 | §19.5 参考实现对照测试 + 真实卡片语料库 | 缺失 |

## 已核实为非差距（子任务过时结论修正）

- §4.3 persona 名宏：已在 compiler（expandField/profile.name 宏展开）实现
- §10.4.7 decorator 门（@@activate_only_after / @@is_greeting / @@dont_activate_after_match / stateful）：world-book-activation.js passesDecorators 已实现
- §10.3 creatorNotes：已补（127f24d）

## 外部/人工（非代码）

- §19.6/§19.7 模型评估矩阵、真机验收（macOS/Windows）、P2C-1 规格评审
- §12.1 semantic 发言策略 + §11 model-assisted 记忆提取（需模型运行时，opt-in）
