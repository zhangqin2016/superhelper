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
| `claude-session.js` | 每会话一个 `claude -p --input-format stream-json --output-format stream-json` 子进程 |
| `session-runner-pool.js` | 管理多会话子进程 |
| `message.js` | 多会话聊天气泡 UI、工具卡片、流式 Markdown |
| `spawn-env.js` | 模型预设、配置目录、PATH |

切换设置中的模型或权限模式会重启所有会话进程，使新参数在**下一次发送**时生效。

## 测试

```bash
npm run test:unit
```

## 开发

- macOS / Windows：无需原生 PTY 模块
- 需本机或内置 `claude` CLI
