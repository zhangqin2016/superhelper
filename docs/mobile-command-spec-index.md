# Lily Mobile Command Pro Specification Index

## 1. Purpose And Status Vocabulary

This document is the canonical navigation and ownership map for Mobile Command specification closure. It records the dependency order and prevents two documents from independently deciding the same fact. It does not authorize production implementation.

The only valid index statuses are:

- `draft`: content exists but canonical review is incomplete.
- `evidence-needed`: acceptance depends on repository, prototype, vendor, operational, security, design, or legal evidence not yet recorded.
- `review-ready`: required evidence is present and the artifact is ready for owner review.
- `accepted`: the responsible reviewers approved the artifact and no mandatory decision remains open.
- `superseded`: another indexed artifact explicitly replaced this artifact.

## 2. Conflict And Ownership Rules

1. Machine-readable schemas own wire syntax, required fields, discriminators, versions, and bounds.
2. Domain contracts own field meaning, authorization, lifecycle semantics, recovery, and retention.
3. [The decision log](mobile-command-decision-log.md) is the only artifact that selects among alternatives; descriptive documents link to its stable `MC-ADR-*` records.
4. The planned requirements traceability matrix owns coverage from requirement to contract, repository owner, test, and release gate.
5. The planned readiness checklist owns authorization to begin implementation. No prose claim elsewhere overrides it.
6. When artifacts conflict, the canonical owner above wins. The losing artifact must link to the owner and remove or label the duplicate as non-normative.
7. A dependent artifact cannot be `accepted` while a required dependency or mandatory ADR is unresolved.

## 3. Canonical Artifact Index

| ID | Document | Canonical responsibility | Depends on | Status | Evidence/approval |
|---|---|---|---|---|---|
| MC-SPEC-001 | [Specification index](mobile-command-spec-index.md) | Artifact catalog, canonical ownership, dependency order, status, and conflict rules | — | review-ready | Task 1 inventory; engineering review required |
| MC-SPEC-002 | [Decision log](mobile-command-decision-log.md) | Alternatives, selected decisions, evidence, fallback, compatibility, and supersession | MC-SPEC-001 | evidence-needed | Mandatory ADR inventory exists; evidence tasks remain open |
| MC-SPEC-003 | `mobile-command-requirements-traceability.md` (planned) | Requirement-to-contract-to-owner-to-test-to-release coverage | MC-SPEC-005, MC-SPEC-008–017, MC-SPEC-019–030 | draft | Task 11 creation and coverage validation |
| MC-SPEC-004 | `mobile-command-release-readiness-checklist.md` (planned) | Specification-freeze authorization and later release sign-off | MC-SPEC-002–003, MC-SPEC-005–030 | draft | Task 12 cross-functional sign-off |
| MC-SPEC-005 | `mobile-command-existing-system-integration.md` (planned) | Verified current exports, callers, routes, tables, configuration, and reusable seams | MC-SPEC-001–002 | evidence-needed | Task 2 repository audit |
| MC-SPEC-006 | `mobile-command-data-model.md` (planned) | Final tables, columns, constraints, indexes, retention, and revocation cascades | MC-SPEC-005, MC-ADR-003 | evidence-needed | Task 3 repository/database evidence |
| MC-SPEC-007 | `mobile-command-auth-identity-contract.md` (planned) | Identity, credentials, pairing, binding, rotation, replay defense, and revocation semantics | MC-SPEC-005–006, MC-ADR-003 | evidence-needed | Task 3 security and identity review |
| MC-SPEC-008 | `mobile-command-agent-bridge-contract.md` (planned) | Existing-conversation injection, concurrency, streaming, tools, approvals, and artifacts | MC-SPEC-005, MC-SPEC-007 | evidence-needed | Task 4 repository/session evidence |
| MC-SPEC-009 | `mobile-command-api-completeness-matrix.md` (planned) | Every flow mapped to HTTP, WebSocket, DataChannel, upload, push, and native operations | MC-SPEC-007–008, MC-SPEC-010–011 | draft | Task 5 flow inventory |
| MC-SPEC-010 | `mobile-command-error-recovery-catalog.md` (planned) | Error IDs, transport status, retry, copy, telemetry, downgrade, and revocation | MC-SPEC-007–008 | draft | Task 5 domain review |
| MC-SPEC-011 | `mobile-command-state-machines.md` (planned) | Canonical pairing, session, WebRTC, permission, approval, upload, revocation, reconnect, and background states | MC-SPEC-007–008, MC-SPEC-010 | draft | Task 5 lifecycle review |
| MC-SPEC-012 | [OpenAPI schema](schemas/mobile-command.openapi.yaml) | HTTP wire syntax for pairing, devices, sessions, TURN, uploads, and artifacts | MC-SPEC-006–011 | draft | Task 6 schema validation and matrix coverage |
| MC-SPEC-013 | [Event schema](schemas/mobile-command-events.schema.json) | WebSocket and DataChannel envelope/event wire syntax | MC-SPEC-008–011 | draft | Task 6 JSON Schema validation and matrix coverage |
| MC-SPEC-014 | [Native bridge schema](schemas/mobile-command-native-bridge.schema.json) | Native request/response method wire syntax | MC-SPEC-007, MC-SPEC-009–011, MC-ADR-002 | draft | Task 6 JSON Schema validation and native review |
| MC-SPEC-015 | `mobile-command-platform-support-matrix.md` (planned) | Supported level and explicit degradation for every desktop/mobile platform pair | MC-SPEC-018–019, MC-ADR-004–008 | evidence-needed | Tasks 7–8 platform evidence |
| MC-SPEC-016 | `mobile-command-os-helper-decision.md` (planned) | Proven OS capture/input helpers, IPC, permissions, signing, packaging, and recovery | MC-SPEC-005, MC-SPEC-018, MC-ADR-005–007 | evidence-needed | Task 7 completed OS spikes |
| MC-SPEC-017 | `mobile-command-asr-decision.md` (planned) | Proven ASR primary/fallback, latency, quality, cost, privacy, and credentials | MC-SPEC-020–021, MC-ADR-008 | evidence-needed | Task 8 measured ASR spike |
| MC-SPEC-018 | [Desktop OS adapters](mobile-command-desktop-os-adapters.md) | Desktop capture/input adapter boundary and safety invariants | MC-SPEC-007, MC-SPEC-011, MC-SPEC-016 | evidence-needed | OS helper spike and packaging evidence missing |
| MC-SPEC-019 | [OS helper spike](mobile-command-os-helper-spike.md) | Candidate evaluation procedure and raw OS helper evidence requirements | MC-SPEC-005, MC-SPEC-018 | evidence-needed | Real Windows/macOS/Linux results missing |
| MC-SPEC-020 | [Voice input contract](mobile-command-voice-input.md) | Voice composer semantics, transcript merge, direct-send safety, and failure behavior | MC-SPEC-007, MC-SPEC-010–011, MC-SPEC-017 | draft | ASR decision and privacy review missing |
| MC-SPEC-021 | [ASR provider spike](mobile-command-asr-provider-spike.md) | ASR candidates, evaluation metrics, test script, and evidence deliverables | MC-SPEC-020 | evidence-needed | Measured latency/quality/cost/privacy results missing |
| MC-SPEC-022 | `mobile-command-visual-design-system.md` (planned) | Brand-derived tokens, layouts, states, safe areas, dark mode, and visual QA references | MC-SPEC-031–033 | evidence-needed | Task 9 design evidence and approval |
| MC-SPEC-023 | `mobile-command-infrastructure-deployment.md` (planned) | Signaling, TURN, storage, push, TLS, secrets, capacity, cost, backup, and DR topology | MC-SPEC-005–014, MC-ADR-004, MC-ADR-009–010 | evidence-needed | Task 9 provider/topology evidence and operations approval |
| MC-SPEC-024 | `mobile-command-privacy-retention-compliance.md` (planned) | Data inventory, prohibitions, redaction, retention, deletion, EXIF, consent, and privacy copy | MC-SPEC-006–010, MC-SPEC-017, MC-SPEC-023 | evidence-needed | Task 9 privacy/security/legal review |
| MC-SPEC-025 | `mobile-command-observability-support.md` (planned) | Telemetry schema, metrics, alerts, diagnostics, dashboards, and support workflows | MC-SPEC-010–011, MC-SPEC-023–024 | evidence-needed | Task 9 operations/support evidence |
| MC-SPEC-026 | [Permission and threat model](mobile-command-permission-threat-model.md) | Authority levels, approvals, threats, audit, and fail-safe rules | MC-SPEC-007, MC-SPEC-011 | draft | Identity reconciliation and security review required |
| MC-SPEC-027 | [File transfer contract](mobile-command-file-transfer-contract.md) | Upload/download lifecycle, integrity, quotas, staging, risk, and cleanup semantics | MC-SPEC-006–011, MC-SPEC-024 | draft | Schema and retention reconciliation required |
| MC-SPEC-028 | [Native capability shell](mobile-command-native-shell.md) | Native boundary semantics for keys, background upload, push, sharing, permissions, camera, and lifecycle | MC-SPEC-007, MC-SPEC-014, MC-ADR-002, MC-ADR-009 | draft | Native-shell and push decisions missing |
| MC-SPEC-029 | [WebRTC runbook](mobile-command-webrtc-runbook.md) | WebRTC runtime behavior, reconnect, backpressure, degradation, telemetry, and QA procedure | MC-SPEC-011, MC-SPEC-015–016, MC-SPEC-023, MC-ADR-004–007 | evidence-needed | TURN and platform evidence missing |
| MC-SPEC-030 | [Protocol prose](mobile-command-protocol-schema.md) | Human-readable protocol semantics and compatibility explanation | MC-SPEC-006–011 | draft | Must reconcile with machine-readable schemas |
| MC-SPEC-031 | [UI specification](mobile-command-ui-spec.md) | Mobile navigation, interaction, states, safety UI, accessibility, and i18n behavior | MC-SPEC-020, MC-SPEC-022, MC-SPEC-026–029 | draft | Visual system and platform QA missing |
| MC-SPEC-032 | [Brand assets](mobile-command-brand-assets.md) | Brand identity, source assets, required outputs, and visual QA | MC-SPEC-005 | draft | Design approval and generated visual evidence missing |
| MC-SPEC-033 | [Icon generation script specification](mobile-command-icon-generation-script.md) | Deterministic icon pipeline inputs, outputs, processing, failures, and tests | MC-SPEC-032 | draft | Implementation is post-freeze work; design review remains |
| MC-SPEC-034 | [Build and release](mobile-command-build-release.md) | Artifact, environment, signing, channel, compatibility, CI, store, and rollback requirements | MC-SPEC-005, MC-SPEC-015, MC-SPEC-023, MC-ADR-001–002, MC-ADR-011–012 | evidence-needed | Repository/build/release decisions missing |
| MC-SPEC-035 | [Operations runbook](mobile-command-ops-runbook.md) | Procedural monitoring, incident response, rate-limit, diagnostics, and release operations | MC-SPEC-023–025 | draft | Topology and support contracts must become canonical |
| MC-SPEC-036 | [Repository implementation map](mobile-command-repo-implementation-map.md) | Planned module placement and implementation order | MC-SPEC-005, MC-SPEC-002 | evidence-needed | Task 2 must replace unverified paths/conditionals |
| MC-SPEC-037 | [Test plan](mobile-command-test-plan.md) | Test layers, suites, platform matrix, severity, fixtures, and release gates | MC-SPEC-003, MC-SPEC-009–011, MC-SPEC-015 | draft | Traceability and final contracts missing |
| MC-SPEC-038 | [Test cases](mobile-command-test-cases.md) | Existing Given/When/Then scenario drafts | MC-SPEC-009–011, MC-SPEC-026–031 | draft | IDs and coverage must reconcile with traceability |
| MC-SPEC-039 | [Implementation overview](mobile-command-pro-implementation.md) | Non-canonical product/architecture overview and historical implementation analysis | MC-SPEC-001–002 | draft | Must defer conflicting facts to canonical owners |
| MC-SPEC-040 | [Closure dashboard](mobile-command-remaining-gaps.md) | Current closure blockers, owners, dependencies, evidence, and historical disposition | MC-SPEC-001–002 | review-ready | Task 1 consolidation; update at every closure gate |

## 4. Acceptance Boundary

No artifact in this index is accepted as of 2026-07-12. `review-ready` means ready for the named review, not approved. Production implementation remains unauthorized until MC-SPEC-004 is accepted with all required dependencies accepted.
