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
| 6 | §13.1 会话头部 persona + world 指示器 | ✅ 已补（1573f4a + 9b8220a） |
| 7 | §13.2 导入方式（拖放/粘贴/本地路径） | ✅ 全部完成（9e69f2b + 416bb2d）：IPC sourcePath + 拖放路由闭环 |
| 8 | §10.4.1 多书 merge strategy | ✅ 全部完成（d84632b + 6db3380）：schema v13 + repository + merge 函数 + 激活器接线（多书合并注入编译 envelope） |
| 9 | §10.4.1 `@@is_greeting` 激活 | 延后项（非缺陷）：decorator 已实现，但 greetingIndex 未接入 binding；上下文无法确定 greeting 时按 CCV3 合规忽略（world-book-activation.js 注释已文档化） |
| 10 | §13.1 "编辑当前角色"直接命令 | ✅ 已补（045adf4）：popover 直开当前角色的库编辑表单 |
| 11 | §13.2 Delete 直接删除（设计并列，实现用 archive 取代） | 需确认产品决策 |
| 12 | §19.5 plain-key matcher vs Unicode reference 对照（40 语料） | ✅ 已补（17ff42d） |
| 13 | §19.5 inclusion-group 冲突 resolver vs 贪心参考（4 checks） | ✅ 已补（3d5e6b5） |
| 14 | §19.5 真实卡片语料库矩阵 | ✅ 已补（eb3a03a，12 checks） |
| 15 | §19.5 state-machine 测试（sticky/cooldown/delay 跨变体/回退/重写） | ⬜ 部分：sticky carry-over 已覆盖（activation 测试）；cooldown/delay 跨变体/回退/重写的完整状态机测试未补 |

## 已核实为非差距（子任务过时结论修正）

- §4.3 persona 名宏：已在 compiler（expandField/profile.name 宏展开）实现
- §10.4.7 decorator 门（@@activate_only_after / @@is_greeting / @@dont_activate_after_match / stateful）：world-book-activation.js passesDecorators 已实现
- §10.3 creatorNotes：已补（127f24d）

## 可见性 UI 补强（本轮新增，回应「角色功能看不到」）

| UI | 提交 |
|---|---|
| 会话角色状态条（banner：头像/名字/P/W 徽标，消息流顶部） | 43dd165 |
| 场景/群组设置区（参与者/发言策略/提示模式） | a8beb94 |
| 角色记忆展示（scene:memory + popover 记忆行） | 661e3a4 |
| greeting 选择（新会话开场问候） | ⬜ 需 binding greetingIndex 接入 + 编译管线（后续） |

## 外部/人工（非代码）

- §19.6/§19.7 模型评估矩阵（3pp 非劣性 + 90% rubric）、真机验收（macOS/Windows）、P2C-1 规格评审
- §12.1 semantic 发言策略 + §11 model-assisted 记忆提取（需模型运行时，opt-in）
- §10.4.1 多书 keyed/global merge 策略 + profile-global book 来源（设计方案 §决策点）
- §8 greeting 选择 UI（greetingIndex 接入 binding）

## 产品决策待确认

- §13.2 Delete 直接删除 vs archive 取代
