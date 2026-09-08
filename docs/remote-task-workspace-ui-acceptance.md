# 工作空间协作入口验收 — 2026-09-08

## 范围与证据分层

本轮补工作空间直达入口、未开放状态解释，以及从零创建的 UI 流程。没有修改生产开关、给普通账号提权、发送用户业务文件或发布安装包。

| 层次 | 本轮结果 | 不能据此声称 |
| --- | --- | --- |
| 主进程项目身份解析 | 已通过实际 SQLite、ZIP、文件与 IPC 边界测试 | 正式安装包已发布 |
| 双窗口任务生命周期 | 已通过从工作空间菜单开始的鼠标点击测试 | 两台物理机器或生产对象存储验收 |
| 工作空间菜单直达 | 已整合实际项目树与协作中心，并从该菜单跑通完整流程 | 目前运行的客户端已加载新代码 |
| 真实联网双账号 UI | 专用测试账号在完整源码客户端从零完成任务、应用与回滚 | 普通账号已开放、正式安装包或两台物理机器验证 |

## 双窗口测试如何执行

`scripts/test-remote-task-dual-client-ui.cjs` 创建两个隔离 Electron 窗口：请求方加载实际 `index.html` DOM、项目树、协作中心和 CSS，协作者加载实际协作中心 DOM/CSS。测试驱动用 `webContents.sendInputEvent` 点击经过命中检查的可见控件、`insertText` 输入表单；操作系统拥有的 select 弹出菜单不在 webContents 输入范围内，该步骤使用可见表单控件的 value/change 事件。没有直接调用任务创建/接受/交付/应用方法跳过界面。

`scripts/lib/remote-task-ui-fixture.cjs` 使用真实 `CollaborationStore`、`createTaskCommands`、`createTaskWorkflow`、`createCollaborationIpc` 与服务端 `createTask/transitionTask`。SQLite、ZIP、不可变快照、独立工作副本、差异计划、文件应用和回滚都是真实执行。

明确替代的边界：账号目录、网络传输、对象存储是隔离 fixture，不是生产服务；工作空间注册回调和会话聚焦也被替代，仅确认点击打开动作传递了真实独立副本的目录，不声称完整应用已经注册、切换到该会话。协作者编辑合成文件由测试脚本模拟外部编辑器，不是 AI 执行能力或生产文件编辑器 UI 验收。本机只有一台物理设备，未运行完整生产主进程。

已验证顺序：

1. 工作空间“…”菜单点击分享并发起协作，选择好友、点击继续，输入目标和验收标准，预览实际打包文件；只向主进程传递项目 ID，不再弹第二次选目录对话框。此时没有上传或创建任务。
2. 点击发送，服务端契约提交后模拟回执丢失；界面冻结原始请求并提供重试。再点击确认结果，只有一个创建事件和一个任务。
3. 第二窗口从会话任务入口打开新任务，确认接受，接收文件，并点击打开；断言传给工作空间注册回调的目录是真实独立工作副本，但注册及聚焦为 fixture。
4. 修改合成工作副本；原始快照与请求方源文件保持不变。
5. 第二窗口点击准备交付、提交；第一窗口刷新任务并确认验收。
6. 第一窗口预览差异；验收与预览均不改源文件。有删除项时应用按钮保持禁用，必须显式勾选删除确认。
7. 点击应用后逐个检查增加、替换、删除的文件内容；点击回滚后逐个检查原文件恢复、新增文件撤回。远端任务仍是已验收状态。

复现命令：

```sh
npx electron --disable-background-timer-throttling --disable-renderer-backgrounding scripts/test-remote-task-dual-client-ui.cjs
```

可选 `REMOTE_TASK_UI_SCREENSHOTS` 指向专用输出目录，保存预览、应用计划和回滚界面。截图只是布局证据，文件内容断言才是应用/回滚证据。

## 已执行回归

14 个 `scripts/test-remote-task-*.mjs` 均通过，涵盖 application、bundle、contract、desktop、IPC、policy、project-source、records、recovery、routes、service、session、transfer、workflow。另运行 transfer-manifest、transfer-runtime、transfer-ipc、transfer-service 四项传输脚本，全部通过。

最终补丁冻结后，15 项 Electron 脚本通过：workspace-collaboration-entry、remote-task-center、remote-task-ui、remote-task-workflow-ui、remote-task-focus-ui、remote-task-cached-transfer-ui、remote-task-dual-client-ui、collaboration-social-navigation、collaboration-detail-navigation、collaboration-online-presence-center、collaboration-visible-read、collaboration-create-dialog、collaboration-page-polish、collaboration-attachments-ui、collaboration-composer-attachments。上述 18 项 Node 脚本也在同一最终补丁上全部重跑通过，架构门禁及 diff check 通过；没有据此声称全仓测试、正式构建或安装包发布完成。

新增 `test-remote-task-focus-ui.cjs` 使用实际 ProjectManager、SessionManager、switchSessionFast、state snapshot、preload focus event 与项目树 DOM，验证新任务项目命名、保留已有本地改名、实际会话聚焦后的项目树/顶部名称刷新，以及不启动引擎。这部分不同于双窗口生命周期 fixture 的注册回调替代。

项目身份改动的独立规格复核和代码质量复核均未发现阻断问题。实际源码客户端的只读 UI 检查确认普通 IM 已连接、旧界面缺少任务按钮；没有在该账号中发起协作或修改业务文件。

## 真实联网完整客户端 UI 验收

恢复 `docs/remote-task-live-acceptance.md` 记载的两个专用测试配置：A `/private/tmp/lily-full-client-a6.VymD1r`、B `/private/tmp/lily-full-client-b6.9wYsuC`。两者真实登录及服务端 tasks 权限均为有效，没有修改生产 rollout。为了让原生 UI 工具准确区分同名 Electron 进程，使用两份临时 Electron 副本的独立 bundle identifier 启动同一份 `src/main.js`；不是正式签名安装包。沿用专用测试配置的虚拟设备身份，不声称两台物理设备。

使用原生 UI 工具实际操作菜单、系统目录选择器、表单、选择器、接受、提交、验收、应用与回滚按钮。没有通过直接调用任务业务 API 跳过页面。真实服务、真实私有对象传输、真实主进程、实际项目注册与会话打开参与执行。

本次任务标题为 `UI workspace acceptance 20260908`，发起人/协作者为原专用验收组织内的测试账号。合成源目录 `/private/tmp/lily-ui-workspace-20260908.sSMjZn`，只包含 README.md、budget.csv、obsolete.txt。具体证据：

1. A 通过“新建工作空间 → 添加现有目录”注册合成目录，再通过该工作空间“…”菜单 → Share and collaborate → 专用 Team 协作者 → Continue 进入任务表单。
2. 预览列出上述三个文件，自动排除 `.lily-work/`；没有第二次选目录。显式 Confirm and send task 后 B 端列表出现一个同名 Awaiting acceptance 任务。
3. B 双重确认 Accept task 后状态 In progress；Receive task files 完成真实下载。Open workspace 后任务会话标题正确，`projects.json` 注册独立工作目录并设为 activeProjectId，没有自动执行 AI。
4. 独立工作副本位于 B 配置 `.../task-workspaces/c375d8a1a1bbc48dddbe3941c51b3c17ae1371f80ba2e6b927574d7833f923e5/edcee492-354a-4eef-8f8d-2dd82bfbe8fb/snapshot`；独立基线位于同父目录的 `c7714881-68c9-4868-a252-1ac8f5ad7dfa/snapshot`。**编辑由外部测试补丁完成**，不是 AI 或产品编辑器 UI 能力测试：金额 100→120、新增 evidence.md、移除 obsolete.txt。
5. B UI Prepare delivery 预览 README/budget/evidence，Submit this version 后 A 返回列表读取到 Ready for review；检查后台 A 窗口时仍显示旧详情，本次明确返回列表再打开详情，没有单独测量后台实时刷新或重新聚焦后的同步延迟。
6. A UI Accept delivery 后 Accepted，提示尚未应用；Preview local changes 显示 Replace/Add/Delete 三项，删除确认前 Apply to local files 禁用。命令断言确认源文件及 B 不可变基线此时仍保持原值、原文件存在、新文件不存在。
7. 勾选删除确认并点击 Apply 后，命令逐项断言 budget=120、evidence 内容正确、obsolete 不存在。点击 Roll back local changes 后界面提示本地已回滚且验收不变；命令断言 budget=100、obsolete 原文恢复、evidence 撤回，均通过。

真机 UI 同时发现两个 fixture 无法证明的细节：任务打开后新项目未即时出现在左侧项目树，以及任务传输出现在普通聊天附件托盘。项目树已修复：重启 A 端后点击 Open delivery copy，当场出现第 1/3 个工作空间 `UI workspace acceptance 20260908` 和其任务会话；顶部显示同名工作空间而非内部 `snapshot`，依然空闲且没有启动代理。

任务传输增加 main-only 持久化归属标记，普通附件 UI 只过滤该标记，不过滤所有 workspace 分享。真实升级复测发现旧缓存命中会绕过重新下载，因此又补上显式接收/打开时的精确归属修复：仅使用刚授权的当前任务及其输入/交付对象 ID，匹配同会话的旧传输，实际发生标记变更才通知界面。再次重启 A，操作前确实仍有旧输入上传与旧交付下载两条附件；点击原任务 Open delivery copy 后，两条条目在自动刷新中消失，无需返回列表或手动刷新，左侧任务工作空间和顶部名称保持正确，代理仍为空闲。

新增 `test-remote-task-cached-transfer-ui.cjs` 用真实任务工作流缓存、加密旧 manifest、实际 center/preload/IPC 状态订阅验证上述路径，不在测试中手动刷新附件栏；断言普通 workspace 分享保留、没有对象网络请求、重复打开不重复发变更事件。键盘 handoff 焦点与工作空间名称首帧淡入可读性问题也已修复并由独立复核者复测通过。

独立终审通过。最后补充标记 await 后、实际项目注册前的账号/会话权限重检；回归在该 await 中模拟账号失效与会话移除，确认不会注册或打开工作空间。两个专用验收客户端已结束进程，保留专用配置与合成验收文件；没有停止日常客户端。代码尚未提交、推送或发布。

## 仍需独立完成的验收

- 发布后的正式安装包以及两台物理设备验证。

既有生产私有对象存储验收记录见 `docs/remote-task-live-acceptance.md`，不将上次脚本生命周期或打开已有任务的测试冒充本轮完整 UI 验收。
