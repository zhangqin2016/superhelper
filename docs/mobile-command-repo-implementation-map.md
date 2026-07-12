# Lily Mobile Command Pro Repository Implementation Map

## 1. Status And Rules

This MC-SPEC-036 map separates verified current owners from planned placement. It does not authorize production implementation. Current evidence is canonical in [MC-SPEC-005](mobile-command-existing-system-integration.md); planned names below may change when the data, auth, agent-bridge, API, and native contracts are accepted.

- Extend the current route, lifecycle, turn, event, config, IPC, migration, and logging seams.
- Do not call private `serviceFetch` or signing helpers, raw OpenCode runtime APIs, or `OpencodeAgentSession.sendUserMessage` from Mobile Command.
- Local capability remains the strong default; remote authority ambiguity fails safe.

## 2. Verified Current Owners

| Responsibility | Existing owner | Planned use boundary |
|---|---|---|
| Server route composition | `server/src/app.js:91-114`; `server/src/routes/public.js:14-37` | Register one additive public route plugin through `publicRoutes` |
| User/device/session/license identity | `server/src/routes/public/auth.js:88-111,114-260`; `server/src/services/device-identity.js:13-164`; `server/migrations/001_initial.sql:1-32`; `server/migrations/007_client_config_profiles.sql:43-56`; `server/migrations/022_account_wallet.sql:1-63` | Reference existing IDs; add remote-specific relations instead of parallel base identities |
| Region and effective config | `server/src/services/client-bootstrap.js:1-124`; `server/src/routes/public/client-config.js:61-175`; `src/main/remote-config.js:275-326` | Add versioned policy/config fields without merging the two delivery paths |
| Authenticated desktop service requests | `src/main/service-client.js:465-525,827-859` | Add reviewed exported wrapper methods; private transport/signing functions are not an integration API |
| Conversation and command entry | `src/main/turn-orchestrator.js:841-925,3437`; `src/main/ipc-assistant.js:106,176`; `src/main/scheduled-tasks.js:276` | Inject only through `TurnOrchestrator.sendUserMessage` |
| Engine message/event normalization | `src/main/runtime/opencode-message-parts.js:526-535`; `src/main/runtime/opencode-runtime-reducer.js:739-842`; `src/main/opencode-agent-session.js:1303-1350` | Project normalized Lily events; never forward raw engine events |
| Permission/question handling | `src/main/opencode-agent-session.js:1303-1350`; `src/main/turn-orchestrator.js:705-740,1184-1195` | Add remote eligibility/resolution around current permission/question semantics |
| Local artifact identity | `src/main/artifact-registry.js:175-277`; `src/main/turn-artifacts.js:264-357`; `src/main/turn-archive.js:15-49`; `src/main/session-artifact-backfill.js:8-29` | Source adapter only; add remote descriptors and authorization separately |
| Local attachment staging | `src/main/file-staging-manager.js:67-150,240`; `src/main/ipc-files.js:150-192` | Destination adapter only after remote upload verification |
| Lifecycle and IPC | `src/main.js:288-313`; `src/main/ipc-handlers.js:42-262`; `src/main/ipc-sessions.js:68-235,385-390` | Minimal service composition and dedicated local UI bridge |
| Logging | `src/main/logger.js:5-38`; `server/src/app.js:85-89`; `server/migrations/001_initial.sql:74-83` | Add redacted structured telemetry/audit owner |
| SQL migrations | `server/scripts/migrate.mjs:9-48`; `server/migrations/001_initial.sql`; `server/migrations/007_client_config_profiles.sql`; `server/migrations/022_account_wallet.sql` | Next ordered additive migration after schema contracts are accepted |

## 3. Planned Additive Placement

All paths in this section are **planned; they do not exist at the audited HEAD**.

```text
src/main/mobile-command/
  index.js
  service.js
  cloud-client.js
  pairing-controller.js
  remote-session-controller.js
  agent-bridge.js
  event-projector.js
  permission-policy.js
  artifact-source.js
  upload-staging-adapter.js
  signaling-client.js
  rtc-session-manager.js
  audit.js
  platform/
```

`agent-bridge.js` must delegate to the existing orchestrator. `event-projector.js` consumes normalized Lily events. `artifact-source.js` and `upload-staging-adapter.js` wrap only the verified local invariants; they do not turn current registries into network services. OS adapter filenames remain evidence-needed under MC-ADR-005–007.

```text
server/src/routes/public/mobile-command.js
server/src/services/mobile-command/
server/migrations/<next-sequence>_mobile_command.sql
```

The planned public registrar owns pairing, remote-session, permission resolution, signaling/TURN credential, upload, and artifact authorization endpoints after MC-SPEC-006–011 define them. It is registered from current `server/src/routes/public.js`; there is no `server/src/routes/public/index.js`.

```text
src/shared/mobile-command/
docs/schemas/mobile-command.openapi.yaml
docs/schemas/mobile-command-events.schema.json
docs/schemas/mobile-command-native-bridge.schema.json
```

Shared runtime placement is conditional on a later build/module-format audit. The three schema paths exist at audited HEAD `5b102d62` (`git ls-tree -r --name-only 5b102d62 docs/schemas`); executable shared validators are planned.

## 4. Mobile And Native Placement

MC-ADR-001 remains proposed: repository evidence alone does not prove that nesting an independently packaged PWA/native application in the current Next.js `web/` package is safe. Therefore neither `web/mobile-command/`, top-level `mobile/`, nor another repository is accepted here.

MC-ADR-002 likewise owns native-shell selection and paths. No `mobile-native/`, Capacitor, iOS, or Android project is a current interface or accepted placement.

## 5. Existing Files Allowed Only Narrow Wiring

| Current file | Allowed additive change after specification freeze |
|---|---|
| `server/src/routes/public.js` | Register the single Mobile Command public registrar |
| `src/main.js` | Construct/start/stop the service with existing lifecycle behavior preserved |
| `src/main/service-client.js` | Export narrow route wrappers; do not export general arbitrary fetch/sign primitives without a separate security review |
| `src/main/remote-config.js` | Read additive accepted fields and notify existing listeners |
| `src/main/ipc-handlers.js` | Compose a dedicated Mobile Command IPC handler module |
| `src/main/turn-orchestrator.js` | At most accept validated additive source/idempotency metadata; retain sole turn ownership |
| `src/main/opencode-agent-session.js` | No Mobile Command business logic; runtime adapter behavior only |
| `src/main/file-staging-manager.js` | No network/chunk/auth logic |
| `src/main/artifact-registry.js` | No remote authorization, retention, or download-token logic |

## 6. Planned Verification Placement

Tests remain planned under auto-discovered `scripts/test-*.mjs`. Minimum boundaries are route registration/OpenAPI coverage, identity and revocation, signature replay, command idempotency and session isolation, queue/steer fallback, permission/question authority, upload chunk/hash/risk, artifact authorization, event replay/backpressure, lifecycle disablement, config kill switches, and capability-gate fallback.

## 7. Dependency Order

1. Accept identity/data/auth and configuration semantics.
2. Accept API, event, native bridge, state, and error contracts.
3. Add migrations and server registrar behind disabled authority defaults.
4. Add desktop service composition, narrow service wrappers, and agent bridge.
5. Add remote event, permission/question, artifact, and upload adapters.
6. Select and add the mobile application/native shell only after MC-ADR-001/002 evidence.
7. Add signaling/WebRTC and OS adapters only after their evidence decisions.
8. Close audit, observability, compatibility, and release gates.

## 8. Acceptance Boundary

This map is repository-grounded when every current path exists and every nonexistent path is labeled planned. It is not implementation-ready until its dependent canonical artifacts and ADRs are accepted.
