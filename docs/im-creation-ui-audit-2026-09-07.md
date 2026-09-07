# IM 创建流程与跨页面审查

## 范围和验收标准

本轮范围是 IM：聊天、联系人、新朋友、企业、群详情、创建群聊/频道、远程协作任务。不是重写工作台和设置页，也不是发布安装包。以真实 Electron 加载产品 HTML/CSS、受控接口和交互回归为依据，不将测试通过等同于主观“顶级”或生产双机验收。

创建流程不得挤占侧栏、遮挡提交按钮或在选人后产生无界高度。后台刷新不得打断编辑；关闭弹窗后迟到的创建结果不得导航或清空新草稿。

## 已实施

- 创建群聊和频道共用原生模态弹窗。保留已有命令、权限、选人和恢复入口。
- 宽屏使用候选列表/已选列表双列；窄屏使用横向紧凑已选条。列表独立滚动，底部取消/创建按钮固定。
- 已选头像固定 24px，移除选择条淡入，支持单项取消；不再继承普通成员大头像尺寸。
- 使用现有浅色/深色主题 token、圆角和阴影，没有新配色体系。
- 原生焦点约束与关闭交互；后台目录刷新保留弹窗、文本、选人焦点和滚动位置，成员移除后仍会剔除无效选择。
- 取消保持可用；操作的服务器持久化不被伪装成取消。迟到结果不能打开聊天或清空重新打开的新草稿。
- 收窄通用操作按钮的边框选择器，避免联系人、频道及详情的整行入口错误套用小按钮边框。
- 更新 CSS 缓存标记。

## 检查矩阵

| 页面/交互 | 检查方式 |
| --- | --- |
| 创建群聊、频道 | 新增真实 Electron 测试；15 人、1200/420/760px、浅/深色；取消后迟到响应；后台刷新文本/选人焦点 |
| 联系人、企业、聊天标题状态 | online-presence-center：三语言、浅/深色、窄停靠面板；截图复核 |
| 新朋友、详情、群抽屉 | detail-navigation、social-ui、group-management 等现有真实 DOM 交互回归；权限与迟到返回 |
| 聊天、引用、附件草稿、输入区 | desktop-layout、composer、timeline、file-input 等回归；浅/深色截图 |
| 远程协作任务 | remote-task-ui/workflow-ui：角色、失败恢复、三语言、四组主题/宽度；窄屏截图复核 |

新朋友和群详情主要依赖交互回归，本轮没有对它们每个状态逐张截图验收。测试数据不是用户生产数据，测试背景的资源路径差异不能作为生产资源故障结论。Mac 安装包、Windows、真实双机、生产部署不在本轮完成声明内。

## 验证命令

- `npx electron scripts/test-collaboration-create-dialog.cjs`
- 全部 `test-collaboration*`、`test-remote-task*` 与选人测试
- `node scripts/test-renderer-css-tokens.mjs`
- `node scripts/test-theme-tokens.mjs`
- `node scripts/test-architecture-boundaries.mjs`
- `git diff --check`

截图由 `IM_DESIGN_SCREENSHOTS`、`PRESENCE_SCREENSHOTS`、`REMOTE_TASK_SCREENSHOTS` 环境变量生成，未将截图和用户原有 output 文件混入源码改动。
