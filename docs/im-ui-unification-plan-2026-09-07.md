# IM 页面统一实施计划

目标：落实已确认的六项审查问题，不修改消息协议、服务端权限或协作任务状态机。

设计：侧栏承担导航与紧凑列表；创建/添加使用原生模态弹窗；群详情采用稳定成员行与显式管理展开；成员添加按需打开；空态提供相关入口；任务标题栏与聊天一致，正文和操作区共用宽度基准。

## 实施顺序

- [x] 新增 `scripts/test-collaboration-page-polish.cjs`，真实 Electron 加载产品样式：添加联系人必须模态；企业目录默认折叠且频道在先；群管理按点击展开而非悬停；新朋友空态能发起添加；窄屏无溢出。已先复现企业排序/展开状态和空态入口失败。
- [x] `collaboration-create-dialog.js` 扩展 contact 类型，保留查找/请求两个动作与错误状态；`collaboration-friends.js` 添加弹窗关闭、迟到查询/请求保护及空态入口。
- [x] `collaboration-teams.js` 将频道放在折叠成员目录之前；默认不展开目录；群详情管理操作放入显式 disclosure，成员添加表单按需展开。保留所有权限检查及确认流程。
- [x] 新增 `collaboration-page-polish.css`，统一列表、群详情、空态、任务按钮与宽度；只作用于 IM。所有颜色使用已有主题变量。
- [x] 三语言管理标签；更新样式版本；截图浅/深色、宽/窄窗口；检查联系人/新朋友/企业/群详情/任务。
- [x] 运行新增测试、现有 social/detail/group/remote-task 测试、全部 IM 脚本、主题与架构门禁；179 个 IM/远程任务回归脚本无失败，CSS token、127 个主题 token、架构边界及 diff 检查通过。改动保留在本地工作树，未提交、推送或部署。

验收命令：`npx electron scripts/test-collaboration-page-polish.cjs`、`npx electron scripts/test-collaboration-social-ui.cjs`、`npx electron scripts/test-collaboration-detail-navigation.cjs`、`node scripts/test-renderer-css-tokens.mjs`、`node scripts/test-theme-tokens.mjs`、`node scripts/test-architecture-boundaries.mjs`、`git diff --check`。

边界：关闭弹窗不宣称撤销已发送的服务器命令；权限变化即时收回控件；不增加无后端支持的批量成员接口；不使用旧截图当作新验收；本地受控 API 不等于生产双机验收。

## 截图复核追加修复

第一版几何检查只判断外框未溢出，漏掉独立 IM 窗口强制双栏把群详情压成细条的问题。已先加强断言使其失败，再修正 `collaboration-panel-shell.js`：低于既有 760px 阈值切单栏，保留返回入口，销毁时清理 resize 监听。成员行禁止 flex 压缩，测试要求抽屉宽度至少 280px、相邻行不重叠、关闭按钮可见且返回恢复列表。

实际截图目录：`/private/tmp/lily-im-polish`（联系人、企业、新朋友、群详情与窄屏）、`/private/tmp/lily-im-task-polish`（任务浅/深色、宽/窄屏）。联系人弹窗使用内容高度，发送申请与取消同处底部；查找为次级按钮。错误保留招呼语，迟到查询不能重开关闭的弹窗。

## 二次审查闭环

- 确认根因：群管理和好友申请详情的确认、状态、待重试节点仍挂在隐藏列表根节点。为共享操作 UI 增加显示区域归属；详情关闭撤回未确认意图，已提交命令仍走原有持久化流程。
- 确认框采用原生顶层 dialog，默认聚焦取消，支持 Escape；确认正文与目标信息分层，操作区靠右。刷新同一页面不重新挂载确认框；关闭或替换页面后迟到结果不污染新页面。
- 群成员操作完成后刷新原抽屉，不跳到列表详情；失败提示固定在抽屉顶部。好友申请详情复用相同生命周期，待重试操作仍传递原 clientCommandId。
- 联系人、企业、频道空态统一；联系人空态可添加联系人；搜索未命中使用独立提示；不捏造无服务端支持的企业加入入口。
- 动态创建弹窗通过现有翻译机制更新标题、字段、可见性、按钮、搜索、招呼语；选择计数在弹窗打开期间订阅语言变化，关闭即解绑。草稿和焦点保持不变。
- 扩展真实 Electron 测试覆盖上述行为及确认按钮实际背景色。截图复核发现局部 `--danger` 变量未在 IM 生效，已改为全局 `--danger-text`，修复透明背景白字。浅色、深色、420px 窄窗口截图位于 `/private/tmp/lily-im-closure`。

最终回归日志：`/private/tmp/lily-im-closure-final.log`：179 个脚本零失败，其中 3 项可选真实 Redis/PostgreSQL 集成检查因未配置隔离环境而跳过；其余 176 个脚本实际执行，新增 UI 测试全部通过。CSS token、127 个主题 token、架构边界（987 个源文件、52 个 ratchet）及 diff 检查通过。测试使用受控本地 API；不代表重新部署服务端、两台已安装客户端验收或已发布新的 Mac 安装包。本轮不提交、推送或发布。
