# Mobile Command Pro Specification Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a repository-grounded, machine-verifiable Mobile Command Pro specification set that passes a hard readiness gate before production implementation is authorized.

**Architecture:** Treat documentation as a dependency graph with four canonical control artifacts: the spec index, decision log, requirements traceability matrix, and readiness checklist. Repository audits and time-boxed technical spikes supply evidence; domain documents own semantics; machine-readable schemas own external boundaries; a Node-based validation test enforces closure and prevents unresolved choices from returning.

**Tech Stack:** Markdown, Mermaid, OpenAPI 3.1 YAML, JSON Schema 2020-12, Node.js ESM test scripts, existing Fastify/Zod/Kysely/Electron repository interfaces, existing `scripts/run-all-tests.mjs` discovery.

---

## Scope And Execution Rules

- Do not add Mobile Command production routes, services, UI, native shells, WebRTC connections, or OS-control code.
- Read and cite current exports before naming an integration point.
- Disposable spike code must live outside production entry points and must not be wired into the app.
- Do not modify unrelated dirty files, currently including `package.json`, `package-lock.json`, and `docs/ucmds-fp-legal-file-bug-analysis-2026-07-12.md` unless the user separately authorizes it.
- A document cannot be marked accepted while it contains an unresolved mandatory decision.
- Use stable IDs for decisions (`MC-ADR-*`), requirements (`MC-<DOMAIN>-*`), errors (`MC-ERR-*`), states (`MC-SM-*`), and tests (`MC-TC-*`).
- Commit after every task so later corrections have a clear dependency boundary.

## Planned File Map

**Control layer**

- Create `docs/mobile-command-spec-index.md`: canonical navigation, ownership, dependency, and status.
- Create `docs/mobile-command-decision-log.md`: accepted architecture/vendor decisions and evidence.
- Create `docs/mobile-command-requirements-traceability.md`: requirements-to-contract-to-test mappings.
- Create `docs/mobile-command-release-readiness-checklist.md`: authorization gate for implementation and release.

**Repository and domain contracts**

- Create `docs/mobile-command-existing-system-integration.md`.
- Create `docs/mobile-command-data-model.md`.
- Create `docs/mobile-command-auth-identity-contract.md`.
- Create `docs/mobile-command-agent-bridge-contract.md`.

**Protocol and lifecycle contracts**

- Create `docs/mobile-command-api-completeness-matrix.md`.
- Create `docs/mobile-command-error-recovery-catalog.md`.
- Create `docs/mobile-command-state-machines.md`.
- Modify `docs/schemas/mobile-command.openapi.yaml`.
- Modify `docs/schemas/mobile-command-events.schema.json`.
- Modify `docs/schemas/mobile-command-native-bridge.schema.json`.

**Platform, product, and operations contracts**

- Create `docs/mobile-command-platform-support-matrix.md`.
- Create `docs/mobile-command-os-helper-decision.md`.
- Create `docs/mobile-command-asr-decision.md`.
- Create `docs/mobile-command-visual-design-system.md`.
- Create `docs/mobile-command-infrastructure-deployment.md`.
- Create `docs/mobile-command-privacy-retention-compliance.md`.
- Create `docs/mobile-command-observability-support.md`.

**Validation**

- Create `scripts/test-mobile-command-spec-closure.mjs`: deterministic documentation closure guard.
- Modify `CAPABILITY-GATE.md`: register the specification-readiness regression vector.
- Modify `docs/mobile-command-remaining-gaps.md`: replace stale gap inventory with evidence-backed closure status.

### Task 1: Establish The Canonical Specification Control Layer

**Files:**

- Create: `docs/mobile-command-spec-index.md`
- Create: `docs/mobile-command-decision-log.md`
- Modify: `docs/mobile-command-remaining-gaps.md`

- [ ] **Step 1: Inventory every Mobile Command artifact and its headings**

Run:

```bash
for f in docs/mobile-command-*.md docs/schemas/mobile-command*; do
  printf '\nFILE %s\n' "$f"
  rg -n '^(#|##) ' "$f"
done
```

Expected: every existing document and schema appears once; no generated or dependency directory is scanned.

- [ ] **Step 2: Write the spec index with canonical ownership and dependency states**

The index must contain these exact columns:

```markdown
| ID | Document | Canonical responsibility | Depends on | Status | Evidence/approval |
|---|---|---|---|---|---|
```

Allowed status values are `draft`, `evidence-needed`, `review-ready`, `accepted`, and `superseded`. Add conflict rules stating that machine-readable schemas own wire syntax, domain contracts own semantics, the decision log owns alternatives, and the traceability matrix owns coverage.

- [ ] **Step 3: Write the decision log and enumerate every mandatory decision**

Use this normative record shape for each entry:

```markdown
## MC-ADR-001 — Mobile application repository and build boundary

- Status: proposed | accepted | superseded
- Decision:
- Repository evidence:
- Alternatives considered:
- Capability-gate effect:
- Failure/fallback behavior:
- Compatibility/migration effect:
- Supersedes:
- Accepted by/date:
```

Create records for mobile app location/build, Capacitor/native shell, identity mapping, WebRTC/TURN, Windows/macOS/Linux capture and input, ASR, push, temporary storage, feature flags, and release coupling. Do not mark a record accepted until its evidence task is complete.

- [ ] **Step 4: Convert the remaining-gaps document into a closure dashboard**

Keep historical context but replace duplicated prose with links to index rows and decision IDs. Every gap must have an owner artifact, dependency, evidence requirement, and status. Do not state that the spec is build-ready.

- [ ] **Step 5: Verify navigation and unresolved decisions**

Run:

```bash
rg -n "MC-ADR-|evidence-needed|proposed" docs/mobile-command-spec-index.md docs/mobile-command-decision-log.md docs/mobile-command-remaining-gaps.md
git diff --check -- docs/mobile-command-spec-index.md docs/mobile-command-decision-log.md docs/mobile-command-remaining-gaps.md
```

Expected: every unresolved choice is visible and all files pass whitespace validation.

- [ ] **Step 6: Commit the control layer**

```bash
git add docs/mobile-command-spec-index.md docs/mobile-command-decision-log.md docs/mobile-command-remaining-gaps.md
git commit -m "docs: establish mobile command spec control layer"
```

### Task 2: Audit Current Repository Integration Points

**Files:**

- Create: `docs/mobile-command-existing-system-integration.md`
- Modify: `docs/mobile-command-decision-log.md`
- Modify: `docs/mobile-command-repo-implementation-map.md`

- [ ] **Step 1: Inspect server routing, identity, database, and configuration owners**

Run:

```bash
sed -n '1,220p' server/src/routes/public.js
sed -n '1,340p' server/src/routes/public/devices.js
sed -n '1,360p' server/src/routes/public/auth.js
sed -n '1,280p' server/src/routes/public/account.js
sed -n '1,280p' server/src/services/device-identity.js
rg -n "createTable|devices|user_devices|license_devices|auth_sessions|config_profiles" server/migrations server/src
```

Expected: the audit identifies actual route registration, device signing, user session, license binding, and table definitions.

- [ ] **Step 2: Inspect desktop identity, network client, session, artifact, file, and configuration exports**

Run:

```bash
rg -n "module\.exports|exports\.|export function|export const" \
  src/main/service-client.js \
  src/main/license-manager.js \
  src/main/client-config-service.js \
  src/main/file-staging-manager.js \
  src/main/artifact-registry.js \
  src/main/agent-session.js \
  src/main/turn-orchestrator.js \
  src/main/session-*.js
rg -n "require\(|register|start|stop|dispose|send|artifact|staging" src/main.js src/main/ipc-*.js
```

Expected: the document can name existing exports and immediate callers without inventing new APIs.

- [ ] **Step 3: Write the integration audit as verified facts**

For every integration point include:

```markdown
| Concern | Current owner | Verified export/route/table | Current caller | Reuse decision | Required additive seam | Compatibility rule |
|---|---|---|---|---|---|---|
```

Cover device identity, account sessions, licenses, remote config, service authentication, route registration, local conversations, turn injection, runtime events, approvals if present, artifact registry, file staging, app lifecycle, IPC, logging, and migration conventions. Cite file paths and line numbers captured at audit time.

- [ ] **Step 4: Correct the repo implementation map**

Replace generic or conditional statements such as `if suitable`, `Preferred location`, and unverified file names with accepted decisions or explicit evidence-needed decision IDs. Do not create production modules.

- [ ] **Step 5: Record integration decisions**

Update the decision log with the accepted identity terminology, route registrar, configuration source, session injection boundary, artifact/file reuse boundaries, and selected mobile application location if the repository evidence is sufficient.

- [ ] **Step 6: Verify every named current path exists**

Run:

```bash
rg -o '`(src|server|web|resources|scripts)/[^` :]+' docs/mobile-command-existing-system-integration.md \
  | tr -d '`' \
  | while read -r path; do test -e "$path" || printf 'MISSING %s\n' "$path"; done
git diff --check -- docs/mobile-command-existing-system-integration.md docs/mobile-command-repo-implementation-map.md docs/mobile-command-decision-log.md
```

Expected: no `MISSING` line for a path described as currently existing. Planned paths must be explicitly labeled planned and excluded from the current-path table.

- [ ] **Step 7: Commit the repository truth audit**

```bash
git add docs/mobile-command-existing-system-integration.md docs/mobile-command-repo-implementation-map.md docs/mobile-command-decision-log.md
git commit -m "docs: ground mobile command in repository interfaces"
```

### Task 3: Freeze Identity, Authentication, And Persistence Semantics

**Files:**

- Create: `docs/mobile-command-data-model.md`
- Create: `docs/mobile-command-auth-identity-contract.md`
- Modify: `docs/mobile-command-permission-threat-model.md`
- Modify: `docs/mobile-command-decision-log.md`

- [ ] **Step 1: Extract current database and identity constraints**

Run:

```bash
rg -n "createTable\(|addColumn\(|addUniqueConstraint\(|createIndex\(" server/migrations
rg -n "device_id|user_id|license_id|public_key|nonce|expires_at|revoked_at" server/migrations server/src/services/device-identity.js server/src/routes/public/auth.js
```

Expected: current key types, timestamps, uniqueness, and revocation patterns are captured before designing additive tables.

- [ ] **Step 2: Write the final logical and physical data model**

For every new or reused table specify:

```markdown
| Column | SQL type | Null | Default | References | Mutability | Retention/redaction |
|---|---|---|---|---|---|---|
```

Also include exact unique indexes, lookup indexes, check constraints, ownership, deletion behavior, revocation cascade, cleanup jobs, clock source, and migration compatibility. Include complete SQL DDL as a specification appendix, using the repository's actual database dialect and naming conventions. The appendix is normative but is not applied during this phase.

- [ ] **Step 3: Write the auth and identity contract**

Define distinct identities for user, license, desktop installation/device, mobile installation/device, public key, account session, pairing challenge, paired-device grant, remote-session token, and TURN credential. For each credential specify issuer, audience, binding, claims, TTL, storage, rotation, replay defense, revocation trigger, and offline behavior.

- [ ] **Step 4: Add sequence diagrams for security-critical flows**

Include Mermaid sequences for initial pairing, desktop approval, mobile reconnect, access-token refresh, device-key rotation, mobile-device revocation, desktop-device replacement, expired license, account sign-out, and stolen-token rejection.

- [ ] **Step 5: Reconcile the threat model**

Make the permission document reference the identity contract for authentication facts. Add explicit threats for cross-account pairing, license/device confusion, replay across desktop devices, key rollback, revoked mobile reconnect, approval race, session fixation, and audit failure.

- [ ] **Step 6: Verify terminology and constraints**

Run:

```bash
rg -n "account_id|desktop_device_id|mobile_device_id|user_id|license_id" docs/mobile-command-data-model.md docs/mobile-command-auth-identity-contract.md docs/mobile-command-permission-threat-model.md
rg -n "TBD|TODO|待定|if suitable|必要时|建议采用" docs/mobile-command-data-model.md docs/mobile-command-auth-identity-contract.md
git diff --check -- docs/mobile-command-data-model.md docs/mobile-command-auth-identity-contract.md docs/mobile-command-permission-threat-model.md
```

Expected: every generic identifier is explicitly mapped; unresolved-marker search returns no actual unresolved requirement.

- [ ] **Step 7: Commit the identity domain**

```bash
git add docs/mobile-command-data-model.md docs/mobile-command-auth-identity-contract.md docs/mobile-command-permission-threat-model.md docs/mobile-command-decision-log.md
git commit -m "docs: freeze mobile command identity contracts"
```

### Task 4: Freeze Agent Bridge And Local Capability Boundaries

**Files:**

- Create: `docs/mobile-command-agent-bridge-contract.md`
- Modify: `docs/mobile-command-pro-implementation.md`
- Modify: `docs/mobile-command-repo-implementation-map.md`

- [ ] **Step 1: Inspect the real turn and runtime-event paths**

Run:

```bash
rg -n "send|enqueue|turn|sessionID|sessionId|runtime-event|tool|approval|artifact" \
  src/main/agent-session.js \
  src/main/turn-orchestrator.js \
  src/main/runtime-event-bus.js \
  src/main/user-message.js \
  src/main/session-runner-pool.js \
  src/main/artifact-registry.js
```

Expected: the contract identifies the single existing turn injection path and event sources.

- [ ] **Step 2: Specify command injection and concurrency**

Define target-conversation selection, absent conversation behavior, active-turn behavior, queue ordering, idempotency, cancellation ownership, device revocation during a turn, desktop priority, and the invariant that Mobile Command never creates a second hidden history.

- [ ] **Step 3: Specify event projection to mobile**

Define mappings for assistant deltas, reasoning visibility policy, tool start/progress/result, permission requests, approvals, artifact registration, partial failure, compaction, reconnect snapshots, and terminal turn states. Identify which existing event fields are forwarded, transformed, redacted, or prohibited.

- [ ] **Step 4: Specify capability failure behavior**

Create a table for relay loss, malformed mobile payload, injection failure, local session absence, unsupported client version, artifact lookup failure, approval timeout, and event replay. Each row must prove that local Lily remains usable and that no sensitive action is silently authorized.

- [ ] **Step 5: Remove duplicated or conflicting bridge prose from umbrella documents**

Replace duplicated normative sections with links to the new canonical contract; retain product summaries only.

- [ ] **Step 6: Verify bridge completeness**

Run:

```bash
rg -n "conversation|turn|idempot|queue|reconnect|tool|approval|artifact|revok|fail-open|fail-safe" docs/mobile-command-agent-bridge-contract.md
git diff --check -- docs/mobile-command-agent-bridge-contract.md docs/mobile-command-pro-implementation.md docs/mobile-command-repo-implementation-map.md
```

Expected: all named concerns appear and whitespace validation passes.

- [ ] **Step 7: Commit the bridge contract**

```bash
git add docs/mobile-command-agent-bridge-contract.md docs/mobile-command-pro-implementation.md docs/mobile-command-repo-implementation-map.md
git commit -m "docs: freeze mobile agent bridge contract"
```

### Task 5: Unify State Machines, Errors, And API Coverage

**Files:**

- Create: `docs/mobile-command-state-machines.md`
- Create: `docs/mobile-command-error-recovery-catalog.md`
- Create: `docs/mobile-command-api-completeness-matrix.md`
- Modify: `docs/mobile-command-protocol-schema.md`
- Modify: `docs/mobile-command-file-transfer-contract.md`
- Modify: `docs/mobile-command-webrtc-runbook.md`
- Modify: `docs/mobile-command-native-shell.md`

- [ ] **Step 1: Inventory every state, event, operation, and error currently named**

Run:

```bash
rg -n "state|状态|event|error|错误|/api/|DataChannel|WebSocket|native" docs/mobile-command-*.md docs/schemas/mobile-command* > /tmp/mobile-command-contract-inventory.txt
wc -l /tmp/mobile-command-contract-inventory.txt
```

Expected: a non-empty inventory used to reconcile duplicate names and missing transitions.

- [ ] **Step 2: Write canonical state machines**

For pairing, remote session, permission, approval, WebRTC, upload, device revocation, reconnect, and mobile backgrounding, specify:

```markdown
| State | Event | Guard | Next state | Side effect | Emitted event | Failure transition |
|---|---|---|---|---|---|---|
```

Each machine must define initial and terminal states, illegal events, timeouts, idempotent repeats, persistence boundary, recovery after process restart, and revocation precedence.

- [ ] **Step 3: Write the complete error catalog**

Use this schema for every error:

```markdown
| Code | Surface/status | Recoverable | Retry policy | User copy key | Telemetry | Downgrade/revocation | Canonical owner |
|---|---|---|---|---|---|---|---|
```

Every retry policy must give count, backoff, jitter, idempotency requirement, and terminal behavior. Write requests without an idempotency key must not retry automatically.

- [ ] **Step 4: Write the API completeness matrix from user journeys**

Rows must cover pairing, device listing/revocation, command send/reconnect, approval, upload/download, session creation/end, signaling, TURN credentials, observe/control elevation, clipboard, push wakeup, native sharing, background upload, and diagnostics. Columns must identify transport, operation/event, request schema, response schema, auth, idempotency, state transition, errors, and requirement IDs.

- [ ] **Step 5: Make existing contracts defer to canonical owners**

Update protocol, upload, WebRTC, and native-shell documents so names and transitions match the canonical state/error documents exactly. Remove conflicting locally invented error names or state transitions.

- [ ] **Step 6: Verify cross-document naming**

Run:

```bash
rg -o 'MC-ERR-[A-Z0-9_-]+' docs/mobile-command-*.md | sort -u
rg -o 'MC-SM-[A-Z0-9_-]+' docs/mobile-command-*.md | sort -u
git diff --check -- docs/mobile-command-state-machines.md docs/mobile-command-error-recovery-catalog.md docs/mobile-command-api-completeness-matrix.md docs/mobile-command-protocol-schema.md docs/mobile-command-file-transfer-contract.md docs/mobile-command-webrtc-runbook.md docs/mobile-command-native-shell.md
```

Expected: identifiers are consistently formatted; no whitespace errors.

- [ ] **Step 7: Commit lifecycle contracts**

```bash
git add docs/mobile-command-state-machines.md docs/mobile-command-error-recovery-catalog.md docs/mobile-command-api-completeness-matrix.md docs/mobile-command-protocol-schema.md docs/mobile-command-file-transfer-contract.md docs/mobile-command-webrtc-runbook.md docs/mobile-command-native-shell.md
git commit -m "docs: unify mobile command lifecycle contracts"
```

### Task 6: Complete Machine-Readable Schemas

**Files:**

- Modify: `docs/schemas/mobile-command.openapi.yaml`
- Modify: `docs/schemas/mobile-command-events.schema.json`
- Modify: `docs/schemas/mobile-command-native-bridge.schema.json`
- Modify: `docs/mobile-command-api-completeness-matrix.md`

- [ ] **Step 1: Add every matrix operation to OpenAPI**

Define exact required/optional fields, formats, bounds, enums, auth schemes, idempotency headers, error responses, and additive versioning. Reuse `$ref` components instead of copying shapes.

- [ ] **Step 2: Complete discriminated event unions**

Use `oneOf` with a required constant discriminator for every WebSocket and DataChannel event. Set `additionalProperties: false` where forward compatibility does not require extensions; where extensions are allowed, define an explicit `extensions` object.

- [ ] **Step 3: Complete the native bridge schema**

Cover secure keys, background upload, push, share sheet, permission status/request, camera/scanner, file selection, and lifecycle. No native method may accept shell text, script text, arbitrary executable paths, or unvalidated remote protocol payloads.

- [ ] **Step 4: Validate JSON syntax and schema self-consistency**

Run:

```bash
node -e "JSON.parse(require('fs').readFileSync('docs/schemas/mobile-command-events.schema.json','utf8')); JSON.parse(require('fs').readFileSync('docs/schemas/mobile-command-native-bridge.schema.json','utf8')); console.log('JSON schemas parse')"
node -e "import('yaml').then(({parse})=>{parse(require('fs').readFileSync('docs/schemas/mobile-command.openapi.yaml','utf8')); console.log('OpenAPI YAML parses')})"
```

Expected: `JSON schemas parse` and `OpenAPI YAML parses`. If the repository does not already provide a YAML parser, use the parser already present in the dependency tree; do not add a package solely for this check.

- [ ] **Step 5: Reconcile the API matrix**

Every operation/event/native method row must contain the exact schema component or `$id`. Mark no row complete until both directions resolve.

- [ ] **Step 6: Commit machine-readable contracts**

```bash
git add docs/schemas/mobile-command.openapi.yaml docs/schemas/mobile-command-events.schema.json docs/schemas/mobile-command-native-bridge.schema.json docs/mobile-command-api-completeness-matrix.md
git commit -m "docs: complete mobile command machine schemas"
```

### Task 7: Resolve Platform, OS Helper, ASR, And Visual Decisions

**Files:**

- Create: `docs/mobile-command-platform-support-matrix.md`
- Create: `docs/mobile-command-os-helper-decision.md`
- Create: `docs/mobile-command-asr-decision.md`
- Create: `docs/mobile-command-visual-design-system.md`
- Modify: `docs/mobile-command-os-helper-spike.md`
- Modify: `docs/mobile-command-asr-provider-spike.md`
- Modify: `docs/mobile-command-ui-spec.md`
- Modify: `docs/mobile-command-decision-log.md`

- [ ] **Step 1: Define reproducible spike environments and acceptance thresholds**

Record exact OS/device versions, hardware, network profiles, sample sizes, permission states, and commands used. Before testing, set numeric acceptance thresholds for latency, CPU, memory, crash rate, transcription quality, and recovery behavior; do not choose winners retrospectively.

- [ ] **Step 2: Execute the OS helper spike on supported platforms**

For each candidate record capture latency, CPU, permissions, signing/package feasibility, multi-monitor behavior, keyboard layout/IME behavior, secure-desktop restrictions, crash recovery, and abuse surface. If required hardware or signing credentials are unavailable, leave the decision `evidence-needed` and block specification freeze rather than guessing.

- [ ] **Step 3: Write the OS helper decision document**

Select one implementation per supported platform and specify helper IPC messages, executable discovery, signature verification, permissions, sandboxing, update coupling, crash policy, unsupported environments, and downgrade. Replace all `TBD` spike cells with measured results or an explicit failed/blocked observation.

- [ ] **Step 4: Execute the ASR spike**

Use the same multilingual, noisy, short-command, long-dictation, correction, sensitive-intent, offline, and weak-network corpus for every provider. Record p50/p95 partial and final latency, word/character error rate, cost per minute, data location, retention, credential model, mobile background behavior, and failure recovery.

- [ ] **Step 5: Write the ASR decision document**

Select a primary and fallback path. Specify streaming event semantics, consent, audio retention, direct-send restrictions, language detection, credential ownership, quotas, cost guard, offline behavior, and fallback order. Replace all `TBD` spike cells with evidence or a recorded blocked result.

- [ ] **Step 6: Write the platform support matrix**

Create rows for Windows/macOS/Linux desktop paired with iOS native/Android native/PWA. Columns must cover Command, push, background upload, Lily-window observe/control, desktop observe/control, clipboard, keyboard/IME, file share, camera, reconnect, permissions, and exact downgrade.

- [ ] **Step 7: Write the visual design system**

Derive colors and iconography from existing Lily brand assets. Specify spacing scale, typography, semantic colors, dark mode, safe areas, touch targets, focus, waveform, connection/permission states, reduced motion, loading/skeleton behavior, and screenshot reference sizes. Link every component state back to `mobile-command-ui-spec.md`; do not introduce new business actions.

- [ ] **Step 8: Verify that decision documents have no unresolved result cells**

Run:

```bash
rg -n "TBD|TODO|待定" docs/mobile-command-os-helper-decision.md docs/mobile-command-asr-decision.md docs/mobile-command-platform-support-matrix.md docs/mobile-command-visual-design-system.md
git diff --check -- docs/mobile-command-os-helper-decision.md docs/mobile-command-asr-decision.md docs/mobile-command-platform-support-matrix.md docs/mobile-command-visual-design-system.md docs/mobile-command-os-helper-spike.md docs/mobile-command-asr-provider-spike.md docs/mobile-command-ui-spec.md docs/mobile-command-decision-log.md
```

Expected: unresolved-marker search returns no actual unresolved decision. If evidence is unavailable, stop here and report the gate as blocked.

- [ ] **Step 9: Commit evidence-backed platform decisions**

```bash
git add docs/mobile-command-platform-support-matrix.md docs/mobile-command-os-helper-decision.md docs/mobile-command-asr-decision.md docs/mobile-command-visual-design-system.md docs/mobile-command-os-helper-spike.md docs/mobile-command-asr-provider-spike.md docs/mobile-command-ui-spec.md docs/mobile-command-decision-log.md
git commit -m "docs: decide mobile command platform capabilities"
```

### Task 8: Freeze Infrastructure, Privacy, Observability, And Support

**Files:**

- Create: `docs/mobile-command-infrastructure-deployment.md`
- Create: `docs/mobile-command-privacy-retention-compliance.md`
- Create: `docs/mobile-command-observability-support.md`
- Modify: `docs/mobile-command-ops-runbook.md`
- Modify: `docs/mobile-command-build-release.md`
- Modify: `docs/mobile-command-decision-log.md`

- [ ] **Step 1: Audit the real deployment and configuration conventions**

Run:

```bash
sed -n '1,260p' memory/server-deploy-flow.md
find deploy/baota server -maxdepth 3 -type f \( -name '*compose*' -o -name '*.env*' -o -name '*deploy*' -o -name '*config*' \) | sort
rg -n "QINIU|S3|storage|redis|websocket|telemetry|retention|secret|TLS|rate" deploy server/src server/migrations
```

Expected: infrastructure decisions follow current deployment conventions and clearly identify required new services.

- [ ] **Step 2: Select and document infrastructure providers/topology**

Record accepted signaling deployment, TURN provider/self-host design, push providers, temporary object storage, regional placement, domains, certificates, secrets, key rotation, network paths, horizontal scaling, connection draining, and dependency failure behavior. Include capacity calculations and monthly cost thresholds for low, expected, and high usage.

- [ ] **Step 3: Write the privacy and retention contract**

For each data class specify collector, purpose, lawful/consent basis where applicable, fields, encryption, access, log redaction, TTL, deletion trigger, backup persistence, export, and prohibition. Explicitly cover screen/media, input events, clipboard, audio, transcripts, files, EXIF, device metadata, IP addresses, audit records, telemetry, and diagnostics.

- [ ] **Step 4: Write observability and support contracts**

Define stable telemetry event names and payload fields, cardinality limits, sampling, redaction, service-level indicators, alert thresholds, dashboards, trace correlation, diagnostics package schema, customer-visible status, support access controls, and incident escalation.

- [ ] **Step 5: Reconcile runbook and release documentation**

Keep procedural actions in the ops runbook, link topology/data/telemetry facts to their canonical documents, and make build/release gates depend on infrastructure readiness, privacy approval, store signing, compatibility, rollback, and kill switches.

- [ ] **Step 6: Verify every provider decision is accepted or blocks the gate**

Run:

```bash
rg -n "TURN|push|storage|retention|cost|capacity|rollback|kill switch" docs/mobile-command-infrastructure-deployment.md docs/mobile-command-privacy-retention-compliance.md docs/mobile-command-observability-support.md
rg -n "TBD|TODO|待定|provider to be selected|供应商待定" docs/mobile-command-infrastructure-deployment.md docs/mobile-command-privacy-retention-compliance.md docs/mobile-command-observability-support.md
git diff --check -- docs/mobile-command-infrastructure-deployment.md docs/mobile-command-privacy-retention-compliance.md docs/mobile-command-observability-support.md docs/mobile-command-ops-runbook.md docs/mobile-command-build-release.md docs/mobile-command-decision-log.md
```

Expected: no unresolved mandatory provider or policy choice. Otherwise specification freeze remains blocked.

- [ ] **Step 7: Commit operational contracts**

```bash
git add docs/mobile-command-infrastructure-deployment.md docs/mobile-command-privacy-retention-compliance.md docs/mobile-command-observability-support.md docs/mobile-command-ops-runbook.md docs/mobile-command-build-release.md docs/mobile-command-decision-log.md
git commit -m "docs: freeze mobile command operational contracts"
```

### Task 9: Build Requirements Traceability And Release Readiness Gates

**Files:**

- Create: `docs/mobile-command-requirements-traceability.md`
- Create: `docs/mobile-command-release-readiness-checklist.md`
- Modify: `docs/mobile-command-test-cases.md`
- Modify: `docs/mobile-command-test-plan.md`
- Modify: `docs/mobile-command-spec-index.md`

- [ ] **Step 1: Assign stable requirement IDs to every normative behavior**

Use domains `CMD`, `PAIR`, `LIVE`, `PERM`, `FILE`, `VOICE`, `NATIVE`, `OPS`, `PRIV`, and `REL`. Merge duplicates rather than assigning multiple IDs to the same invariant.

- [ ] **Step 2: Write the traceability matrix**

Use these exact columns:

```markdown
| Requirement ID | Normative requirement | Canonical section | Schema/operation | Planned owner | Automated case | Manual/platform case | Release gate | Failure class | Status |
|---|---|---|---|---|---|---|---|---|---|
```

Allowed failure classes are `baseline-fail-open`, `authority-fail-safe`, and `recoverable`. Allowed status values are `covered`, `not-applicable`, and `blocked`; `not-applicable` requires an explanation in the requirement text.

- [ ] **Step 3: Convert test documents to stable Given/When/Then cases**

Every case must include preconditions, fixture IDs, exact input/event, expected state transition, expected response/error, forbidden side effects, required audit/telemetry, cleanup, and supported platform scope. Add negative cases for malformed/forged/oversized input, revocation races, missing permission state, relay loss, schema-version skew, and local-session preservation.

- [ ] **Step 4: Write the readiness checklist**

Separate `Specification Freeze` from `Production Release`. Specification Freeze must require accepted decisions, verified repository seams, complete schemas, state/error coverage, evidence-backed platform/provider choices, privacy/ops acceptance, zero traceability gaps, and passing closure validation. Production Release must additionally require implementation tests, signed builds, platform QA, load/chaos results, monitoring, rollback rehearsal, and staged kill switches.

- [ ] **Step 5: Update index status from evidence**

Mark a document `accepted` only when its dependencies are accepted, ambiguity scan passes, canonical links resolve, and traceability rows cover its normative requirements.

- [ ] **Step 6: Manually sample traceability in both directions**

Select at least two requirements from each domain. Verify requirement → contract → schema → test → gate, then select at least ten tests and trace test → requirement. Record the review date and findings in the traceability document.

- [ ] **Step 7: Commit traceability and gates**

```bash
git add docs/mobile-command-requirements-traceability.md docs/mobile-command-release-readiness-checklist.md docs/mobile-command-test-cases.md docs/mobile-command-test-plan.md docs/mobile-command-spec-index.md
git commit -m "docs: trace mobile command requirements to release gates"
```

### Task 10: Add A Deterministic Specification Closure Guard

**Files:**

- Create: `scripts/test-mobile-command-spec-closure.mjs`
- Modify: `CAPABILITY-GATE.md`
- Modify: `docs/mobile-command-spec-index.md`
- Modify: `docs/mobile-command-release-readiness-checklist.md`

- [ ] **Step 1: Write the failing closure test**

Create `scripts/test-mobile-command-spec-closure.mjs` with this structure, expanding `requiredDocs` to every canonical document created by this plan:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const requiredDocs = [
  "docs/mobile-command-spec-index.md",
  "docs/mobile-command-decision-log.md",
  "docs/mobile-command-existing-system-integration.md",
  "docs/mobile-command-data-model.md",
  "docs/mobile-command-auth-identity-contract.md",
  "docs/mobile-command-agent-bridge-contract.md",
  "docs/mobile-command-state-machines.md",
  "docs/mobile-command-error-recovery-catalog.md",
  "docs/mobile-command-api-completeness-matrix.md",
  "docs/mobile-command-platform-support-matrix.md",
  "docs/mobile-command-os-helper-decision.md",
  "docs/mobile-command-asr-decision.md",
  "docs/mobile-command-visual-design-system.md",
  "docs/mobile-command-infrastructure-deployment.md",
  "docs/mobile-command-privacy-retention-compliance.md",
  "docs/mobile-command-observability-support.md",
  "docs/mobile-command-requirements-traceability.md",
  "docs/mobile-command-release-readiness-checklist.md",
];

for (const relative of requiredDocs) {
  assert.ok(fs.existsSync(path.join(root, relative)), `missing required spec: ${relative}`);
}

const normative = requiredDocs.map((relative) => ({
  relative,
  text: fs.readFileSync(path.join(root, relative), "utf8"),
}));

const unresolved = /\b(?:TBD|TODO)\b|待定|供应商待定|provider to be selected/giu;
for (const { relative, text } of normative) {
  assert.equal(unresolved.test(text), false, `unresolved marker in ${relative}`);
  unresolved.lastIndex = 0;
}

const decisions = fs.readFileSync(path.join(root, "docs/mobile-command-decision-log.md"), "utf8");
assert.equal(/- Status:\s*(?:proposed|evidence-needed)/u.test(decisions), false, "mandatory decision remains unresolved");

const traceability = fs.readFileSync(path.join(root, "docs/mobile-command-requirements-traceability.md"), "utf8");
const requirementIds = [...traceability.matchAll(/\bMC-(?:CMD|PAIR|LIVE|PERM|FILE|VOICE|NATIVE|OPS|PRIV|REL)-\d{3}\b/gu)].map((match) => match[0]);
assert.ok(requirementIds.length > 0, "traceability matrix has no requirement IDs");
assert.equal(new Set(requirementIds).size, requirementIds.length, "duplicate requirement ID in traceability matrix");

const errors = fs.readFileSync(path.join(root, "docs/mobile-command-error-recovery-catalog.md"), "utf8");
const declaredErrors = new Set([...errors.matchAll(/\bMC-ERR-[A-Z0-9_-]+\b/gu)].map((match) => match[0]));
for (const { relative, text } of normative) {
  for (const match of text.matchAll(/\bMC-ERR-[A-Z0-9_-]+\b/gu)) {
    assert.ok(declaredErrors.has(match[0]), `${relative} references undeclared error ${match[0]}`);
  }
}

console.log("mobile command specification closure: PASS");
```

- [ ] **Step 2: Run the test and verify it fails for real incompleteness**

Run:

```bash
node scripts/test-mobile-command-spec-closure.mjs
```

Expected before all closure work is accepted: FAIL naming a missing document, unresolved decision, duplicate requirement, or undeclared error. A syntax failure is not the intended red state and must be fixed first.

- [ ] **Step 3: Extend the guard with schema and link checks**

Add deterministic checks that JSON schemas parse; OpenAPI has an `openapi` version and `paths`; every relative Markdown link under `docs/` resolves; API-matrix schema references exist; every state/error identifier referenced by normative documents is declared; every accepted index row links to an existing file; and traceability rows have all required columns.

- [ ] **Step 4: Run the focused test until it passes**

Run:

```bash
node scripts/test-mobile-command-spec-closure.mjs
```

Expected after genuine closure: `mobile command specification closure: PASS`.

- [ ] **Step 5: Register the capability regression guard**

Add a `CAPABILITY-GATE.md` registry row stating that incomplete or contradictory remote-control specs can cause AI implementation to weaken local Lily or authorize unsafe behavior, guarded by `test-mobile-command-spec-closure.mjs` plus the planned remote fail-open and permission tests.

- [ ] **Step 6: Run the auto-discovered test path**

Run:

```bash
node scripts/run-all-tests.mjs --match mobile-command-spec-closure
```

If the runner has no `--match` support, run the focused script directly and then the repository's documented unit suite. Expected: the closure test is discovered and passes; unrelated pre-existing failures must be reported rather than hidden.

- [ ] **Step 7: Commit the closure guard**

```bash
git add scripts/test-mobile-command-spec-closure.mjs CAPABILITY-GATE.md docs/mobile-command-spec-index.md docs/mobile-command-release-readiness-checklist.md
git commit -m "test: guard mobile command specification closure"
```

### Task 11: Final Specification Freeze Review

**Files:**

- Modify: `docs/mobile-command-spec-index.md`
- Modify: `docs/mobile-command-remaining-gaps.md`
- Modify: `docs/mobile-command-release-readiness-checklist.md`
- Modify: `docs/mobile-command-decision-log.md` only if review discovers a contradiction

- [ ] **Step 1: Run the full ambiguity scan**

Run:

```bash
rg -n "TBD|TODO|待定|if suitable|Preferred location|Alternative if|建议采用|可以选择|必要时自研|provider to be selected|evidence-needed|Status: proposed" docs/mobile-command-*.md docs/schemas/mobile-command*
```

Expected: no unresolved normative decision. Historical descriptions of eliminated markers are allowed only when clearly non-normative and excluded by the closure guard.

- [ ] **Step 2: Run schema, link, and closure validation**

Run:

```bash
node scripts/test-mobile-command-spec-closure.mjs
git diff --check
```

Expected: closure test passes and no whitespace errors are introduced.

- [ ] **Step 3: Review capability behavior manually**

For every failure-mode row confirm:

- relay, signaling, TURN, media, input, upload, push, and mobile UI failure preserve the current local Lily session;
- missing, malformed, expired, or disputed authority denies control and sensitive actions;
- failure never creates a hidden second conversation or weaker model/tool path;
- kill switches retain the strongest safe remaining baseline;
- all claims have corresponding traceability and test IDs.

Record reviewer evidence in the readiness checklist.

- [ ] **Step 4: Review the specification as a fresh implementation agent**

Attempt to answer, only from canonical documents: exact files to create, exact fields, every state/error, identity mapping, platform support, provider choices, deployment topology, privacy rules, tests, rollback, and release gates. Any answer requiring invention reopens the owning document and prevents acceptance.

- [ ] **Step 5: Update final statuses**

Mark accepted documents in the index, close resolved gaps, and set the specification-freeze checklist to passed only when every blocking item has evidence. Do not mark the production-release checklist passed; no production implementation exists yet.

- [ ] **Step 6: Run the relevant repository test suite**

Run:

```bash
npm run test:unit
```

Expected: all tests pass. If unrelated pre-existing failures occur, record exact commands and failures, keep specification freeze unclaimed until the closure guard itself passes, and do not modify unrelated product code.

- [ ] **Step 7: Commit the specification freeze record**

```bash
git add docs/mobile-command-spec-index.md docs/mobile-command-remaining-gaps.md docs/mobile-command-release-readiness-checklist.md docs/mobile-command-decision-log.md
git commit -m "docs: freeze mobile command production specification"
```

## Final Handoff

After Task 11, report:

- accepted documents and decision IDs;
- evidence tasks executed and environments used;
- closure test and unit-test outputs;
- any blocked platform/provider decision;
- whether **Specification Freeze** passed;
- an explicit statement that **Production Release** has not passed and implementation has not begun.

Only after the user accepts the frozen specification should a separate production implementation plan be written. That later plan must use TDD, preserve local Lily as the fail-open baseline, fail safe on authority uncertainty, and reference requirement/test IDs from the traceability matrix.
