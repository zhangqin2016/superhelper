# Claude Runtime Protocol Adapter

## Decision

Claude CLI must be treated as a runtime protocol, not as terminal text. Raw CLI
events now enter `src/main/claude-event-normalizer.js`, which converts them into
stable app-level action kinds before `AgentSession` mutates turn state or emits
IPC events.

## Why

The previous shape scattered raw event handling across `AgentSession` and UI
flows. That made every new Claude CLI event shape look like an isolated bug:
empty AskUserQuestion cards, stuck turns, unknown control requests, or user
messages being queued instead of answering a pending runtime question.

## Contract

- New Claude CLI raw event handling belongs in `normalizeClaudeEvent()`.
- `AgentSession` handles normalized action kinds only.
- Unknown runtime events must produce a visible protocol warning unless they are
  known high-frequency internal telemetry.
- AskUserQuestion payloads are normalized at the protocol boundary.
- Renderer and IPC should not depend on Claude CLI raw event names.

## Verification

- `node scripts/test-agent-runner.mjs`
- `node scripts/test-agent-tool-lease.mjs`
- `npm run test:unit`
- `npm --prefix web run build`
