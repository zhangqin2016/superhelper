> **⚠️ 已归档（2026-06-13）**：本文是已执行完毕的历史重构方案。文中"现状"描述的
> `turn-controller` / `session-turn-state` / `turn-boundary` / `session-events` 等模块**均已不存在**，
> 重构落地形态与本文目标也有出入（实际为 `turn-orchestrator.js`，见 `docs/turn-event-architecture.md`）。
> 仅作历史参考，**不要**依据本文描述当前架构或执行其中步骤。

# CLI 问答流程彻底重构方案

## 背景

当前产品继续走 Claude CLI 进程路线是正确的。SDK 会损失 CLI 原生控制面，尤其是 stdin/stdout、stream-json、权限确认、AskUserQuestion、hook、resume、MCP、未来 CLI 新事件等能力。

真正的问题不是 CLI 路线，而是我们在 UI 化过程中叠了太多并行状态通道。现在一个用户问题会同时经过：

- `AgentSession` 解析 CLI stream-json。
- `wireRunner` 把 runner 事件拆成多条旧 IPC：`assistant:chunk`、`assistant:tool`、`assistant:done`、`assistant:error`、`assistant:permission-request` 等。
- `turn-controller` 管 busy/phase。
- `session-turn-state` 作为 deprecated 旧接口继续被引用。
- `turn-boundary` 和 `session-events` 只处理用户提交和 turn 结束。
- renderer 的 `message.js` 直接操作 DOM，同时维护 active turn、active bubble、tool cards、permission prompts、queue、engine notices。
- `sessionManager` 又在 turn 结束时写 assistant message，renderer 再 refresh state。

这导致实时回复、最终回复、历史消息、工具过程、权限交互没有一个明确的所有权。最终表现就是：用户问一句后等待很久、反馈不稳定、回复可能重复、Markdown 可能变成一整坨、切换会话后 UI 容易错位。

## 成功标准

重构完成后，一次问答必须满足：

- 用户发送后 300ms 内出现明确的“已发送/正在启动”状态。
- CLI 有任何 stream-json 事件时，UI 能即时呈现对应进度。
- assistant 文本只存在一个 live buffer，最终只落一条 assistant 历史消息。
- 工具调用、权限确认、AskUserQuestion、hook callback 都挂在同一个 turn 下。
- session 切换不丢 live turn，不把别的 session 的事件渲染到当前会话。
- interrupt、排队、自动恢复都由同一个状态机决定，不靠 DOM 状态猜测。
- renderer 只消费一个主事件通道，不再同时消费 chunk/done/session-events 多套 transcript mutation。

## 根因诊断

### 1. Transcript 和 live turn 混在一起

当前 [src/renderer/modules/message.js](../src/renderer/modules/message.js) 既渲染历史消息，又渲染实时 turn，还处理工具、权限、队列、engine notice。它既是视图层，也是状态机，也是消息 store。

这会带来两个问题：

- DOM 成了状态来源，`hasLiveTurn()`、`activeBubble`、`activeMarkdown` 会影响业务判断。
- turn 结束时既有 streamed text，又有 `sessionManager.pushMessageTo()` 的最终文本，还可能有 `session-events` 的 `turn-ended`，容易重复或乱序。

### 2. IPC 通道过多

当前主进程通过 `wireRunner()` 发出多条 IPC：

- `assistant:chunk`
- `assistant:tool`
- `assistant:tool-upcoming`
- `assistant:tool-input-delta`
- `assistant:tool-input-done`
- `assistant:tool-done`
- `assistant:permission-request`
- `assistant:user-question`
- `assistant:hook-request`
- `assistant:engine-notice`
- `assistant:done`
- `assistant:error`
- `assistant:session-events`
- `assistant:turn-state`

这里面一部分是状态，一部分是 transcript mutation，一部分是 timeline mutation。renderer 必须自己拼顺序，顺序一错就会出现“等半天没有回应”或“最后糊成一坨”。

### 3. 状态机分散

目前状态相关代码分布在：

- [src/main/turn-controller.js](../src/main/turn-controller.js)
- [src/main/session-turn-state.js](../src/main/session-turn-state.js)
- [src/main/turn-message-queue.js](../src/main/turn-message-queue.js)
- [src/main/turn-boundary.js](../src/main/turn-boundary.js)
- [src/main/turn-auto-recovery.js](../src/main/turn-auto-recovery.js)
- [src/main/agent-session.js](../src/main/agent-session.js)

`session-turn-state.js` 已经标记 deprecated，但仍作为旧接口存在。`turn-controller` 是正确方向，但它还没有成为唯一状态机。

### 4. AgentSession 职责过重

[src/main/agent-session.js](../src/main/agent-session.js) 同时做：

- CLI 进程生命周期。
- stream-json 解析。
- tool lease 追踪。
- permission/hook response。
- turn timeout。
- background activity 判断。
- fallback complete。
- UI 事件 emit。

CLI 进程和协议解析应该留在这里，但 UI 层语义不应该从这里直接散发到十几个 IPC。

## 目标架构

重构后采用单向流：

```text
Claude CLI stream-json
  -> AgentSession
  -> RuntimeEvent
  -> TurnOrchestrator
  -> SessionRuntimeBatch IPC
  -> Renderer SessionRuntimeStore
  -> Chat View
```

### 1. AgentSession：只负责 CLI 和协议适配

保留：

- `spawn(claude, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", ...])`
- stdin 写入用户消息。
- stdout JSONL 解析。
- stderr 采集。
- interrupt control request。
- permission / AskUserQuestion / hook response 写回 CLI。
- resume id 采集。

删除或迁出：

- 直接 emit UI 语义事件。
- turn 级状态判断。
- renderer 展示文案。
- queue/recovery 决策。

AgentSession 输出统一的 `RuntimeEvent`：

```js
{
  id: "evt_...",
  sessionId,
  turnId,
  seq,
  type: "assistant.delta",
  payload: { text: "..." },
  ts
}
```

建议事件类型：

```text
turn.started
turn.accepted
assistant.delta
assistant.message_stop
tool.started
tool.input.delta
tool.input.done
tool.done
permission.requested
permission.resolved
user_question.requested
user_question.resolved
hook.requested
hook.resolved
engine.notice
engine.stderr
usage.updated
resume.updated
turn.completed
turn.failed
turn.interrupted
turn.stalled
```

### 1.1 CLI Host Protocol：我们和 Claude CLI 的唯一边界

文档必须把 CLI 对接协议写清楚，否则重构时很容易又把 UI 状态、业务状态和 CLI 原始事件混在一起。最合理的做法是把 Claude CLI 当成一个 **JSONL 双向协议进程**，而不是终端，也不是 SDK。

#### 启动协议

主进程只允许通过一个 runner factory 启动 Claude CLI：

```js
spawn(agentCommand, [
  "-p",
  "--verbose",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--prompt-suggestions", "true",
  "--permission-mode", permissionMode,
  "--permission-prompt-tool", "stdio",
  ...disallowedTools,
  ...addDirs,
  ...resumeArgs
], {
  cwd,
  env,
  stdio: ["pipe", "pipe", "pipe"]
})
```

关键约束：

- stdin 必须只写 JSONL，一行一个 JSON。
- stdout 必须只按 JSONL 读取，一行一个 JSON。
- stderr 不参与协议解析，只进入 `engine.stderr` / resume failure 诊断。
- 不能用终端文本解析作为主链路。
- 不能把 SDK event shape 当成协议来源。

#### Host -> CLI：用户消息

用户输入通过 [src/main/user-message.js](../src/main/user-message.js) 构造成一行 JSON：

```js
{
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "text", text },
      { type: "image", source: { type: "base64", media_type, data } },
      { type: "document", source: { type: "base64", media_type, data } }
    ]
  },
  session_id: agentResumeId,          // resume 时才带
  parent_tool_use_id: parentToolUseId // 子 agent / tool 上下文需要时才带
}
```

规则：

- UI 展示用的文件 metadata 和 CLI 输入 blocks 分开。
- 图片/文档转 base64 只发生在协议层。
- 普通附件退化为 text block，包含文件路径。
- `session_id` 是 Claude CLI resume id，不是我们自己的 app session id。
- 我们自己的 `sessionId` 永远只存在 RuntimeEvent / Orchestrator / TranscriptStore 中。

#### Host -> CLI：控制消息

控制消息通过 [src/main/control-protocol.js](../src/main/control-protocol.js) 构造，仍然是一行 JSON 写入 stdin。

权限允许：

```js
{
  type: "control_response",
  response: {
    subtype: "success",
    request_id,
    response: {
      behavior: "allow",
      updatedInput,
      updatedPermissions
    }
  }
}
```

权限拒绝：

```js
{
  type: "control_response",
  response: {
    subtype: "success",
    request_id,
    response: {
      behavior: "deny",
      message
    }
  }
}
```

拒绝后可以额外发送 cancel：

```js
{
  type: "control_cancel_request",
  request_id
}
```

Host 主动控制：

```js
{ type: "control_request", request_id, request: { subtype: "initialize", promptSuggestions: true } }
{ type: "control_request", request_id, request: { subtype: "interrupt" } }
{ type: "control_request", request_id, request: { subtype: "set_permission_mode", mode } }
{ type: "update_environment_variables", variables }
```

hook callback response：

```js
{
  type: "control_response",
  response: {
    subtype: "success",
    request_id,
    response: {
      hookSpecificOutput: {
        continue: true,
        permissionDecision: "allow" | "deny",
        updatedInput
      }
    }
  }
}
```

规则：

- 所有 control response 必须能按 `request_id` 找到 pending request。
- Orchestrator 是唯一能决定 allow/deny/interrupt 的上层模块。
- AgentSession 只负责把 Orchestrator 的决定序列化写入 stdin。
- 超时、取消、interrupt 必须产生 RuntimeEvent，不允许静默吞掉。

#### CLI -> Host：stdout 事件分类

stdout 读到的每一行 JSON 先进入 `cli-event-adapter.js`，再变成 RuntimeEvent。adapter 必须覆盖以下类型。

系统事件：

```js
{ type: "system", subtype: "init", session_id, cwd, model, permissionMode, tools }
{ type: "system", subtype: "thinking_tokens", estimated_tokens, estimated_tokens_delta }
{ type: "system", subtype: "status", status }
{ type: "system", subtype: "compact_boundary" | "compact_complete" }
{ type: "system", subtype: "api_retry", attempt, max_retries, error }
{ type: "system", subtype: "permission_denied" }
```

映射：

- `system:init` -> `session.hydrated` + `resume.updated`
- `thinking_tokens` -> `usage.updated`
- `status` / task events -> `engine.notice`
- compact/api retry/permission denied -> `engine.notice` 或 `engine.warning`

assistant 消息：

```js
{
  type: "assistant",
  session_id,
  message: {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "tool_use", id, name, input }
    ]
  }
}
```

映射：

- text block -> `assistant.delta` 或 `assistant.snapshot`。如果 CLI 给的是完整 assistant message 而不是 delta，也统一追加到 live buffer。
- tool_use block -> `tool.started`，如果 input 已完整则同时发 `tool.input.done`。

stream event：

```js
{ type: "stream_event", event: { type: "message_start" } }
{ type: "stream_event", event: { type: "content_block_start", index, content_block } }
{ type: "stream_event", event: { type: "content_block_delta", index, delta } }
{ type: "stream_event", event: { type: "content_block_stop", index } }
{ type: "stream_event", event: { type: "message_delta", delta, usage } }
{ type: "stream_event", event: { type: "message_stop" } }
```

映射：

- `message_start` -> `turn.accepted`
- `text_delta` -> `assistant.delta`
- `input_json_delta` -> `tool.input.delta`
- `content_block_stop` -> `tool.input.done` 或 `assistant.message_stop`
- `message_delta.usage` -> `usage.updated`
- `message_stop` -> 不直接结束 turn，只表示模型消息块结束。真正结束优先等 `result`。

tool result：

```js
{
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id, content, is_error }
    ]
  }
}
```

映射：

- `tool_result` -> `tool.done`

控制请求：

```js
{
  type: "control_request" | "sdk_control_request",
  request_id,
  request: {
    subtype: "can_use_tool" | "permission",
    tool_name,
    tool_input,
    input,
    suggestions
  }
}
```

映射：

- 普通 tool -> `permission.requested`
- `AskUserQuestion` -> `user_question.requested`
- `ExitPlanMode` -> `permission.requested`，UI 用计划审批样式展示

hook callback：

```js
{
  type: "control_request",
  request_id,
  request: {
    subtype: "hook_callback",
    hook_event: {
      hook,
      tool_name,
      tool_input,
      permissionDecision,
      reason
    }
  }
}
```

映射：

- `PreToolUse` + `permissionDecision: "ask"` -> `hook.requested`
- `Stop` / `SubagentStop` -> `hook.requested`
- `PostToolUse` / `SessionStart` / `PreCompact` / `Notification` -> `engine.notice` 并自动 ack

result / error：

```js
{
  type: "result",
  subtype: "success" | "error",
  session_id,
  is_error,
  result,
  usage
}
```

映射：

- success -> `turn.completed`
- error/is_error -> `turn.failed`
- usage -> `usage.updated`

规则：

- `result` 是 turn 终态的第一优先级。
- 如果没有 `result`，`message_stop` 后进入 grace timer，超时后按 live buffer 生成 `turn.completed` 或 `turn.stalled`。
- process close 不是正常业务终态，只能作为兜底；如果已有终态事件，close 不再生成第二个终态。

#### 协议层职责边界

```text
AgentSession
  只负责进程、JSONL 读写、pending request 原始表、stdin 序列化。

cli-event-adapter
  只负责 raw CLI event -> RuntimeEvent draft。

TurnOrchestrator
  只负责 turn 状态、queue、recovery、终态事件、transcript commit。

Renderer
  只消费 RuntimeEvent，不接触 Claude raw event。
```

禁止跨层：

- renderer 不允许知道 `control_response` 格式。
- TurnOrchestrator 不允许解析 `content_block_delta`。
- AgentSession 不允许 push transcript。
- cli-event-adapter 不允许决定 canSend/canInterrupt。

#### 最合理做法

最合理的对接方式是：**保持 Claude CLI 原生 stream-json + stdio control protocol，自己定义稳定的 RuntimeEvent 作为产品内部协议**。

原因：

- CLI 层保留全部 Claude Code 原生能力。
- RuntimeEvent 层屏蔽 Claude 原始事件变化。
- TurnOrchestrator 层解决用户体验问题：实时反馈、排队、中断、恢复、权限等待。
- Renderer 不再关心 CLI 细节，只负责渲染稳定事件。

不要做：

- 不要直接把 Claude raw JSON 透给 renderer。
- 不要在 renderer 拼 `control_response`。
- 不要用纯文本终端解析作为主链路。
- 不要让 SDK 替代 CLI 协议。

#### 不考虑 PTY

本轮重构不考虑 PTY，也不把终端文本解析作为兜底方案。Claude 主链路只使用：

```text
Claude stream-json stdout events
stdio control_request / control_response
session transcript / resume artifacts
file diff snapshot
```

原则：

- stdout 只读取 JSONL。
- stdin 只写 JSONL。
- stderr 只做错误诊断，不参与正常事件流。
- 文件 diff 只证明“改了什么”，不推断“正在想什么”。
- UI 不展示伪终端，不依赖终端文本。

最终统一为：

```text
Claude CLI stream-json
  -> Runtime Adapter
  -> RuntimeEvent Bus
  -> Timeline / Diff / Audit
```

### 2. TurnOrchestrator：唯一回合状态机

新增 `src/main/turn-orchestrator.js`，吸收现有：

- `turn-controller`
- `turn-message-queue`
- `turn-boundary`
- `turn-auto-recovery` 的调度部分

状态固定：

```text
idle
starting
streaming
tool_running
awaiting_user
recovering
interrupting
finalizing
```

状态机只做这些决定：

- 当前 session 能否发送新消息。
- 新消息是立即发送、排队、还是 interrupt-and-send。
- CLI 事件如何改变 phase。
- turn 什么时候真正结束。
- turn 结束时是否触发 queued message。
- 失败是否自动恢复。
- 什么时候写入 transcript。

状态机不直接操作 DOM，不拼 UI 文案。

### 3. TranscriptStore：只存定稿消息

当前 `sessionManager.pushMessageTo()` 应该只在两个场景调用：

- 用户消息被接受后，写入 user message。
- turn finalizing 时，写入唯一 assistant final message。

不允许：

- 每个 chunk 写历史。
- renderer 根据 refresh state 再补 live reply。
- error/done 多路径各自 push assistant。

历史消息结构建议扩展：

```js
{
  id,
  role: "user" | "assistant",
  content,
  files,
  failed,
  turnId,
  createdAt,
  meta: {
    interrupted,
    stalled,
    usage,
    toolsSummary
  }
}
```

### 4. IPC：一条主通道

新增：

```text
assistant:runtime-events
```

payload：

```js
{
  sessionId,
  batchSeq,
  events: RuntimeEvent[]
}
```

保留但降级为辅助：

- `state:full` / full state 初始化。
- `assistant:file-diff`，因为 diff panel 是独立功能。
- 设置类 IPC。

删除或停止 renderer 消费：

- `assistant:chunk`
- `assistant:tool`
- `assistant:tool-upcoming`
- `assistant:tool-input-delta`
- `assistant:tool-input-done`
- `assistant:tool-done`
- `assistant:permission-request`
- `assistant:user-question`
- `assistant:hook-request`
- `assistant:engine-notice`
- `assistant:done`
- `assistant:error`
- `assistant:session-events`
- `assistant:turn-state`

实现期可以短时间双写做对照，但提交前必须删除旧消费路径，否则混乱还会回来。正式交付不允许同时启用旧 transcript 链路和目标 runtime 链路。

### 5. Renderer SessionRuntimeStore：前端唯一运行时状态

新增 `src/renderer/modules/session-runtime-store.js`。

每个 session 一份状态：

```js
{
  sessionId,
  committedMessages: [],
  liveTurn: null | {
    turnId,
    phase,
    assistantText,
    tools: Map,
    permissions: Map,
    questions: Map,
    hooks: Map,
    notices: [],
    usage,
    startedAt,
    updatedAt
  },
  queue: []
}
```

renderer 的规则：

- `assistant.delta` 只更新 `liveTurn.assistantText`。
- `tool.*` 只更新 `liveTurn.tools`。
- `permission.requested` 只更新 `liveTurn.permissions`。
- `turn.completed` 把 liveTurn 转成 finalized assistant view，再清空 liveTurn。
- `turn.failed` 同样 finalizes，一条失败 assistant message。
- session 切换只切 active sessionId，不重建 live turn。

UI 不再从 DOM 推断状态。

### 6. Preload API：收口到运行时协议

当前 [src/preload.js](../src/preload.js) 暴露了十几个 listener，等于把旧链路固化成前端公共 API。重构后 assistant 相关 API 必须收口。

保留 invoke：

```js
sendMessage(text, files, sessionId, displayFiles)
interruptAndSend(text, files, sessionId, displayFiles)
retryLastMessage(sessionId)
respondPermission(sessionId, requestId, allow, options)
respondUserQuestion(sessionId, requestId, answers, response)
respondHook(sessionId, requestId, allow, options)
interrupt(sessionId)
cancelQueuedMessage(sessionId, itemId)
getRuntimeSnapshot(sessionId)
getFullState()
```

新增唯一主 listener：

```js
onRuntimeEvents(callback) {
  ipcRenderer.on("assistant:runtime-events", (_event, batch) => callback(batch));
}
```

最终删除这些 listener：

```text
onChunk
onDone
onError
onStatus
onTool
onToolUpcoming
onToolInputDelta
onToolInputDone
onToolDone
onPermissionRequest
onUserQuestion
onPermissionCancelled
onHookRequest
onHookResolved
onEngineNotice
onTurnState
onAutoRecover
onSessionEvents
onQueueState
onQueueDispatchFailed
```

`onPromptSuggestions` 可以暂时保留，因为它不是 transcript mutation；后续也可以归入 `prompt_suggestions.updated` RuntimeEvent。

### 7. state:full：只能返回 committed history

当前 [src/main/ipc-handlers.js](../src/main/ipc-handlers.js) 的 `state:full` 把 `session.messages` 全量塞给 renderer，这是合理的初始化方式，但必须明确：这里返回的永远只能是 committed messages，不能包含 live turn。

重构后 `state:full` 建议增加 runtime snapshot 摘要：

```js
{
  projects,
  activeProjectId,
  activeSessionId,
  conversations: {
    [sessionId]: committedMessages
  },
  runtime: {
    sessions: {
      [sessionId]: {
        phase,
        turnId,
        canSend,
        canInterrupt,
        queueLength
      }
    }
  }
}
```

renderer 启动顺序：

```text
getFullState()
  -> hydrate committed messages
  -> hydrate runtime snapshots
  -> subscribe onRuntimeEvents
  -> if active session is running, request getRuntimeSnapshot(activeSessionId)
```

这样刷新/重启后不会把半截 live reply 写进历史。

## 删除清单

### 第一批：迁移后删除

- `src/main/session-turn-state.js`
  - 已 deprecated，重构后不再保留 thin wrapper。

- `src/main/session-events.js`
  - 被 `assistant:runtime-events` 替代。

- `src/main/turn-boundary.js`
  - 职责并入 `TurnOrchestrator.finalizeTurn()`。

- `src/renderer/modules/session-event-applier.js`
  - 被 `session-runtime-store.js` 替代。

### 第二批：合并后删除或瘦身

- `src/main/turn-message-queue.js`
  - 队列逻辑进入 TurnOrchestrator。

- `src/main/turn-auto-recovery.js`
  - 保留错误分类可抽成 `turn-recovery-policy.js`，调度进入 TurnOrchestrator。

- `src/renderer/modules/turn-store.js`
  - busy 状态并入 SessionRuntimeStore。

- `src/renderer/modules/session-busy.js`
  - 只保留兼容导出一版，最终删除。

- `src/main/runtime/opencode-runtime-reducer.js`
  - OpenCode 路径已经改为“官方事件 -> Lily runtime drafts/会话副作用”的直接 reducer。
  - 不再保留 `OpencodeEventAdapter`、`opencode-event-normalizer`、`runtime-event-translator` 这类 action 中转层。
  - Claude CLI 路径如后续重构，也应采用同样原则：协议事件直接归约成 RuntimeEvent draft，而不是再绕一套通用 action vocabulary。

- `src/main/runtime/adapters/claude-cli-adapter.js`
  - 合并进 `cli-event-adapter.js`，避免 adapter 套 adapter。

### 第三批：重写

- `src/renderer/modules/message.js`
  - 当前文件过大，必须拆成：
    - `chat-view.js`
    - `chat-runtime-renderer.js`
    - `tool-timeline-view.js`
    - `permission-panel.js`
    - `message-list.js`

- `src/main/ipc-utils.js`
  - 当前文件混合了 send preflight、runner wiring、turn completion、queue、auto recovery。重构后只保留小型通用 IPC helper，业务逻辑迁到 TurnOrchestrator。

- `src/main/interrupt-and-send.js`
  - 当前会同时 queue、interrupt、finish turn、发 `assistant:done`，必须并入 TurnOrchestrator，避免双终态。

## 新模块设计

### main/runtime-event-schema.js

职责：

- 定义 RuntimeEvent 创建函数。
- 生成 event id。
- 校验必要字段。
- 提供测试用 helper。

建议 API：

```js
createRuntimeEvent({
  type,
  sessionId,
  turnId,
  payload,
  source = "claude-cli",
  raw = null
})

assertRuntimeEvent(event)
isTerminalEvent(event)
isUserBlockingEvent(event)
```

事件必须包含：

```js
{
  id,
  type,
  sessionId,
  turnId,
  seq,
  ts,
  source,
  payload
}
```

其中 `seq` 是 session 内递增序号，不是全局序号。renderer 只按同一 session 的 `seq` 去重和排序。

### main/cli-event-adapter.js

职责：

- 替代当前 `claude-event-normalizer.js` + `runtime-events.js` 的交叉映射。
- 输入 Claude 原始 stream-json。
- 输出 RuntimeEvent draft。

保留 fixtures：

- `fixtures/claude-runtime/*.jsonl`
- `scripts/test-claude-runtime-fixtures.mjs`

但 expected 结果改成 RuntimeEvent。

旧代码映射关系：

```text
claude-event-normalizer.normalizeClaudeEvent()
  -> actions
runtime-events action-to-runtime mapper
  -> runtimeEvents
AgentSession._onJsonEvent()
  -> emit("chunk/tool/permission/done/notice")
```

目标映射关系：

```text
Claude raw JSONL
  -> cli-event-adapter.toRuntimeEvents(raw, context)
  -> RuntimeEvent[]
```

adapter 需要保留现有能力：

- `control_request` / `sdk_control_request` 解析。
- `AskUserQuestion` 结构化。
- `hook_callback` 区分 PreToolUse、PostToolUse、Stop、SubagentStop、SessionStart、PreCompact、Notification。
- `content_block_start` 建 tool placeholder。
- `input_json_delta` 累加 tool input。
- `tool_result` 绑定 tool id。
- `system` task/status/compact/api_retry/permission_denied 转 notice。
- unknown event 输出 `runtime.warning`，但不阻塞 turn。

### main/turn-orchestrator.js

职责：

- `sendUserMessage(sessionId, text, files, opts)`
- `handleRuntimeEvent(event)`
- `respondPermission(sessionId, requestId, decision)`
- `respondUserQuestion(sessionId, requestId, response)`
- `respondHook(sessionId, requestId, decision)`
- `interrupt(sessionId)`
- `interruptAndSend(sessionId, text, files, opts)`
- `cancelQueuedMessage(sessionId, itemId)`
- `snapshot(sessionId)`

它是唯一能改变 turn phase 的地方。

建议构造参数：

```js
new TurnOrchestrator({
  sessionManager,
  projectManager,
  runnerPool,
  transcriptStore,
  eventBus,
  stagingManager,
  skillManager,
  licenseManager
})
```

核心内部状态：

```js
{
  sessionId,
  phase,
  turnId,
  assistantText,
  pendingTools: Map,
  pendingPermissions: Map,
  pendingHooks: Map,
  queue: [],
  recovery: null,
  lastError: null,
  startedAt,
  updatedAt
}
```

禁止事项：

- 不允许 renderer 直接改变 phase。
- 不允许 AgentSession 自己决定 queue。
- 不允许 `sessionManager.pushMessageTo()` 出现在 Orchestrator/TranscriptStore 之外。
- 不允许一个 turn 产生两个终态事件。

终态事件定义：

```text
turn.completed
turn.failed
turn.interrupted
turn.stalled
```

每个 `turnId` 最多只能有一个终态事件。测试必须覆盖。

### main/runtime-event-bus.js

职责：

- 每个 session 维护 `batchSeq`。
- 批量发送 `assistant:runtime-events`。
- 保证同一 session 内严格有序。

建议 API：

```js
emit(sessionId, event)
emitBatch(sessionId, events)
snapshot(sessionId)
subscribeWindow(mainWindow)
```

批量策略：

- 同一 tick 内合并，减少 IPC 频率。
- `assistant.delta` 可以 50-100ms 节流，但终态事件不允许延迟超过一 tick。
- 同一 session 内保证顺序；不同 session 不要求全局顺序。

### main/transcript-store.js

职责：

- 封装 `sessionManager.pushMessageTo()`。
- 给消息补 `id`、`turnId`、`timestamp`、`meta`。
- 限制历史只写 committed user/assistant。

建议 API：

```js
commitUserMessage(sessionId, { text, files, turnId })
commitAssistantMessage(sessionId, { text, failed, turnId, meta })
removeLastAssistantMessage(sessionId)
getCommittedMessages(sessionId)
```

这一步会替代 `SessionManager._appendMessage()` 的匿名消息结构。`sessionManager` 可以继续负责持久化，但消息写入入口必须上移到 TranscriptStore。

### main/runner-factory.js

当前 `ensureSessionRunner()` 在 `ipc-utils.js` 内部，职责太重。建议抽出：

```js
ensureRunnerForSession(sessionId, { spawn })
resolveRunnerEnvironment(session)
diagnoseSendBlocker(sessionId)
```

这样 TurnOrchestrator 不需要依赖 `ipc-utils.js` 这个大杂烩。

### renderer/session-runtime-store.js

职责：

- 消费 `assistant:runtime-events`。
- 做 session 分桶。
- 维护 liveTurn。
- 对外提供 selectors：
  - `canSend(sessionId)`
  - `canInterrupt(sessionId)`
  - `getLiveTurn(sessionId)`
  - `getMessages(sessionId)`
  - `getQueue(sessionId)`

### renderer/chat-runtime-renderer.js

职责：

- 把 store state 渲染到 DOM。
- 不做业务判断。
- 不直接调用 assistantClient。

它只接收 store diff：

```js
renderSession(sessionId)
renderRuntimeEvent(event)
finalizeTurn(sessionId, turnId)
```

### renderer/message-list.js

职责：

- 渲染 committed messages。
- 只处理普通 user/assistant bubble。
- assistant bubble 永远走 Markdown renderer。
- 不包含 tool/permission/live turn 逻辑。

### renderer/live-turn-view.js

职责：

- 渲染 liveTurn。
- 一个 turn 一个 DOM root。
- 一个 assistant live text card。
- 多个 tool cards。
- 多个 permission/question/hook prompt。
- notices 独立显示。

live turn 完成后调用 `seal(turnId)`，不可再修改。

### renderer/permission-panel.js

职责：

- 根据 `permission.requested`、`user_question.requested`、`hook.requested` 渲染交互。
- 用户操作只调用 preload invoke，不直接改 store。
- store 只等 main 发 resolved event 后移除 prompt。

## 最终问答体验形态

目标不是“聊天框等待最终答案”，而是一个 **连续的 Agent 工作流消息**。用户问一句后，assistant 的同一条回复里要自然穿插：当前想法、过程摘要、工具调用、文件变更、最终结论。

内部可以有 `turn.started`、`assistant.delta`、`tool.started`、`turn.completed` 这些 RuntimeEvent，但 UI 不应该直接暴露这些协议词。用户看到的是自然语言状态和可折叠过程。

### 页面结构

最终一个会话页建议分成三个主要区域：

```text
┌ Header ───────────────────────────────────────────┐
│ 会话标题 / 项目路径 / 权限模式 / 当前状态 / 停止按钮 │
├ Main Chat ────────────────────────────────────────┤
│ User bubble                                       │
│ Assistant Turn Article                            │
│   ├─ Thinking / status line                       │
│   ├─ Streaming narrative                          │
│   ├─ Collapsible tool groups                      │
│   ├─ Permission / question prompt                 │
│   ├─ Changed files summary                        │
│   └─ Final answer                                 │
└ Composer ─────────────────────────────────────────┘
```

说明：

- `Main Chat` 是主体验，不隐藏过程。
- `Assistant Turn Article` 是一个完整的 assistant 回合，不要拆成“live 容器 + final message”两个视觉主体。
- 过程摘要和工具调用默认轻量展示，可展开查看详情。
- `Streaming narrative` 是 assistant 正在说的话，只累加一份 live buffer。
- 文件变更摘要内嵌在回合里，详细 diff 可点击展开或进入侧栏。
- `Composer` 忙时仍可输入，发送会进入队列。

### Chat Turn 视觉规格

重构后的聊天展示应参考截图里的形态：一个用户问题对应一个完整的 assistant turn，assistant turn 内部连续呈现过程、工具、状态和最终回答。不要把每次工具调用、状态消息、最终回答拆成多条孤立的 assistant 消息。

推荐结构：

```text
Assistant Turn Article
  ├─ Header / status
  │   WorkBuddy / 深度思考 · 1s / Worked for 44s
  ├─ Narrative stream
  │   自然语言进度说明，像普通回答一样排版
  ├─ Inline tool command rows
  │   which pandoc                         终端已运行
  │   python3 -c "..."                     终端已运行
  ├─ Collapsed process groups
  │   > 工具调用 3 · 过程消息 1
  │   > 已探索 1 文件
  │   > 1 变更文件
  ├─ Separator
  └─ Final markdown answer
      标题、列表、表格、代码块正常渲染
```

视觉规则：

- Assistant turn 是无边框或弱边框的文章流，不使用大面积卡片包住整段内容。
- 用户消息可以保持右侧气泡；assistant 消息靠左，以文章方式展示。
- 状态行使用弱化颜色和小字号，例如“深度思考 · 1s”“Worked for 44s”。
- 过程文本直接内联显示，不要每一句都套卡片。
- 命令类工具使用单行弱边框 command row，左侧是命令摘要，右侧是状态，例如“终端已运行”“已接受”“失败”。
- 多个工具调用默认聚合成 `工具调用 N · 过程消息 M`，展开后才显示完整 command、cwd、耗时、stdout/stderr 摘要。
- 文件读取、搜索、变更文件可以用 `已探索 N 文件`、`N 变更文件` 这种折叠摘要。
- 最终回答前要有清晰但克制的分隔线，表示过程区结束、最终结论开始。
- 最终回答仍在同一个 Assistant Turn Article 内，不创建第二条 assistant bubble。
- 深色和浅色主题都必须保持相同信息层级：过程弱化，最终回答最高可读性，工具行可扫读但不抢正文。

实现不变量：

- 一个 `turnId` 只能对应一个 Assistant Turn Article DOM root。
- `assistant.delta` 追加到当前 turn 的 narrative/final live buffer，不能创建新消息。
- `tool.*`、`engine.notice`、`queue.updated`、`recovery.*` 只能更新当前 turn 的过程区。
- `turn.completed` 只 seal 当前 turn，并把 live buffer 定稿为同一篇文章里的 final answer。
- committed transcript 里只落一条 assistant message，但 UI 可以从 message meta 还原折叠过程摘要。

### 正确的 UI 流程

用户点击发送后：

```text
0ms
  User bubble 立即出现
  Composer 进入 busy 状态
  Assistant Turn Article 出现

<300ms
  如果还没有任何 CLI 事件，显示轻量状态：正在启动...

第一条有效事件
  状态改成：正在思考 / 正在分析项目
  不显示 message_start 这类协议名

助手开始输出
  直接流式显示自然语言
  例如：我先检查登录流程和 token 处理。

工具开始
  在同一 assistant 回合里插入轻量工具行或工具组
  例如：工具调用 3 · 过程消息 1

工具完成
  工具组计数更新
  有文件改动时出现“变更文件 N”摘要

回合完成
  同一 assistant 回合定稿
  过程组默认折叠
  Composer 恢复可发送
```

用户看到的形态：

```text
你：
  帮我检查登录失败的问题

助手：
  正在分析登录流程。

  我先看 token 生成和校验逻辑。

  > 工具调用 2 · 过程消息 1

  问题在 token 过期后没有清理缓存...

  > 变更文件 1

  已修复，并跑过相关验证。
```

### 工具和过程的展示方式

工具调用不应该刷屏，也不应该只出现在最终总结里。最佳形态是 **内联、分组、默认折叠**：

```text
> 工具调用 3 · 过程消息 1
  读取 package.json
  搜索 "authToken"
  执行 npm test
```

对于命令类工具，可以像截图里那样展示一行命令摘要：

```text
which pandoc                                      已运行
python3 -c "import reportlab; print('ok')"        已运行
```

规则：

- `tool.started` 时立即出现卡片，即使 input 还没完整。
- `tool.input.delta` 更新命令或文件路径预览。
- `tool.done` 显示结果摘要。
- 大结果默认折叠，只显示前几行和状态。
- 失败工具以 warning 样式展示，但不等于 turn 失败。
- 连续多个工具调用要自动合并成一个工具组，避免对话被工具刷满。
- 工具组可展开，展开后能看 command、cwd、耗时、结果摘要。

### 过程消息的展示方式

`engine.notice`、thinking/status、compact、retry、recovery 不应该都做成大卡片。最佳形态：

```text
深度思考 · 1s
已搜索 3 个文件
正在执行测试...
```

规则：

- 高频状态合并展示，只保留最新状态。
- 关键过程可以沉淀到“过程消息 N”。
- 普通用户默认看摘要，高级用户可以展开看完整过程。

### 权限确认的 UI 流程

当 CLI 发出 `control_request`：

```text
Assistant Turn Article
  等待确认：执行命令 npm test

Prompt
  需要你的确认
  npm test
  [批准] [拒绝] [批准并记住]
```

状态规则：

- Composer placeholder 显示“等待你确认”。
- 用户可以切换会话，回来后 prompt 还在。
- 批准/拒绝后，prompt 消失，Timeline 记录结果。
- 超时必须显示 `permission.timeout`，不能静默卡住。

### AskUserQuestion 的 UI 流程

当 CLI 需要用户补充信息：

```text
Assistant Turn Article
  助手需要你补充信息

Prompt
  你希望优先修复哪一类问题？
  ○ 启动失败
  ○ 登录失败
  ○ 打包失败
  [提交]
```

规则：

- 这是 turn 的一部分，不是新用户消息。
- 回答通过 `control_response` 写回 CLI。
- 回答后继续原 turn。

### 排队消息 UI 流程

用户在助手运行中继续输入：

```text
Composer
  发送按钮显示：加入队列

Assistant Turn Article 底部
  队列中 2 条
  1. 再帮我跑一下测试
  2. 顺便看下打包
```

规则：

- 队列项按 id 管理，不按 index 作为业务标识。
- 当前 turn 结束后自动发送下一条。
- queue.updated 是唯一队列 UI 来源。

### interrupt-and-send UI 流程

用户点击“停止并发送新问题”：

```text
旧 Assistant Turn Article
  标记为：已中断
  如果已有回答文本，保留为中断回答
  如果没有回答文本，只保留过程摘要

新 User bubble
  立即出现

新 Assistant Turn Article
  立即启动
```

规则：

- 旧 turn 只产生一个 `turn.interrupted`。
- 新消息作为新 turn，不和旧 turn 混在同一个 DOM root。
- 不再额外发 `assistant:done`。

### 自动恢复 UI 流程

网络或上游错误可恢复时：

```text
Assistant Turn Article
  ⚠ 连接中断，准备自动重试 1/2
  ◷ 正在重新连接...
  ✓ 已恢复，继续处理
```

规则：

- 不重复提交 user bubble。
- 恢复失败才生成 failed assistant message。
- 恢复成功后继续显示在同一个用户问题下面。

### 最终消息形态

turn 结束后，页面应该留下：

```text
User message
Assistant turn article
  Final markdown answer
  Collapsed tool/process summary
  Changed files summary
```

示例：

```text
助手
  问题原因是登录 token 过期后没有清理缓存...

  > 工具调用 6 · 过程消息 2
  > 变更文件 2

  修改：
  - src/main/auth.js
  - src/renderer/modules/session.js

  验证：
  - npm test 通过
```

最终回答必须满足：

- Markdown 正常渲染。
- 表格、代码块、列表不会糊成一段。
- 不重复展示 streamed answer 和 final answer。
- 工具和过程可以折叠，但不能丢。

## 关键流程

### 普通问答

```text
User submit
  -> TurnOrchestrator accepts
  -> TranscriptStore writes user message
  -> RuntimeEvent turn.started
  -> AgentSession writes JSON line to CLI stdin
  -> CLI emits message_start
  -> RuntimeEvent turn.accepted
  -> CLI emits text deltas
  -> RuntimeEvent assistant.delta
  -> Renderer updates one Assistant Turn Article
  -> CLI emits result/message_stop
  -> RuntimeEvent turn.completed
  -> TranscriptStore writes one assistant message
  -> Renderer seals the same Assistant Turn Article
```

### 工具调用

```text
CLI content_block_start tool_use
  -> tool.started
  -> Renderer creates tool card

CLI input_json_delta
  -> tool.input.delta
  -> Renderer updates same tool card input

CLI tool_result
  -> tool.done
  -> Renderer completes same tool card
```

### 权限确认

```text
CLI control_request can_use_tool
  -> permission.requested
  -> Turn phase awaiting_user
  -> Renderer shows prompt
  -> User approves/denies
  -> TurnOrchestrator.respondPermission()
  -> AgentSession writes control_response
  -> permission.resolved
  -> Turn phase resumes streaming/tool_running
```

### AskUserQuestion

```text
CLI can_use_tool AskUserQuestion
  -> user_question.requested
  -> Renderer shows structured questions
  -> User answers
  -> AgentSession writes allow updatedInput
  -> user_question.resolved
```

### 排队消息

```text
User submits while phase != idle
  -> TurnOrchestrator queues item
  -> RuntimeEvent queue.updated
  -> Current turn finalizes
  -> Orchestrator starts next queued item
  -> RuntimeEvent user.committed + turn.started in same batch
```

### interrupt-and-send

当前 [src/main/interrupt-and-send.js](../src/main/interrupt-and-send.js) 会产生额外 `assistant:done`，这是双终态风险。新流程：

```text
User interrupt-and-send
  -> TurnOrchestrator.clearQueue(sessionId)
  -> TurnOrchestrator.enqueueFront(newMessage, priority=true)
  -> RuntimeEvent queue.updated
  -> AgentSession.interrupt()
  -> RuntimeEvent turn.interrupted for old turn
  -> Orchestrator finalizes old turn once
  -> Orchestrator starts priority queued item
  -> RuntimeEvent user.committed + turn.started
```

规则：

- 如果旧 turn 已经有 assistantText，保存为 interrupted assistant message。
- 如果旧 turn 没有 assistantText，只结束 live turn，不写空 assistant。
- 不发送旧 `assistant:done`。
- 不允许 interrupted turn 再触发 auto recovery。

### auto recovery

当前 [src/main/turn-auto-recovery.js](../src/main/turn-auto-recovery.js) 会直接发 `assistant:auto-recover`、`assistant:engine-notice`、`assistant:error` 并写 assistant。新流程：

```text
turn.failed with recoverable error
  -> phase recovering
  -> RuntimeEvent recovery.scheduled
  -> delay
  -> restart runner
  -> resend same engine payload without committing new user message
  -> RuntimeEvent recovery.started
  -> if success, continue same turnId or replacement turnId by policy
  -> if exhausted, RuntimeEvent turn.failed
```

推荐策略：恢复保持同一个 user committed message，但开启新的 `turnId`，并通过 `recoveredFromTurnId` 关联。这样排查日志更清晰，也避免旧 turn 终态事件被改写。

### resume invalid

当前 `resume-invalid` 会清 resume id、reset cache、terminate runner，并提示用户重发。新流程：

```text
CLI stderr resume failure
  -> RuntimeEvent resume.invalid
  -> Orchestrator clears agentResumeId
  -> Orchestrator terminates runner
  -> RuntimeEvent turn.failed { code: "RESUME_INVALID", retryable: true }
```

UI 上显示“连接已刷新，请重新发送”，但这个失败仍然只是一条终态事件。

## 迁移计划

### Phase 1：定义协议，不改 UI

目标：

- 新增 RuntimeEvent schema。
- 改造 `claude-event-normalizer` 测试，证明所有 fixture 能转成 RuntimeEvent。
- AgentSession 内部先继续 emit 旧事件，同时旁路生成 RuntimeEvent。

验收：

- `node scripts/test-claude-runtime-fixtures.mjs` 通过。
- 新增 `scripts/test-runtime-event-schema.mjs` 通过。

实现时可以在本地短时间保留旧 UI 做行为对照，但这只是开发辅助，不是产品形态。阶段结束时必须删除 fallback，不能把“新旧两套链路可切换”留进代码。

### Phase 2：新增 RuntimeEventBus，开始双写

目标：

- `wireRunner()` 继续旧 IPC。
- 同时通过 `assistant:runtime-events` 发送统一事件。
- renderer 暂时只记录日志，不渲染。

验收：

- 一次普通问答能看到完整 RuntimeEvent 顺序。
- 不出现 sessionId/turnId 为空的业务事件。

额外验收：

- `preload.js` 暴露 `onRuntimeEvents`。
- renderer 记录 RuntimeEvent 顺序日志，方便对照旧 UI。
- 每个 turn 终态事件计数为 1。

### Phase 3：Renderer 新 store 接管普通文本流

目标：

- `assistant.delta` 和 `turn.completed` 由 SessionRuntimeStore 渲染。
- 停止消费 `assistant:chunk` 和 `assistant:done` 的文本落地逻辑。

验收：

- 普通长回复不会变成一大坨。
- 最终 assistant 消息只出现一次。
- Markdown 最终渲染正确。

这个阶段必须同时删除或禁用：

- `window.assistantClient.onChunk(...)`
- `window.assistantClient.onDone(...)` 中的文本 finalize 逻辑
- `materializeTurnEnded()` 对 assistant text 的补写逻辑

### Phase 4：工具、权限、问题接管

目标：

- 工具卡片改为消费 `tool.*` RuntimeEvent。
- 权限弹窗改为消费 `permission.*`。
- AskUserQuestion 改为消费 `user_question.*`。
- hook prompt 改为消费 `hook.*`。

验收：

- `ExitPlanMode` 可审批。
- `AskUserQuestion` 可回答并继续。
- tool input streaming 不重复建卡。
- 拒绝权限后 turn 不死锁。

这个阶段必须同时删除或禁用：

- `onTool`
- `onToolUpcoming`
- `onToolInputDelta`
- `onToolInputDone`
- `onToolDone`
- `onPermissionRequest`
- `onUserQuestion`
- `onHookRequest`
- `onEngineNotice`

### Phase 5：队列、恢复、interrupt 收敛

目标：

- 队列进入 TurnOrchestrator。
- auto recovery 进入 TurnOrchestrator。
- interrupt 只产生 `turn.interrupted` / `turn.completed` 一条终态。

验收：

- 忙时发送进入队列，当前 turn 结束后自动发送下一条。
- interrupt-and-send 不出现两个 assistant 结尾。
- resume 失败能提示并允许重发。

这个阶段必须同时删除或禁用：

- `assistant:queue-state`
- `assistant:auto-recover`
- `assistant:queue-dispatch-failed`
- `interrupt-and-send.js`
- `turn-boundary.js`

### Phase 6：删除旧链路

目标：

- 删除旧 IPC 消费和旧模块。
- `message.js` 拆分。
- 测试只断言 RuntimeEvent。

验收：

- `rg "assistant:chunk|assistant:done|assistant:session-events|session-turn-state"` 不再命中生产代码。
- 保留的命中只能在迁移文档或测试 fixture 中。

### Phase 7：性能和体验打磨

目标：

- 首次反馈 < 300ms。
- delta 渲染节流 50-100ms。
- Markdown final render 不阻塞输入。
- 大工具结果截断展示，但完整结果可展开/复制。

验收：

- 5,000 字回复流式期间 UI 不明显卡顿。
- 20 个 tool events 不造成 DOM 重排抖动。
- 切换 session 后 100ms 内显示对应历史和 live 状态。

## 代码级替换表

| 当前位置 | 当前职责 | 目标归宿 |
| --- | --- | --- |
| `agent-session.js` | CLI + 状态 + UI emit + timeout | 只保留 CLI、stdin/stdout、control response、raw event forwarding |
| `claude-event-normalizer.js` | raw event -> action | 合并进 `cli-event-adapter.js` |
| `runtime-events.js` | action -> runtime event | 删除，由 adapter 直接产 RuntimeEvent |
| `ipc-utils.js#wireRunner` | runner event -> many IPC | 删除，改为 AgentSession -> Orchestrator -> RuntimeEventBus |
| `ipc-utils.js#dispatchUserLine` | 发送、排队、写历史、vision、状态 | 拆到 TurnOrchestrator + RunnerFactory + TranscriptStore |
| `turn-controller.js` | phase 状态 | 并入 TurnOrchestrator |
| `turn-message-queue.js` | queue | 并入 TurnOrchestrator |
| `turn-boundary.js` | turn end + queued item batch | 并入 TurnOrchestrator finalization |
| `turn-auto-recovery.js` | recovery 调度 + UI emit + 写历史 | 策略保留，调度并入 TurnOrchestrator |
| `interrupt-and-send.js` | interrupt + queue + done | 并入 TurnOrchestrator |
| `session-events.js` | user committed / turn ended batch | 删除，RuntimeEvent 替代 |
| `message.js` | 全部 chat UI 状态和渲染 | 拆分成 store + views |
| `turn-store.js` | busy state | 并入 SessionRuntimeStore |
| `session-event-applier.js` | session-events 应用 | 删除 |

## 最小可用新协议

第一版必须支持这些事件，少一个都不算完成：

```text
session.hydrated
user.committed
turn.started
turn.accepted
assistant.delta
assistant.final
tool.started
tool.input.delta
tool.input.done
tool.done
permission.requested
permission.resolved
user_question.requested
user_question.resolved
hook.requested
hook.resolved
queue.updated
recovery.scheduled
recovery.started
engine.notice
engine.warning
usage.updated
resume.updated
turn.completed
turn.failed
turn.interrupted
turn.stalled
```

`assistant.final` 只用于 main 内部调试或测试夹具，不建议作为 renderer 必需事件。正式 renderer 应以 `turn.completed.payload.assistant` 作为唯一最终文本来源，避免 `assistant.final` 和 `turn.completed` 双写。

## 一步到位执行策略

用户体验已经被旧链路拖累，最终交付只能保留目标链路。推荐采用 **branch 内分阶段实现，产品内一次切换**：

```text
开发阶段：
  允许旧链路 + 目标链路短时间双写，用日志和测试对照。

合并前：
  renderer 只消费 assistant:runtime-events。
  main 不再发送旧 transcript mutation IPC。
  preload 删除旧 listener。
  旧模块删除或从生产代码断开。
```

也就是说，Phase 不是发布节奏，而是编码顺序。真正交给用户的版本只能有一条最合理的目标链路。

一步到位的最小交付边界：

- 普通问答全链路走目标架构。
- 工具调用全链路走目标架构。
- 权限、AskUserQuestion、hook 全链路走目标架构。
- queue、interrupt-and-send、auto recovery 全链路走目标架构。
- 旧 `chunk/done/session-events/turn-state` transcript 路径删除。

不接受的中间态：

- 文本走目标链路，但工具还走旧 IPC。
- done 还靠 `assistant:done` finalize。
- queue 还靠 `assistant:queue-state`。
- renderer 还从 DOM 判断 busy/live turn。

## 事件不变量

必须写进测试：

- 每个 `event.id` 唯一。
- 同一 session 内 `seq` 单调递增。
- 业务事件必须有 `sessionId`。
- turn 内事件必须有 `turnId`。
- 一个 `turnId` 最多一个终态事件。
- 终态事件之后，同一 `turnId` 不再接受 `assistant.delta` / `tool.*` / `permission.*`。
- `assistant.delta` 只能追加到 live buffer，不写 transcript。
- transcript 写入 assistant 只能发生在 terminal finalization。
- renderer 收到重复 batchSeq 必须忽略。
- renderer 收到旧 seq 必须忽略。

## 用户体验硬指标

为了质的飞跃，不能只保证“功能通”。需要加硬指标：

- 点击发送后 300ms 内：
  - 用户气泡出现。
  - live turn shell 出现。
  - composer 变成 busy/queue 状态。
- 10 秒无 Claude 首包：
  - 显示 `waitingForFirstResponse` notice。
- 30 秒无 Claude 首包：
  - 显示 `longWait` notice，允许 interrupt。
- 工具开始 300ms 内：
  - tool card 出现，哪怕 input 还没完整。
- 权限请求 300ms 内：
  - prompt 出现，composer 显示 awaiting user。
- turn terminal 后 500ms 内：
  - live turn sealed。
  - composer 可继续输入或自动发送队列下一条。

## 必须覆盖的测试

### 单元测试

- Claude basic text stream -> `assistant.delta` + `turn.completed`
- tool_use + input_json_delta + tool_result -> tool lifecycle
- permission can_use_tool -> permission lifecycle
- AskUserQuestion -> question lifecycle
- hook_callback -> hook lifecycle
- stderr before first token -> visible notice but不直接失败
- result missing -> fallback completed/stalled
- interrupted -> exactly one terminal event（即只有一个终态事件）
- duplicate terminal event -> rejected or ignored（重复终态事件必须拒绝或忽略）
- event after terminal -> ignored and logged
- queue item id cancel -> exact item removed, not index based
- state snapshot -> committed history excludes live turn

### 集成测试

- 普通问答。
- 长 Markdown 回复。
- 工具调用后继续回复。
- Plan mode 审批。
- 用户问题回答。
- 正在执行时追加问题进入队列。
- interrupt-and-send。
- session 切换回来仍显示 live turn。
- app 重启后历史只显示 committed messages，不显示 live 残影。
- recovery 只提交一次 user message。
- resume invalid 后重发不会重复上一条 assistant。
- permission pending 时切 session 再切回来，prompt 仍在。

### UI 验收

- 发送后立刻出现用户气泡和“正在启动”。
- 10 秒无首 token 显示“仍在等待”。
- 30 秒无首 token 显示更明确的 long wait。
- 工具执行中有工具卡片，不是空白等待。
- 最终回答 Markdown 正常分段、列表、代码块、表格。
- 最终回答不会重复。
- interrupt-and-send 旧 turn 和新 turn 边界清楚。
- 队列显示按 id 操作，不因 index 变化误删。

## 推荐第一批实现顺序

如果要一步到位，建议按这个顺序开工：

1. 新增 `runtime-event-schema.js` 和测试。
2. 新增 `cli-event-adapter.js`，把 fixtures expected 切到 RuntimeEvent。
3. 新增 `runtime-event-bus.js`，preload 增加 `onRuntimeEvents`。
4. 新增 `transcript-store.js`，所有 assistant/user committed 写入走它。
5. 新增 `turn-orchestrator.js`，先接管 send/terminal/queue/interrupt。
6. 改 `AgentSession`：不再 emit UI 事件，改为向 Orchestrator 交 raw event / runtime event。
7. 新增 renderer `session-runtime-store.js`。
8. 新增 renderer `live-turn-view.js` 和 `message-list.js`。
9. `message.js` 只保留外壳 glue，逐步迁出旧 handler。
10. 删除旧 IPC listener 和旧模块。

第一批 PR 不应该只做“协议定义”，否则还是会拖。最小可落地 PR 应该至少完成普通文本问答全链路目标架构，包括：

- send
- user committed
- assistant delta
- turn completed
- transcript commit
- renderer final markdown
- no old chunk/done consumption

## 风险和处理

### 风险：一次性删除太多导致不可用

处理：

- 允许 Phase 2 到 Phase 4 双写。
- 但每个 Phase 必须明确关闭一条旧消费路径。
- 不允许长期双写。

### 风险：Claude CLI 事件格式变化

处理：

- adapter 对未知事件输出 `runtime.warning`。
- 未知事件进入 debug log，不阻断 turn。
- fixture 增加 unknown-runtime 测试。

### 风险：turn.completed 早于工具完成

处理：

- TurnOrchestrator 维护 pending tools / pending permissions / background activity。
- CLI result 到达时如果仍有 pending work，进入 `finalizing`，不立即落 assistant。

### 风险：renderer 和 main 状态不一致

处理：

- main 是权威状态。
- renderer 只接受 RuntimeEvent。
- renderer 可请求 `assistant:runtime-snapshot` 修复丢包。

## 不做的事

- 不切 SDK。
- 不把 Claude CLI 放进终端模拟器里解析纯文本。
- 不继续扩大 `message.js`。
- 不继续维护两套 turn 状态。
- 不让 renderer 根据 DOM 判断业务状态。

## 最终文件结构建议

```text
src/main/
  agent-session.js                 # CLI process only
  cli-event-adapter.js              # raw Claude event -> RuntimeEvent
  runtime-event-schema.js
  runtime-event-bus.js
  turn-orchestrator.js
  transcript-store.js
  permission-response-service.js

src/renderer/modules/
  session-runtime-store.js
  chat-view.js
  chat-runtime-renderer.js
  message-list.js
  tool-timeline-view.js
  permission-panel.js
```

## 最终判断

这次应该按“协议层重构”处理，不应该再修单点 bug。

旧链路最大的问题是没有唯一事实来源。正确做法是让 main 进程成为 turn 和 transcript 的事实来源，让 renderer 只消费统一事件并渲染。这样既保留 Claude CLI 的完整能力，又能把 UI 交互做得像 Claude CLI 一样实时、连续、可中断、可恢复。
