# Lily Mobile Command Pro Specification Index

## 1. Purpose And Status Vocabulary

This document is the canonical navigation and ownership map for Mobile Command specification closure. It records the dependency order and prevents two documents from independently deciding the same fact. It does not authorize production implementation.

Current demo implementation status is tracked separately in [Mobile Command Current Demo Status](mobile-command-current-demo-status.md). That document is an implementation evidence note for the Phase 1 web demo; it is not a production release authorization record and does not change the closure status of the MC-SPEC rows below.

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
4. [The requirements traceability matrix](mobile-command-requirements-traceability.md) owns coverage from requirement to contract, repository owner, test, and release gate.
5. [The readiness checklist](mobile-command-release-readiness-checklist.md) owns authorization to begin implementation. No prose claim elsewhere overrides it.
6. When artifacts conflict, the canonical owner above wins. The losing artifact must link to the owner and remove or label the duplicate as non-normative.
7. A dependent artifact cannot be `accepted` while a required dependency or mandatory ADR is unresolved.

## 3. Canonical Artifact Index

| ID | Document | Canonical responsibility | Depends on | Status | Evidence approval |
|---|---|---|---|---|---|
| MC-SPEC-001 | [Specification index](mobile-command-spec-index.md) | Artifact catalog, canonical ownership, dependency order, status, and conflict rules | — | review-ready | [Task 1 inventory](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-1-establish-the-canonical-specification-control-layer); engineering review required |
| MC-SPEC-002 | [Decision log](mobile-command-decision-log.md) | Alternatives, selected decisions, evidence, fallback, compatibility, and supersession | MC-SPEC-001 | evidence-needed | Mandatory ADR inventory exists; evidence tasks remain open |
| MC-SPEC-003 | [Requirements traceability](mobile-command-requirements-traceability.md) | Requirement-to-contract-to-owner-to-test-to-release coverage | MC-SPEC-005, MC-SPEC-008–017, MC-SPEC-019–030 | evidence-needed | Task 9 matrix, stable IDs and bidirectional sample exist; external platform/provider/privacy/build rows remain blocked and dependencies are not accepted |
| MC-SPEC-004 | [Release readiness checklist](mobile-command-release-readiness-checklist.md) | Specification-freeze authorization and later release sign-off | MC-SPEC-002–003, MC-SPEC-005–030, MC-SPEC-037–038 | evidence-needed | Task 9 explicitly records Specification Freeze and Production Release BLOCKED; Task 10 validation and Task 11 final freeze remain pending |
| MC-SPEC-005 | `mobile-command-existing-system-integration.md` (planned) | Verified current exports, callers, routes, tables, configuration, and reusable seams | MC-SPEC-001–002 | evidence-needed | [Task 2 repository audit](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-2-audit-current-repository-integration-points) |
| MC-SPEC-006 | `mobile-command-data-model.md` (planned) | Final tables, columns, constraints, indexes, retention, and revocation cascades | MC-SPEC-005, MC-ADR-003 | evidence-needed | [Task 3 identity and persistence](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-3-freeze-identity-authentication-and-persistence-semantics) |
| MC-SPEC-007 | `mobile-command-auth-identity-contract.md` (planned) | Identity, credentials, pairing, binding, rotation, replay defense, and revocation semantics | MC-SPEC-005–006, MC-ADR-003 | evidence-needed | [Task 3 identity and persistence](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-3-freeze-identity-authentication-and-persistence-semantics) |
| MC-SPEC-008 | `mobile-command-agent-bridge-contract.md` (planned) | Existing-conversation injection, concurrency, streaming, tools, approvals, and artifacts | MC-SPEC-005, MC-SPEC-007 | evidence-needed | [Task 4 agent bridge](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-4-freeze-agent-bridge-and-local-capability-boundaries) |
| MC-SPEC-009 | `mobile-command-api-completeness-matrix.md` (planned) | Every flow mapped to HTTP, WebSocket, DataChannel, upload, push, and native operations | MC-SPEC-007–008, MC-SPEC-010–011 | draft | [Task 5 protocol coverage](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-5-unify-state-machines-errors-and-api-coverage) |
| MC-SPEC-010 | `mobile-command-error-recovery-catalog.md` (planned) | Error IDs, transport status, retry, copy, telemetry, downgrade, and revocation | MC-SPEC-007–008 | draft | [Task 5 protocol coverage](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-5-unify-state-machines-errors-and-api-coverage) |
| MC-SPEC-011 | `mobile-command-state-machines.md` (planned) | Canonical pairing, session, WebRTC, permission, approval, upload, revocation, reconnect, and background states | MC-SPEC-007–008, MC-SPEC-010 | draft | [Task 5 protocol coverage](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-5-unify-state-machines-errors-and-api-coverage) |
| MC-SPEC-012 | [OpenAPI schema](schemas/mobile-command.openapi.yaml) | HTTP wire syntax for pairing, devices, sessions, TURN, uploads, and artifacts | MC-SPEC-006–011 | draft | [Task 6 schema completion](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-6-complete-machine-readable-schemas) |
| MC-SPEC-013 | [Event schema](schemas/mobile-command-events.schema.json) | WebSocket and DataChannel envelope/event wire syntax | MC-SPEC-008–011 | draft | [Task 6 schema completion](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-6-complete-machine-readable-schemas) |
| MC-SPEC-014 | [Native bridge schema](schemas/mobile-command-native-bridge.schema.json) | Native request/response method wire syntax | MC-SPEC-007, MC-SPEC-009–011, MC-ADR-002 | draft | [Task 6 schema completion](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-6-complete-machine-readable-schemas) |
| MC-SPEC-015 | [Platform evidence matrix](mobile-command-platform-support-matrix.md) | Supported level and explicit degradation for every desktop/mobile platform pair | MC-SPEC-016–019, MC-ADR-004–008 | evidence-needed | 2026-07-12 matrix records macOS limited evidence and Windows/Linux/mobile unverified states; no platform pair is approved |
| MC-SPEC-016 | [OS helper decision gate](mobile-command-os-helper-decision.md) | Proven OS capture/input helpers, IPC, permissions, signing, packaging, and recovery | MC-SPEC-018–019, MC-ADR-005–007 | evidence-needed | No helper selected: macOS runtime/signing evidence incomplete; Windows/Linux device evidence absent |
| MC-SPEC-017 | [ASR decision gate](mobile-command-asr-decision.md) | Proven ASR primary/fallback, latency, quality, cost, privacy, and credentials | MC-SPEC-020–021, MC-ADR-008 | evidence-needed | Official capability sources only; no device/corpus/credential performance or privacy evidence, so no provider selected |
| MC-SPEC-018 | [Desktop OS adapters](mobile-command-desktop-os-adapters.md) | Desktop capture/input adapter boundary and safety invariants | MC-SPEC-005, MC-SPEC-007 | evidence-needed | OS helper spike and packaging evidence missing |
| MC-SPEC-019 | [OS helper spike](mobile-command-os-helper-spike.md) | Candidate evaluation procedure and raw OS helper evidence requirements | MC-SPEC-005, MC-SPEC-018 | evidence-needed | 2026-07-12: limited macOS API/permission observations recorded; usable capture/input, packaging, signing, Windows, and Linux results missing |
| MC-SPEC-020 | [Voice input contract](mobile-command-voice-input.md) | Voice composer semantics, transcript merge, direct-send safety, and failure behavior | MC-SPEC-007, MC-SPEC-026 | draft | ASR decision and privacy review missing |
| MC-SPEC-021 | [ASR provider spike](mobile-command-asr-provider-spike.md) | ASR candidates, evaluation metrics, test script, and evidence deliverables | MC-SPEC-020 | evidence-needed | Official candidate capabilities recorded; all real-device latency, quality, mixed-language, battery, cost, credential, and privacy results missing |
| MC-SPEC-022 | `mobile-command-visual-design-system.md` (blocked, not created) | Brand-derived tokens, layouts, states, safe areas, dark mode, and visual QA references | MC-SPEC-031–033 | evidence-needed | Missing high-fidelity screens, brand-derived token proof, state screenshots, accessibility QA, and design approval |
| MC-SPEC-023 | [Infrastructure deployment evidence](mobile-command-infrastructure-deployment.md) | Audited baseline, candidate signaling/TURN/storage/push topology, secrets, capacity/cost formulas, backup/DR and exact blocking artifacts | MC-SPEC-005–014, MC-ADR-004, MC-ADR-009–010 | evidence-needed | Provider/account/region/config/load/quote/rotation/deletion/rollback evidence is BLOCKED |
| MC-SPEC-024 | [Privacy, retention, and compliance evidence](mobile-command-privacy-retention-compliance.md) | Data inventory, prohibitions, consent, retention/deletion proof, export and cross-border approval gates | MC-SPEC-006–010, MC-SPEC-017, MC-SPEC-023 | evidence-needed | Exact retention, provider/region, purge/backup proof, copy and cross-border approvals are BLOCKED |
| MC-SPEC-025 | [Observability and support evidence](mobile-command-observability-support.md) | Telemetry allowlist/redaction/cardinality, SLO evidence gate, alerts, diagnostics, dashboards and support access | MC-SPEC-010–011, MC-SPEC-023–024 | evidence-needed | Pipeline/schema/SLO/threshold/dashboard/drill/RBAC/deletion evidence is BLOCKED |
| MC-SPEC-026 | [Permission and threat model](mobile-command-permission-threat-model.md) | Authority levels, approvals, threats, audit, and fail-safe rules | MC-SPEC-005, MC-SPEC-007 | draft | Identity reconciliation and security review required |
| MC-SPEC-027 | [File transfer contract](mobile-command-file-transfer-contract.md) | Upload/download lifecycle, integrity, quotas, staging, risk, and cleanup semantics | MC-SPEC-006–008, MC-SPEC-026 | draft | Schema and retention reconciliation required |
| MC-SPEC-028 | [Native capability shell](mobile-command-native-shell.md) | Native boundary semantics for keys, background upload, push, sharing, permissions, camera, and lifecycle | MC-SPEC-005, MC-SPEC-007, MC-ADR-002, MC-ADR-009 | draft | Native-shell and push decisions missing |
| MC-SPEC-029 | [WebRTC runbook](mobile-command-webrtc-runbook.md) | WebRTC runtime behavior, reconnect, backpressure, degradation, telemetry, and QA procedure | MC-SPEC-011, MC-SPEC-015–016, MC-SPEC-023, MC-ADR-004–007 | evidence-needed | TURN and platform evidence missing |
| MC-SPEC-030 | [Protocol prose](mobile-command-protocol-schema.md) | Human-readable protocol semantics and compatibility explanation | MC-SPEC-006–011 | draft | Must reconcile with machine-readable schemas |
| MC-SPEC-031 | [UI specification](mobile-command-ui-spec.md) | Mobile navigation, interaction, states, safety UI, accessibility, and i18n behavior | MC-SPEC-020, MC-SPEC-026–028 | draft | Visual system and platform QA missing |
| MC-SPEC-032 | [Brand assets](mobile-command-brand-assets.md) | Brand identity, source assets, required outputs, and visual QA | MC-SPEC-005 | draft | Design approval and generated visual evidence missing |
| MC-SPEC-033 | [Icon generation script specification](mobile-command-icon-generation-script.md) | Deterministic icon pipeline inputs, outputs, processing, failures, and tests | MC-SPEC-032 | draft | Implementation is post-freeze work; design review remains |
| MC-SPEC-034 | [Build and release](mobile-command-build-release.md) | Artifact, environment, signing, channel, compatibility, CI, store, and rollback requirements | MC-SPEC-005, MC-SPEC-015, MC-SPEC-023, MC-ADR-001–002, MC-ADR-011–012 | evidence-needed | Repository/build/release decisions missing |
| MC-SPEC-035 | [Operations runbook](mobile-command-ops-runbook.md) | Procedural monitoring, incident response, rate-limit, diagnostics, and release operations | MC-SPEC-023–025 | draft | Links canonical topology/privacy/telemetry contracts; commands, thresholds, alerts, support controls and kill switches still require implementation/drill evidence |
| MC-SPEC-036 | [Repository implementation map](mobile-command-repo-implementation-map.md) | Planned module placement and implementation order | MC-SPEC-005, MC-SPEC-002 | evidence-needed | [Task 2 repository audit](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-2-audit-current-repository-integration-points) must replace unverified paths/conditionals |
| MC-SPEC-037 | [Test plan](mobile-command-test-plan.md) | Test layers, suites, platform matrix, severity, fixtures, and release gates | MC-SPEC-003, MC-SPEC-009–011, MC-SPEC-015 | evidence-needed | Stable suite ownership and required negative/platform coverage are defined; implementation logs and accepted platform dependencies are absent |
| MC-SPEC-038 | [Test cases](mobile-command-test-cases.md) | Stable Given/When/Then cases and manual evidence record shape | MC-SPEC-003, MC-SPEC-009–011, MC-SPEC-026–031 | evidence-needed | Stable MC-TC mappings exist; planned automated files and manual platform records are not execution evidence |
| MC-SPEC-039 | [Implementation overview](mobile-command-pro-implementation.md) | Superseded historical product/architecture overview; not a normative closure input | MC-SPEC-001–002 | superseded | Superseded by the canonical owners MC-SPEC-001–038 and MC-SPEC-040; non-blocking |
| MC-SPEC-040 | [Closure dashboard](mobile-command-remaining-gaps.md) | Current closure blockers, owners, dependencies, evidence, and historical disposition | MC-SPEC-001–002 | review-ready | [Task 1 consolidation](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-1-establish-the-canonical-specification-control-layer); update at every closure gate |

## 4. Six-Gate Dependency Order

The artifact graph is directed and acyclic. Dependencies may point to the same gate when the row order below supplies the local topology, or to an earlier gate; they must never point to a later gate.

1. **Inventory:** MC-SPEC-001 → MC-SPEC-002 → MC-SPEC-040. MC-SPEC-039 is superseded historical context and has no outgoing normative dependency.
2. **Repository truth:** MC-SPEC-005 → MC-SPEC-036.
3. **Domain:** MC-SPEC-006 → MC-SPEC-007 → MC-SPEC-008 and MC-SPEC-026 → MC-SPEC-027/028 → MC-SPEC-020 → MC-SPEC-031/032 → MC-SPEC-033.
4. **Protocol:** MC-SPEC-010 → MC-SPEC-011 → MC-SPEC-009 → MC-SPEC-012/013/014 and MC-SPEC-030.
5. **Evidence:** MC-SPEC-018 → MC-SPEC-019 → MC-SPEC-016; MC-SPEC-020 → MC-SPEC-021 → MC-SPEC-017; then MC-SPEC-015, MC-SPEC-022–025, MC-SPEC-029, MC-SPEC-034, and MC-SPEC-035 as their listed evidence dependencies permit.
6. **Traceability:** MC-SPEC-003 → MC-SPEC-037/038 → MC-SPEC-004.

In particular, OS adapter requirements precede the OS spike and decision; voice semantics precede the ASR spike and decision; UI/brand requirements precede visual-design acceptance. Evidence decisions do not feed backward into their own input contracts.

## 5. Acceptance Boundary

No artifact in this index is accepted as of 2026-07-12. `review-ready` means ready for the named review, not approved.

The machine-checkable blocking IDs are exactly: `MC-SPEC-001`, `MC-SPEC-002`, `MC-SPEC-003`, `MC-SPEC-004`, `MC-SPEC-005`, `MC-SPEC-006`, `MC-SPEC-007`, `MC-SPEC-008`, `MC-SPEC-009`, `MC-SPEC-010`, `MC-SPEC-011`, `MC-SPEC-012`, `MC-SPEC-013`, `MC-SPEC-014`, `MC-SPEC-015`, `MC-SPEC-016`, `MC-SPEC-017`, `MC-SPEC-018`, `MC-SPEC-019`, `MC-SPEC-020`, `MC-SPEC-021`, `MC-SPEC-022`, `MC-SPEC-023`, `MC-SPEC-024`, `MC-SPEC-025`, `MC-SPEC-026`, `MC-SPEC-027`, `MC-SPEC-028`, `MC-SPEC-029`, `MC-SPEC-030`, `MC-SPEC-031`, `MC-SPEC-032`, `MC-SPEC-033`, `MC-SPEC-034`, `MC-SPEC-035`, `MC-SPEC-036`, `MC-SPEC-037`, `MC-SPEC-038`, and `MC-SPEC-040`.

MC-SPEC-039 is explicitly `superseded` and non-blocking. Specification Freeze passes only when every blocking row has `Status = accepted`, every mandatory MC-ADR row has `Status: accepted`, and MC-SPEC-004 records the [Task 11 final-freeze review](superpowers/plans/2026-07-12-mobile-command-specification-closure.md#task-11-final-specification-freeze-review) as passed. No implicit range or unindexed document may alter that result.

Non-normative implementation status notes, including [Mobile Command Current Demo Status](mobile-command-current-demo-status.md), may summarize what the demo can do today. They cannot mark a blocking MC-SPEC row accepted or authorize production release.
