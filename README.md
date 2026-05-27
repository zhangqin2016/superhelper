# Terminal Chat Claude

一个本地桌面聊天框，底层连接真实 PTY。应用启动后默认执行 `claude`，聊天框输入会写入 Claude Code 会话，stdout/stderr 会流式显示在聊天窗口和右侧终端面板。

## 使用

```bash
npm install
npm start
```

默认命令是 `claude`。如果你的 Claude Code 命令名不同，可以这样启动：

```bash
DEFAULT_AGENT_COMMAND="claude" npm start
```

## 安全边界

- Renderer 页面不能直接执行系统命令，只能向主进程已有 PTY 写入输入。
- PTY 工作目录固定为本项目目录。
- 默认启动的是 Claude Code；实际命令执行仍走 Claude Code 自身的权限确认机制。
- 后续如果要让 AI 直接生成并执行 shell 命令，应增加命令白名单、危险命令二次确认、审计日志和目录沙箱。
