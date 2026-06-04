# Claude Runtime Protocol Adapter

## Decision

Claude CLI must be treated as one runtime backend, not as terminal text and not
as UI state. Raw CLI events now enter
`src/main/runtime/adapters/claude-cli-adapter.js`. The adapter uses the Claude
parser in `src/main/claude-event-normalizer.js`, then emits stable Runtime
Events plus compatibility actions for the current IPC/UI layer.

## Why

The previous shape scattered raw event handling across `AgentSession` and UI
flows. That made every new Claude CLI event shape look like an isolated bug:
empty AskUserQuestion cards, stuck turns, unknown control requests, or user
messages being queued instead of answering a pending runtime question.

The new boundary lets future backends implement the same adapter contract:

```text
Claude CLI / Codex CLI / other CLI
  -> Runtime Adapter
  -> Runtime Events
  -> Turn state + compatibility IPC projection
  -> Renderer
```

## Contract

- New Claude CLI raw event handling belongs behind `ClaudeCliAdapter`.
- `normalizeClaudeEvent()` is the Claude parser, not the app architecture
  boundary.
- `AgentSession` handles Runtime adapter output only. Existing action kinds are
  kept as a compatibility projection until the renderer is fully migrated.
- Stable runtime event types include `assistant.text`, `tool.started`,
  `tool.done`, `permission.requested`, `turn.progress`, `turn.result`,
  `runtime.warning`, and `runtime.error`.
- Background activity and shell detached/long-running classification lives in
  `src/main/runtime/runtime-activity.js`.
- Unknown runtime events must produce a visible protocol warning unless they are
  known high-frequency internal telemetry.
- AskUserQuestion payloads are normalized at the protocol boundary.
- Renderer and IPC should not depend on Claude CLI raw event names.

## Verification

- `node scripts/test-agent-runner.mjs`
- `node scripts/test-agent-tool-lease.mjs`
- `node scripts/test-runtime-adapter.mjs`
- `npm run test:unit`
- `npm --prefix web run build`
