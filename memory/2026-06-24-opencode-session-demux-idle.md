# OpenCode Session Demux Idle Boundary

## Symptom

The UI could show a new task card while the assistant answer body belonged to a previous or different task, making sessions appear crossed.

## Root Cause

`opencode serve` uses one shared event stream for many sessions. Lily's per-session `OpencodeServerManager` demux dropped unowned `session.error` and message events, but still delivered generic session events with no `sessionID`/`messageID` as directory events. Since `opencode-runtime-reducer` treats `session.idle` as the turn terminal signal, an unowned `session.idle` could be delivered to every busy same-directory session view.

The runner does a status confirmation before completing, but that is a recovery check, not an ownership boundary. The correct boundary is the demux layer: session lifecycle events without a session id must not be broadcast to all views.

## Fix

`src/main/runtime/opencode-event-ownership.js` now fails closed for unowned events. Only an explicit allowlist of directory-safe events may broadcast without `sessionID`/`messageID`; unowned turn-affecting events such as `session.idle`, bare `idle`, `todo.updated`, `permission.*`, and `question.*` are dropped with `reason: "missing_session_id"` instead of being delivered as directory events. Existing unowned `session.error`/`message.error` diagnostics still use the dedicated `unowned_error_diagnostic` drop path.

## Verification

- `node scripts/test-opencode-server-manager.mjs`
- `node scripts/test-opencode-concurrency-stress.mjs`
- `node scripts/test-opencode-runtime-reducer.mjs`
- `node scripts/test-opencode-agent-session.mjs`
- `npx electron scripts/test-renderer-import.cjs`

`npm run test:unit` on Node v16.19.0 reached 144/160 passing. Failures were environment/runtime capability issues unrelated to the demux change: missing global `fetch`/`FormData`, missing `node:sqlite`, missing `diagnostics_channel.tracingChannel`, and an ESM-loading mismatch in `verify-edit`.
