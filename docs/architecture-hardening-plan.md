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

Status: partially completed.

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
- Public catalog endpoints live in `server/src/routes/public/catalog.js`.
- Public telemetry endpoints live in `server/src/routes/public/telemetry.js`.
- Admin system settings and health checks live in
  `server/src/routes/admin/system.js`.
- Admin config profile CRUD/revision/rollback routes live in
  `server/src/routes/admin/config-profiles.js`.

Remaining:

- Continue splitting `server/src/routes/admin.js` by domain:
  licenses, devices, usage, diagnostics, releases, plugins, contacts, audit.
- Move public license activation / verification into a public license route
  module once admin license routes are also isolated.

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

### Phase 3: Runtime event reducer convergence

- Define one normalized runtime event contract.
- Treat main-process orchestrator as event producer only.
- Treat renderer runtime store as a pure reducer only.
- Add fixture tests for active turn, queued turn, permission wait, tool-running,
  long-running shell, interrupted, stalled, and resume recovery.

Do not start this phase with a broad rewrite. Start by documenting the current
event contract and moving one turn outcome at a time behind tests.

### Phase 4: Deployment configuration dedupe

- Generate repeated API environment blocks from one documented list or move
  common settings into YAML anchors where Compose compatibility allows it.
- Add a compose config check for every deployment mode.

### Phase 5: Test command grouping

- Keep `test:unit` as all-up verification.
- Add grouped scripts:
  - `test:runtime`
  - `test:renderer`
  - `test:service`
  - `test:release`

## Non-goals

- Do not replace Claude CLI runtime in this cleanup.
- Do not redesign the chat UI in this cleanup.
- Do not rewrite the session storage format again unless a failing case proves
  it is needed.
