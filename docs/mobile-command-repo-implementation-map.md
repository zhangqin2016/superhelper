# Lily Mobile Command Pro Repo Implementation Map

## 1. Purpose

This document maps the Mobile Command Pro design to concrete repository locations. It defines files to create, files to touch only for wiring, and files that must not receive new responsibilities.

## 2. Implementation Principles

- Add new cohesive modules instead of growing existing large files.
- Main process owns desktop capabilities and local security decisions.
- Server owns account/device/session routing, not screen or input content.
- Mobile Web app owns UI, state, protocol validation, and command experience.
- Native shell owns only system capabilities.
- All capability-affecting paths need fail-open / fail-safe tests.

## 3. Desktop Main Process

Create:

```text
src/main/mobile-control/
  index.js
  mobile-control-service.js
  pairing-service.js
  device-registry.js
  cloud-relay-client.js
  signaling-client.js
  rtc-session-manager.js
  screen-capture-service.js
  input-control-service.js
  clipboard-bridge.js
  file-transfer-service.js
  agent-mobile-bridge.js
  permission-policy.js
  approval-service.js
  audit-log-service.js
  remote-health-service.js
  protocol.js
  config.js
```

### 3.1 Wiring Files

Touch only for lifecycle wiring:

```text
src/main.js
src/main/ipc-handlers.js
src/main/config.js
src/main/client-config-service.js
```

Rules:

- `src/main.js` may start/stop `mobile-control-service`.
- `ipc-handlers.js` may expose pairing QR/status only.
- No remote protocol logic in IPC files.
- No OS input logic outside `input-control-service.js` and platform adapters.

### 3.2 Existing Modules To Reuse

| Need | Existing module |
|---|---|
| app icon | `src/main/app-icon.js`, `resources/icon*` |
| file staging | `src/main/file-staging-manager.js` |
| artifacts | `src/main/artifact-registry.js` |
| sessions | `src/main/session-*`, `agent-session.js`, `turn-orchestrator.js` |
| config | `client-config-service.js`, `config.js` |
| crypto helpers | `crypto-signing.js` if suitable |

Read exports before using. Do not duplicate staging, artifact, or session stores.

### 3.3 Platform Adapters

Create:

```text
src/main/mobile-control/platform/
  windows-input-helper.js
  macos-input-helper.js
  linux-input-helper.js
  screen-source-adapter.js
  permission-detector.js
```

Native binaries or helper scripts, if needed:

```text
resources/mobile-control/
  win32/
  darwin/
  linux/
```

No helper may accept arbitrary script text.

## 4. Shared Protocol Code

Create:

```text
src/shared/mobile-command/
  ids.js
  error-codes.js
  permission-levels.js
  event-types.js
  schemas.js
  validators.js
```

If repo prefers ESM/CJS consistency, follow existing local style.

Generated or source schemas:

```text
docs/schemas/mobile-command.openapi.yaml
docs/schemas/mobile-command-events.schema.json
docs/schemas/mobile-command-native-bridge.schema.json
```

Consumers:

- server route validation
- desktop event validation
- mobile app typed client
- tests

## 5. Server

Create:

```text
server/src/routes/public/mobile-pairing.js
server/src/routes/public/mobile-devices.js
server/src/routes/public/remote-sessions.js
server/src/routes/public/remote-signaling.js
server/src/routes/public/remote-turn.js
server/src/routes/public/remote-uploads.js
server/src/services/mobile-device-service.js
server/src/services/remote-session-service.js
server/src/services/remote-signaling-service.js
server/src/services/remote-audit-service.js
server/src/services/remote-upload-service.js
server/src/services/turn-credential-service.js
```

Touch:

```text
server/src/routes/public/index.js
server/src/db.js
```

Migrations:

```text
server/migrations/YYYYMMDDHHMM_mobile_command.sql
```

Migration must include:

- tables
- unique indexes
- lookup indexes
- additive-only changes
- rollback notes if repo convention supports rollback

## 6. Mobile Web App

Preferred location if using current `web/`:

```text
web/mobile-command/
  app/
  components/
  services/
  state/
  domain/
  storage/
  telemetry/
  native/
```

Alternative if `web/` structure makes route isolation hard:

```text
mobile/
```

Decision rule:

- Use `web/mobile-command/` if build tooling can isolate PWA bundle cleanly.
- Use `mobile/` if Next.js marketing/admin constraints would couple release cycles.

## 7. Native Capability Shell

If using Capacitor:

```text
mobile-native/
  capacitor.config.ts
  ios/
  android/
  plugins/
    lily-secure-key/
    lily-background-upload/
    lily-share/
    lily-permissions/
```

The native shell loads the mobile web bundle. It does not contain business UI.

## 8. Tests

Create:

```text
scripts/test-mobile-protocol-schema.mjs
scripts/test-mobile-error-contract.mjs
scripts/test-mobile-idempotency.mjs
scripts/test-mobile-signature-replay.mjs
scripts/test-remote-session-permissions.mjs
scripts/test-remote-approval-policy.mjs
scripts/test-remote-device-revocation.mjs
scripts/test-remote-agent-bridge.mjs
scripts/test-remote-session-isolation.mjs
scripts/test-remote-file-transfer.mjs
scripts/test-remote-upload-idempotency.mjs
scripts/test-remote-upload-hash.mjs
scripts/test-remote-upload-risk.mjs
scripts/test-remote-artifact-download.mjs
scripts/test-remote-signaling-contract.mjs
scripts/test-remote-webrtc-state-machine.mjs
scripts/test-remote-datachannel-backpressure.mjs
scripts/test-remote-input-protocol.mjs
scripts/test-mobile-native-bridge-schema.mjs
scripts/test-mobile-ui-states.mjs
```

Tests should be auto-discovered by the existing test runner.

## 9. Files Not To Grow With New Responsibilities

Do not put new remote-control business logic in:

```text
src/main/ipc-handlers.js
src/main/agent-session.js
src/main/turn-orchestrator.js
src/renderer/app.js
src/renderer/modules/message.js
```

These may receive minimal integration hooks only.

## 10. Implementation Order

1. Shared constants and schemas.
2. Permission-policy pure module and tests.
3. Server migrations and device/session routes.
4. Desktop mobile-control service skeleton behind feature flag.
5. Pairing and device registry.
6. Agent mobile bridge.
7. Mobile Command UI.
8. Upload service and staging bridge.
9. WebRTC signaling and state machine.
10. Screen capture and input adapters.
11. Native shell capabilities.
12. Audit, telemetry, release gates.

## 11. Acceptance

- A developer can identify the owner file for each responsibility.
- Existing session/file/artifact systems are reused.
- Feature disabled path starts desktop exactly as today.
- Tests fail if remote-control logic bypasses permission policy.
