# Workspace Collaboration Entry Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute the scoped tasks and review each result. No unrelated commits or production rollout.

**Goal:** 工作空间和聊天双入口可发现，复用完整任务流程，以 UI 操作验证。

**Architecture:** project-tree 发送项目身份给独立入口控制器，选择授权会话后由 collaboration-center 路由到现有任务表单。主进程解析 projectId 为目录。服务端权限和加密传输保持原样。

**Tech Stack:** Electron, renderer ESM, CommonJS main, SQLite, existing remote task workflow.

## Task 1: 身份到目录的主进程边界

- [x] 扩展 `task-workflow-view.js` 的 prepare 命令为可选 projectId，拒绝路径和额外字段；保留无 projectId 的原生目录选择。
- [x] 新增 `test-remote-task-project-source.mjs`：验证合法项目、非法 ID、删除项目、账号改变、无项目时原行为。先运行观察失败。
- [x] `task-workflow.js` 注入 `resolveProjectDirectory(projectId)`，`src/main.js` 用 projectManager.find 解析目录。冻结之前/之后调用 assertActive 并重读会话权限；不得直接使用 renderer 文件路径。
- [x] 运行新测试及 `test-remote-task-workflow.mjs`、`test-remote-task-ipc.mjs`。独立规格、质量复核均通过；补充 safe view 不含绝对源路径的断言并复测。

## Task 2: 双入口和不可用说明

- [x] 用实际 Electron center 加失败测试：未开放时点击入口显示说明，不请求任务列表；工作空间菜单项目身份传递，取消不导航。
- [x] 新建小型工作空间入口控制器，复用 dialog 和主题 token；展示工作空间、已有授权会话选择、好友/Team 成员、取消和继续。通过显式 callback/context 连接 center，导航有代次隔离。
- [x] `project-tree.js` 增加明确菜单项；`collaboration-remote-tasks.js` 支持显式 create(projectId)，prepare 发送 `{operation:'prepare',conversationId,projectId}`，不自动发送。
- [x] 三语言补充入口与 unavailable/login/service 文案，chat entry 不再在账号未开放时无解释消失。登录/策略刷新后重试读取，不本地放开功能。
- [x] 测试浅深色、窄布局、键盘、账号/服务可用性和撤权事件、页面变化以及关闭后迟到结果。补明确拒绝与未知结果区分、实时语言占位提示、详情加载失败后重试、弹窗紧凑高度与工作空间名称可读性。独立规格与质量复核通过。

## Task 3: 从零 UI 验收

- [x] 新增隔离双窗口实际项目树/协作中心 UI 验收：从零创建→接受→接收→交付→验收→预览→应用→回滚，使用真实合成文件/SQLite/ZIP/IPC，独立规格与质量复核通过。网络、项目注册和会话聚焦等替代边界明确记录。
- [x] 完整真实联网客户端从零通过相同路径，而非只搜索已有 accepted 任务。两个专用账号从项目菜单创建、实际注册/打开独立副本、交付、验收、差异预览、应用及回滚；逐文件核对通过。外部合成文件编辑不冒充 AI 或编辑器测试。
- [x] 分别记录真实模块本地 UI 测试与真实联网 UI 测试；恢复既有专用配置，不访问用户业务数据或更改生产开关。
- [x] 修复真实 UI 发现的新项目树即时刷新、任务专用传输与聊天附件托盘隔离，并重启客户端验证。另补旧缓存绕过下载的归属修复；真实 A 端重启后打开旧交付副本，两条旧任务附件自动消失，普通分享保留由实际中心/IPC 回归验证。
- [x] 最终补丁冻结后重跑 14 项远程任务 Node、4 项传输 Node、15 项相关 Electron UI 脚本、架构门禁及 diff check，全部通过。
- [x] 独立核对规格和代码质量，更新 CAPABILITY-GATE 与验收记录，只勾实际通过项。终审发现的焦点与最终 await 权限重检均补回归并复审通过。正式安装包发布、普通账号 rollout、两台物理设备不在本轮完成声明内。
