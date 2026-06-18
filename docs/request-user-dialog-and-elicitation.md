# request_user_dialog / elicitation 控制响应

Date: 2026-06-19
Scope: 修复 host 对 CLI 入站 `request_user_dialog` / `elicitation` control_request 的
响应 schema；并记录"真渲染 refusal_fallback_prompt"为何被有意推迟。

逆向自 `@anthropic-ai/claude-code` 2.1.177（`/Users/zhangqin/aicode/claudeclidebug/cli.js`）。
符号为 minified 短名，跨版本会变——**集成永远按 `type`/`subtype` 等稳定字段解析，不要依赖符号名/偏移**。

## 背景

两类 control_request 会从 CLI 经 stdout 发给 host，host 必须按各自 schema 应答：

| subtype | 请求体 | 响应 schema（CLI 期望） |
|---------|--------|------------------------|
| `request_user_dialog` | `{ dialog_kind, payload, tool_use_id? }` | `W6K` = `{ behavior: "completed" \| "cancelled", result? }` |
| `elicitation` (MCP) | `{ message, requestedSchema, ... }` | `X6K` = `{ action: "accept" \| "decline" \| "cancel", content? }` |

`result` / `content` 都是**不透明、按场景私有**的：`request_user_dialog` 的 `result`
形状由具体 `dialog_kind` 的调用方约定；`elicitation` 的 `content` 形状由请求里的
`requestedSchema` 约定。

## 已修复的 bug（本次改动）

旧代码把两者都归一为 `user_input_request` 并用 `{ questions, answers }` 应答
（`approval-broker.js`）。该形状**两个 schema 都不满足** → CLI 判 `response_ignored`，
即"已处理"实为静默失败。

改动（surgical，仅两文件 + 测试）：

- `control-protocol.js`：新增 `buildUserDialogResponse` / `buildElicitationResponse`，
  分别产出 schema 正确的 `{behavior,...}` / `{action,...}`。
- `approval-broker.js`：
  - `handleUserInputRequest` 对 **非 elicitation** 的 input-control（即
    `request_user_dialog`）**立即回 `{behavior:"cancelled"}` 且不 park**——协议明文要求
    "对无法渲染的 kind 回 cancelled"，且不该弹一个答案会被丢弃的死 prompt。
  - `elicitation` 保留 prompt，答案回 `{action:"accept", content}`（content 由用户答案
    best-effort 组装），取消回 `{action:"cancel"}`。

原则：**每条入站 control_request 都回 schema 正确的响应；host 只在能忠实把答案翻译回
协议期望形状时，才弹交互式 prompt。**

测试：`scripts/test-control-protocol.mjs`、`scripts/test-approval-broker.mjs`。

## 为何不"真渲染" refusal_fallback_prompt（有意推迟）

`refusal_fallback_prompt` 的协议形状已逆向清楚，可实现：

- `dialog_kind` = `"refusal_fallback_prompt"`
- payload = `{ originalModel, fallbackModel, apiRefusalCategory?, guidanceText?, retractedMessageUuids? }`
- result(completed) = 枚举 `"retry_fallback" | "edit_prompt" | "cancelled"`（字符串，非对象）

但 stdio 下要让该对话**真正被 CLI 发出来**，需同时满足（`hQ9`/`LQ9`，cli.js）：

1. `hasStreamingInput=true` → 自动满足（`-p --input-format stream-json`），同时令
   `requestDialog` 非空、`sdkDialogHostActive=true`。
2. host 在发给 CLI 的 **`initialize` control_request**（host→CLI，当前集成根本没发）里声明
   `supportedDialogKinds:["refusal_fallback_prompt"]`，且必须是**第一条** initialize（后续
   initialize 走 reinit 短路，不再应用配置）。
3. **`switchModelsOnFlag` 设置必须为 false** —— 这是 CLI 端用户设置，**默认 true**，
   **stream-json 协议无法设置**。为 true 时 CLI 静默自动切到 fallback 模型，`hQ9` 返回
   `"setting"`，**根本不发对话**。

结论（结合本产品形态）：

- **默认配置下该对话永远不触发**（条件 3 不满足），所以"经典拒答错误"这处打折在默认下
  并不存在——用户得到的是自动切模型兜底。
- 本产品模型由**服务端下发**，且未配 fallback 模型（无 `ANTHROPIC_DEFAULT_FABLE_MODEL`）。
  "主模型拒答→路由到更宽松模型"这件事应在**服务端网关**做（确定、可控、可观测），不该靠
  CLI 客户端静默换模型——对"服务下发模型"的产品，客户端换模型反而是确定性风险。

因此真渲染 refusal_fallback_prompt 对本产品**无实际收益**，推迟。若将来需要（例如允许用户
关闭自动切模型），按上面 1–3 + result 枚举实现即可；条件 3 需在 CLI 配置侧（settings）关掉
`switchModelsOnFlag`，不能仅靠协议。
