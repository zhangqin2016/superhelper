# 智能工作台（桌面 Claude）

与 Claude Code App 类似的体验：聊天气泡、流式回复、工具步骤卡片；每个对话对应一个**长驻** Claude 进程（`stream-json` 协议），不是每条消息重新启动，也不是把终端 TUI 嵌进窗口。

## 使用

```bash
npm install
npm run start:dev    # 使用本机 claude + ~/.claude
npm start            # 使用内置 CLI + 应用配置目录
```

## 架构

| 组件 | 说明 |
|------|------|
| `agent-session.js` | 每会话一个 `claude -p --input-format stream-json --output-format stream-json` 子进程；处理 control 协议、权限审批、环境热更新 |
| `control-protocol.js` | stdin/stdout 控制消息（interrupt、权限、initialize、cancel） |
| `user-message.js` | 结构化用户消息（文本、图片 base64、PDF document 块） |
| `session-runner-pool.js` | 管理多会话子进程 |
| `runner-live-config.js` | 模型/搜索环境变量热更新（`update_environment_variables`） |
| `message.js`（renderer） | 多会话聊天气泡 UI、工具卡片、流式 Markdown、审批卡片 |
| `spawn-env.js` | 模型预设、配置目录、PATH |

切换**模型预设、API 网关、搜索配置**时，空闲会话通过 stdin 热更新环境变量，无需重启进程。切换**技能/禁用工具**时仅终止空闲 runner，下次发送时按新配置启动。切换**权限模式**通过 `set_permission_mode` 热切换。

## 测试

```bash
npm run test:unit
```

## 开发

- macOS / Windows：无需原生 PTY 模块
- 需本机或内置 `claude` CLI
- 主进程协议改动后需**完全重启**应用（`npm start`）
