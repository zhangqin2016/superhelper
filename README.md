# 智能工作台（桌面 Claude）

> **AI 代理 / 新人请先读 [AGENTS.md](AGENTS.md)** —— 全项目导航地图(目录职责、各子系统位置、构建/测试/运行、常见任务从哪下手)。工作纪律见 [CLAUDE.md](CLAUDE.md)。本 README 聚焦聊天/会话子系统。

与 OpenCode Desktop 类似的体验：聊天气泡、流式回复、工具步骤卡片；应用内运行一个共享的 `opencode serve`，每个对话绑定到 OpenCode session，并通过官方 SDK 与事件流驱动。不是每条消息重新启动进程，也不是把终端 TUI 嵌进窗口。

## 使用

```bash
npm install
npm run start:dev    # 使用本机 claude + ~/.claude
npm start            # 使用内置 CLI + 应用配置目录
```

## 架构

| 组件 | 说明 |
|------|------|
| `opencode-shared-server.js` | 全应用一个 `opencode serve`；维护官方 SDK client、全局事件流、重连与事件批处理 |
| `opencode-server-manager.js` | 每个 Lily 会话在 shared serve 上的 session view；按目录、session id 和 message id 做事件归属过滤 |
| `opencode-agent-session.js` | Lily runtime runner；把 OpenCode 事件归约为 RuntimeEvent，并处理权限、问题、恢复和完成边界 |
| `opencode-sdk-session.js` | 官方 OpenCode SDK 的薄封装；集中 `session.create/promptAsync/messages/revert/status` 等调用 |
| `opencode-conversation-source.js` | 历史消息读取门面；优先读 OpenCode `session.messages`，Lily 本地 store 只保存增强元数据和旧数据 fallback |
| `user-message.js` | 结构化用户消息（文本、图片 base64、PDF document 块） |
| `session-runner-pool.js` | 管理 Lily 会话 runner；把会话级技能、权限和模型配置映射到 OpenCode runner |
| `turn-orchestrator.js` | 唯一 turn 状态机；负责排队、预处理、提交、终态、恢复和归档 |
| `runtime-event-bus.js` | 主进程到 renderer 的有序 RuntimeEvent 批量通道 |
| `message.js`（renderer） | 多会话聊天气泡 UI、工具卡片、流式 Markdown、审批卡片 |
| `spawn-env.js` | 模型预设、配置目录、PATH、平台运行时环境 |

OpenCode 的 canonical transcript 存在 OpenCode session 中；Lily 只把文件产物、工具时间线、用量、失败分类等产品增强元数据写入本地 message store。历史读取优先走官方 `session.messages`，即使当前没有 live runner，也会在存在 OpenCode resume id 时启动一个空闲 view 读取官方历史。

切换**模型预设、API 网关、全局 MCP/插件配置**会让新的 runner 绑定到新的 shared serve；旧 serve 在已有会话释放后退出。切换**技能**会重写会话 AGENT 指南，并把启用技能范围传入 MCP 组装，未启用的 learned web-system 不暴露给该会话。切换**权限模式**由 host-side permission policy 即时生效，不重启正在运行的 turn。

## 测试

```bash
npm run test:unit
```

## 开发

- macOS / Windows：无需原生 PTY 模块
- 需本机或内置 `opencode` engine
- 主进程协议改动后需**完全重启**应用（`npm start`）
