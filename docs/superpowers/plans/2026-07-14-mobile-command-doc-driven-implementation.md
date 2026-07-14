# Mobile Command Doc-Driven Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive every Mobile Command item that is implementable from the current repository and docs, while keeping Phase 2/production capabilities gated until their evidence artifacts are accepted.

**Architecture:** Continue the current Phase 1 web demo path: server pairing/relay, desktop bridge/admission, mobile web pair page, local attachment materialization, and automated MC-TC/spec checks. Do not add WebRTC/TURN, OS input injection, ASR provider calls, push, native shells, or production privacy/ops controls until the relevant MC-SPEC/ADR rows move from `evidence-needed` to accepted.

**Tech Stack:** Electron main process, Fastify server, Next.js mobile web page, Node.js auto-discovered `scripts/test-*.mjs`, markdown MC-SPEC docs, JSON fixtures.

---

## Scope Classification

### Implementable Now

- Phase 1 demo hardening: delivery correlation, visible failure states, resend/reconnect clarity, image attachment retention, idempotency/correlation tests.
- Spec/test closure: executable validator for `docs/fixtures/mobile-command-test-fixtures.json` and `docs/mobile-command-test-cases.md`.
- Final-shape server-local capabilities: chat-level remote sessions plus upload/artifact transfer with typed guards and capability metadata.
- Documentation truth: docs must distinguish usable Phase 1 demo from blocked Phase 2/production capabilities.
- Additional fail-open guards around current command bridge, attachment handling, relay offline paths, and mobile UI state.

### Blocked Until Evidence

- WebRTC/TURN screen observation/control (`MC-SPEC-023`, `MC-SPEC-029`, `MC-ADR-004`).
- OS input injection helpers (`MC-SPEC-016`, `MC-SPEC-018`, `MC-SPEC-019`, `MC-ADR-005/006/007`).
- ASR provider integration and voice primary path (`MC-SPEC-017`, `MC-SPEC-021`, `MC-ADR-008`).
- Native iOS/Android shell, secure key, share sheet, push, background upload (`MC-SPEC-028`, `MC-SPEC-034`, `MC-ADR-002/009/010/012`).
- Production privacy/retention/observability/support/release gates (`MC-SPEC-023/024/025/034/035`).

---

### Task 1: Spec Closure Validator

**Files:**
- Create: `scripts/test-mobile-command-spec-closure.mjs`
- Modify: `docs/mobile-command-test-plan.md`
- Read-only inputs: `docs/fixtures/mobile-command-test-fixtures.json`, `docs/mobile-command-test-cases.md`

- [x] **Step 1: Verify the required command fails before implementation**

Run:

```bash
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-command-spec-closure.mjs --fixtures docs/fixtures/mobile-command-test-fixtures.json --manifest docs/mobile-command-test-cases.md
```

Expected before implementation: `MODULE_NOT_FOUND`.

- [x] **Step 2: Implement canonical fixture/manifest validation**

Implementation requirements:

- recursively sort object keys;
- serialize with `JSON.stringify`;
- hash UTF-8 bytes with SHA-256;
- parse all `MC-TC-*` manifest rows in §6;
- require exactly 62 fixture rows;
- verify case ID, JSON pointer, byte length, and SHA-256;
- verify synthetic IDs only.

- [x] **Step 3: Run the validator**

Run:

```bash
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-command-spec-closure.mjs --fixtures docs/fixtures/mobile-command-test-fixtures.json --manifest docs/mobile-command-test-cases.md
```

Expected: `mobile-command-spec-closure: ok (62 cases)`.

- [x] **Step 4: Update the test plan**

Replace the stale “Task 10 creates that validator” wording with the concrete command.

---

### Task 2: Current Phase 1 Demo Hardening

**Files:**
- Modify: `web/app/m/pair/page.js`
- Modify: `src/main/mobile-agent-bridge.js`
- Modify: `src/main/external-command-admission.js`
- Modify: `src/main/mobile-attachments.js`
- Modify: `server/src/services/mobile-relay.js`
- Modify tests under `scripts/test-mobile-*.mjs`

- [x] **Step 1: Add delivery correlation**

Every command and interrupt frame carries a `correlationId`; admission/rejection/offline/interrupt responses preserve it.

- [x] **Step 2: Add visible failure states**

Mobile page renders queued, desktop offline, disconnected send/stop, reconnect exhaustion, and dropped/partial image delivery states.

- [x] **Step 3: Add attachment retention cleanup**

Desktop cleanup deletes only expired `mcmd_` temp files and never touches unrelated temp content.

- [x] **Step 4: Run mobile regression group**

Run the Node 24 mobile script group. Expected: every listed script prints `ok`; server Postgres e2e may skip locally when `DATABASE_URL` is absent.

---

### Task 3: Protocol Negative Guards

**Files:**
- Create: `scripts/test-mobile-protocol-version.mjs`
- Modify: `scripts/test-mobile-agent-bridge.mjs`
- Modify: `src/main/mobile-agent-bridge.js`
- Modify: `CAPABILITY-GATE.md`

- [x] **Step 1: Write failing tests for unsupported major protocol**

Add cases where command frames include `protocolVersion: 2` or a mandatory unknown semantic marker. Expected result: mutation is denied with `CLIENT_UPGRADE_REQUIRED`/protocol invalid and local admission seam is not called.

- [x] **Step 2: Write failing tests for oversized command text and attachment count**

Use existing attachment bounds and add a bridge-level malformed/oversized command test. Expected result: no admission, no materialization beyond configured bounds, typed rejection.

- [x] **Step 3: Implement minimal bridge checks**

Reject before admission and preserve local Lily baseline.

- [x] **Step 4: Run targeted tests**

Run:

```bash
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-agent-bridge.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-protocol-version.mjs
```

Expected: all pass.

---

### Task 4: Next Local Implementable Batch - Mobile Draft/Voice Fallback Shell

**Files:**
- Add or modify: `scripts/test-mobile-pair-web.mjs`
- Modify: `web/app/m/pair/page.js`
- Do not call any ASR provider.

- [ ] **Step 1: Write failing tests for text draft preservation**

Simulate unavailable voice/provider state. Expected: typed task text remains editable and sendable; no provider call is made.

- [ ] **Step 2: Add disabled voice affordance only if it preserves text input**

If shown, the voice entry must explain unavailable status and keep text composer active. It must not advertise ASR as implemented.

- [ ] **Step 3: Run targeted page test**

Run:

```bash
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-pair-web.mjs
```

Expected: pass.

---

### Task 5: Final HTTP Surface And Capability Metadata

**Files:**
- Modify: `server/src/routes/public/mobile.js`
- Create: `server/src/routes/public/mobile-command-surface.js`
- Create: `server/src/services/mobile-command-capabilities.js`
- Create: `server/src/services/mobile-command-file-transfer.js`
- Create: `server/src/services/mobile-command-remote-session.js`
- Modify: `src/main/mobile-pairing-manager.js`
- Modify: `src/main/ipc-mobile-pairing.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/mobile-pairing-settings.js`
- Modify: `src/renderer/i18n/locales/{zh-CN,en,ar}.json`
- Modify: `web/app/m/pair/page.js`
- Create: `scripts/test-mobile-server-final-shape.mjs`
- Create: `scripts/test-mobile-file-transfer.mjs`
- Create: `scripts/test-mobile-remote-session.mjs`
- Create: `scripts/test-mobile-command-error-contract.mjs`
- Create: `scripts/test-mobile-command-kill-switch.mjs`
- Create: `scripts/test-mobile-command-schema-references.mjs`
- Create: `scripts/test-mobile-command-privacy-redlines.mjs`
- Create: `docs/schemas/mobile-command-observability.schema.json`
- Create: `scripts/test-mobile-command-observability-contracts.mjs`
- Modify: `scripts/test-mobile-pair-web.mjs`
- Modify: `scripts/test-mobile-pairing-manager.mjs`
- Modify: `scripts/test-mobile-pairing-ui.mjs`
- Modify: `scripts/test-mobile-pairing-wiring.mjs`
- Modify: `docs/mobile-command-current-demo-status.md`

- [x] **Step 1: Register final-shape HTTP routes**

Routes added for `/api/mobile/capabilities`, remote sessions, permission requests, TURN credentials, uploads, upload chunks/status/completion, artifact descriptors, artifact download tokens, direct artifact content, push token registration, and diagnostics.

- [x] **Step 2: Split final surface from pairing routes**

Pairing remains in `server/src/routes/public/mobile.js`; non-pairing final-shape routes live in `server/src/routes/public/mobile-command-surface.js`.

- [x] **Step 3: Fail evidence-gated capabilities safely**

Observe/control, TURN, native, voice, push, diagnostics, and direct artifact content return typed disabled responses with `fallback: "chat_only"` instead of 404 or accidental success.

- [x] **Step 4: Centralize capability metadata**

`server/src/services/mobile-command-capabilities.js` owns demo capability flags, disabled capability codes, reasons, and `chat_only` fallback.

- [x] **Step 5: Surface capability metadata on the phone and desktop**

The phone page reads `/api/mobile/capabilities`; the desktop pairing manager/status path also fetches and renders the same server capability contract.

- [x] **Step 6: Implement server-local upload/artifact v1**

Upload create/chunk/status/complete and artifact descriptor/download-token routes run against a bounded local service with SHA-256 checks, idempotent chunk retry, simple risk classification, and `mobile-artifact://` handles. Production object storage, native/background upload, and desktop staging remain evidence-gated.

- [x] **Step 7: Implement server-local remote session v1**

Create/refresh/end remote session routes run against a bounded server-local service with protocol-version guards, wrong-device rejection, short TTLs, and `chat` permission level only. Screen observation, control, clipboard, and TURN remain separate evidence-gated capabilities.

- [x] **Step 8: Add final-shape guards**

Error-code contract tests now check runtime Mobile Command codes against `docs/mobile-command-error-recovery-catalog.md` and `docs/schemas/mobile-command.openapi.yaml`. Kill-switch tests verify configured-off capabilities fail closed at the HTTP route boundary with `MC-ERR-CONFIG-FEATURE-DISABLED`. Schema-reference tests verify API matrix references resolve against OpenAPI, WebSocket/DataChannel event schema, and native bridge schema. Privacy-redline tests keep evidence-gated push and diagnostics payloads metadata-only, explicitly consented/redacted, and free of raw content/path/body/text/header fields. Observability contract tests compile telemetry/status/diagnostics schemas, enforce bounded customer-status fallback invariants, and reject sensitive/free-text support fields while production ops evidence remains blocked.

Run:

```bash
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-server-final-shape.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-file-transfer.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-remote-session.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-command-error-contract.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-command-kill-switch.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-command-schema-references.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-command-privacy-redlines.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-command-observability-contracts.mjs
/Users/zhangqin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/test-mobile-pair-web.mjs
```

Expected: all pass.

---

### Task 6: Blocked Evidence Workstream

**Files:**
- Update only evidence docs until real evidence exists:
  - `docs/mobile-command-asr-decision.md`
  - `docs/mobile-command-os-helper-decision.md`
  - `docs/mobile-command-platform-support-matrix.md`
  - `docs/mobile-command-infrastructure-deployment.md`
  - `docs/mobile-command-privacy-retention-compliance.md`
  - `docs/mobile-command-observability-support.md`

- [ ] **Step 1: Gather real environment inputs**

Required inputs: target OS/device matrix, TURN/storage/push provider accounts, ASR provider credentials, privacy region/retention decisions, native shell decision, signing identities.

- [ ] **Step 2: Run evidence procedures exactly as documented**

Use the ASR scorer, OS helper spike, WebRTC/TURN runbook, and platform matrix. Missing strata produce `blocked`, not accepted.

- [ ] **Step 3: Only after accepted evidence, implement production/native/live features**

No local code may claim screen mirror, OS input control, ASR, push, native app, or production release until the evidence rows are accepted.

---

## Current Execution Status

- Task 1 complete.
- Task 2 complete from the prior Phase 1 hardening pass.
- Task 3 complete.
- Task 4 is intentionally deferred unless product wants a local voice placeholder; ASR remains gated.
- Task 5 complete.
- Task 6 is blocked on external evidence and environment inputs.
