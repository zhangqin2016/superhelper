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
| 5 | §13.1 会话头部 persona/world 指示器 | renderer session-control 只渲染 monogram+名字；persona/world pin 不显示 |
| 6 | §13.2 导入方式（拖放/粘贴/本地路径） | 仅 file picker；拖放/粘贴走普通附件路径，无卡片检测 |
| 7 | §10.4.1 多书 merge strategy（chat/persona/global）+ regex/语义激活 | turn-world-book 无 merge 逻辑、无 is_greeting 处理 |
| 8 | §10.4.1 `@@is_greeting` 条目（仅开场问候激活） | 无 |
| 9 | §4.3 宏细节：world 条目内容不展开、persona 名宏缺失、宏阶段序 | card-macro-expander 部分覆盖 |
| 10 | §13.1 "编辑当前角色"直接命令 | 只能间接走库管理→编辑 |
| 11 | §13.2 Delete 直接删除（设计并列，实现用 archive 取代） | 需确认产品决策 |
| 12 | §19.5 参考实现对照测试 + 真实卡片语料库 | 缺失 |

## 外部/人工（非代码）

- §19.6/§19.7 模型评估矩阵、真机验收（macOS/Windows）、P2C-1 规格评审
- §12.1 semantic 发言策略 + §11 model-assisted 记忆提取（需模型运行时，opt-in）
