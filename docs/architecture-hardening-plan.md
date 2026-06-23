# Architecture Hardening Plan

## Goal

Keep Lily Workbench maintainable as it grows into a desktop client, service
control plane, model gateway, plugin market, and admin console.

The priority is not cosmetic refactoring. The priority is reducing places where
future changes can accidentally break runtime state, security, deployment, or
model routing.

## Current Assessment

The overall product layering is sound:

```text
Desktop client
  -> service client / remote config
  -> Lily API control plane
  -> Lily /llm gateway
  -> native Anthropic-compatible providers or LiteLLM
```

The risky areas are concentrated, not everywhere:

| Area | Current shape | Risk |
| --- | --- | --- |
| `src/main/agent-session.js` | Large runtime adapter and process owner | High change risk; avoid broad edits without fixtures |
| `src/main/turn-orchestrator.js` + renderer runtime store | Same event semantics represented in two places | State drift and "looks stuck but still running" UI bugs |
| `server/src/routes/public.js` | Many public domains in one route file | Hard to review auth/signature boundaries |
| `server/src/routes/admin.js` | Many admin domains in one route file | Admin changes can affect unrelated pages |
| `server/src/services/model-gateway.js` | Provider registry, auth, protocol forwarding, and adapters in one file | Provider additions can break gateway auth or streaming |
| `deploy/baota/*.yml` | Repeated API env blocks | Easy to miss one deployment mode |
| `package.json` test script | One long serial command | Harder failure isolation |

## Refactor Rules

1. Preserve behavior first. No runtime rewrite without fixture coverage.
2. Split by ownership boundary, not by arbitrary file size.
3. Keep compatibility exports for one release cycle when moving modules.
4. Add or keep integration tests around every service boundary.
5. Do not mix UI redesign with runtime refactors.

## Execution Plan

### Phase 1: Low-risk server boundary cleanup

- Split model gateway into:
  - provider registry
  - token auth
  - Anthropic passthrough
  - OpenAI fallback adapter
  - Fastify routes
- Keep `server/src/services/model-gateway.js` as a compatibility facade.
- Verify with server integration tests and web build.

Status: completed.

- `model-gateway.js` is now the route/facade layer only.
- Provider registry lives in `server/src/services/model-gateway/providers.js`.
- Gateway token signing and verification live in
  `server/src/services/model-gateway/auth.js`.
- Anthropic passthrough lives in
  `server/src/services/model-gateway/anthropic-adapter.js`.
- OpenAI-compatible request/response/SSE conversion lives in
  `server/src/services/model-gateway/openai-adapter.js`.
- Client config merge, rollout, gateway URL detection, and gateway token
  injection live in `server/src/services/client-config.js`.
- Added `scripts/test-client-config-service.mjs` to lock down the extracted
  client-config behavior.
- Device registration, trial state, public-key persistence, request signature
  verification, nonce replay protection, and license scope checks live in
  `server/src/services/device-identity.js`.
- Public device registration and key rotation live in
  `server/src/routes/public/devices.js`.
- Public client config resolution and signing live in
  `server/src/routes/public/client-config.js`.
- Public license activation and verification live in
  `server/src/routes/public/licenses.js`.
- Public catalog endpoints live in `server/src/routes/public/catalog.js`.
- Public telemetry endpoints live in `server/src/routes/public/telemetry.js`.
- Admin summary, licenses, devices, usage, diagnostics, contacts, releases,
  plugins, audit logs, settings, and config profiles now live in focused
  `server/src/routes/admin/*.js` modules.
- Admin system settings and health checks live in
  `server/src/routes/admin/system.js`.
- Admin config profile CRUD/revision/rollback routes live in
  `server/src/routes/admin/config-profiles.js`.

Remaining:

- None for the low-risk server boundary cleanup. Keep the current compatibility
  aggregators for one release cycle.

### Phase 2: Route domain split

- Move public routes by domain:
  - devices
  - licenses
  - usage
  - releases
  - plugins
  - client config
  - diagnostics
  - contact
- Move admin routes by domain:
  - auth
  - summary
  - licenses
  - devices
  - settings
  - config profiles
  - diagnostics
- Keep one `routes/public.js` and `routes/admin.js` aggregator temporarily.

Status: completed for current route domains.

### Phase 3: Runtime event reducer convergence

- Define one normalized runtime event contract.
- Treat main-process orchestrator as event producer only.
- Treat renderer runtime store as a pure reducer only.
- Add fixture tests for active turn, queued turn, permission wait, tool-running,
  long-running shell, interrupted, stalled, and resume recovery.

Do not start this phase with a broad rewrite. Start by documenting the current
event contract and moving one turn outcome at a time behind tests.

Status: completed for the current production runtime path.

- Claude CLI raw output now enters through the runtime adapter boundary and is
  normalized before turn state, IPC, or renderer code consumes it.
- `TurnOrchestrator` owns active turn phase, queue, pending permissions,
  pending questions, pending hooks, terminal turn boundaries, and runtime
  snapshots.
- `RuntimeEventBus` is the production live-event transport. It sends ordered
  `assistant:runtime-events` batches and retains recent events for snapshot
  replay after session switching.
- `SessionRuntimeStore` is the renderer-side reducer for live turn state,
  committed messages, queue metadata, prompt suggestions, permissions, hooks,
  questions, tools, timeline, and terminal outcomes.
- Production code no longer consumes the old `assistant:chunk`,
  `assistant:done`, `assistant:session-events`, `assistant:turn-state`,
  `assistant:queue-state`, or direct `onTool` / `onPermissionRequest` style
  renderer IPC paths.
- Session switching now rehydrates the visible panel from durable conversation
  pages plus runtime snapshots without stopping a running session.
- Running-session history sync preserves not-yet-persisted local committed
  messages instead of letting a stale disk page clear the live view.
- `user.committed` events now carry the active `turnId`; renderer committed
  message identity uses `role + turnId` to avoid dropping same-turn assistant
  messages.
- The live architecture is documented in
  `docs/turn-event-architecture.md`.
- Regression coverage includes runtime fixtures, turn orchestration, renderer
  live-turn preservation, same-turn committed rendering, queue handling,
  runtime diagnostics, tool leases, and session bootstrap.

Remaining:

- Continue adding sanitized production runtime traces to
  `fixtures/claude-runtime/` when new Claude CLI protocol shapes appear.
- Keep `src/main/agent-session.js` fixture-first; do not broadly refactor it
  without adding replay coverage for the scenario being changed.
- Plugin/MCP automatic client installation and runtime invocation are not part
  of this phase; they remain a separate marketplace/runtime product loop.

### Phase 4: Deployment configuration dedupe

- Generate repeated API environment blocks from one documented list or move
  common settings into YAML anchors where Compose compatibility allows it.
- Add a compose config check for every deployment mode.

Status: completed. API containers now use `env_file: .env` for shared deploy
configuration, and `npm run deploy:baota:check` validates all supported Compose
mode combinations including LiteLLM overlays.

### Phase 5: Test command grouping

- Keep `test:unit` as all-up verification.
- Add grouped scripts:
  - `test:runtime`
  - `test:renderer`
  - `test:service`
  - `test:release`

Status: completed. `test:skills` was also added for skill, file-staging,
vision, and document-flow coverage.

## Non-goals

- Do not add another ad hoc runtime transport beside OpenCode official SDK +
  shared event stream in this cleanup.
- Do not redesign the chat UI in this cleanup.
- Do not rewrite the session storage format again unless a failing case proves
  it is needed.
