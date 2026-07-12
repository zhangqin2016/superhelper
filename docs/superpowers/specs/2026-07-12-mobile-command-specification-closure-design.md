# Mobile Command Pro Specification Closure Design

## 1. Purpose

This design defines how Lily Mobile Command Pro reaches specification freeze before any production implementation begins. The objective is not to create more prose. It is to eliminate every decision that would otherwise be guessed during implementation and to make every requirement traceable to a machine-readable contract, an owner module, a verification case, and a release gate.

Production implementation must not start until the closure gate in this document passes.

## 2. Current State

The repository contains 22 Mobile Command documents and schema drafts covering product direction, architecture, UI behavior, permissions, protocol concepts, WebRTC, file transfer, native capabilities, testing, operations, and release behavior.

The set is suitable for architecture review but is not implementation-ready because:

- several technology and repository-placement choices remain recommendations rather than decisions;
- the account, license, device, authentication, route, session, artifact, and configuration contracts have not been reconciled with the current repository;
- the OpenAPI and event schemas do not cover every required flow;
- OS helper and ASR spike matrices still contain `TBD` results;
- state machines and recovery rules are distributed across documents and can diverge;
- requirements are not yet traceable from product intent through contract and test to release gate;
- visual design, infrastructure topology, privacy retention, observability, and support operations are not fully specified.

## 3. Closure Principles

1. **No implementation by assumption.** A production implementation choice must be stated as a decision with evidence, not as “preferred,” “suggested,” or “if needed.”
2. **One owner per fact.** Each field, state, error, permission, and lifecycle rule has one canonical document. Other documents link to it instead of restating it.
3. **Repository-grounded contracts.** Integration specifications name real exports, callers, route registrars, tables, configuration sources, and compatibility behavior after inspecting the current code.
4. **Machine-readable boundaries.** Network, event, native bridge, and persisted-data boundaries have schemas that automated validation can consume.
5. **Fail open for baseline capability, fail safe for authority.** Remote failures preserve local Lily behavior; permission or policy uncertainty rejects sensitive remote actions.
6. **Evidence before platform decisions.** OS helper, ASR, TURN, push, and temporary-storage choices require recorded prototype or operational evidence.
7. **Traceability is the completion test.** A requirement is incomplete unless it maps to its canonical contract, planned owner, verification case, and release gate.

## 4. Documentation Architecture

### 4.1 Control Documents

Create the following control layer:

| Document | Canonical responsibility |
|---|---|
| `docs/mobile-command-spec-index.md` | Document catalog, ownership, dependency order, status, and conflict rules |
| `docs/mobile-command-decision-log.md` | Final architectural and vendor decisions with evidence and supersession rules |
| `docs/mobile-command-requirements-traceability.md` | Requirement IDs mapped to contracts, owner modules, tests, and release gates |
| `docs/mobile-command-release-readiness-checklist.md` | Specification-freeze and later release sign-off gates |

The index is the navigation entry point. The decision log is the only location that decides alternatives. The traceability matrix determines coverage. The readiness checklist determines whether implementation may begin.

### 4.2 Repository And Domain Contracts

Create:

| Document | Canonical responsibility |
|---|---|
| `docs/mobile-command-existing-system-integration.md` | Verified current exports, callers, registration patterns, and reusable services |
| `docs/mobile-command-data-model.md` | Final tables, columns, indexes, foreign keys, retention, and revocation cascades |
| `docs/mobile-command-auth-identity-contract.md` | User, license, desktop device, mobile device, key, token, pairing, and rotation semantics |
| `docs/mobile-command-agent-bridge-contract.md` | Injection into existing conversations, concurrency, streaming, tools, approvals, and artifacts |

The integration audit must precede the other three. Generic names such as `account_id` may not remain in final contracts unless they map explicitly to an existing or newly approved repository concept.

### 4.3 Protocol And Lifecycle Contracts

Create:

| Document | Canonical responsibility |
|---|---|
| `docs/mobile-command-api-completeness-matrix.md` | Every user flow mapped to HTTP, WebSocket, DataChannel, upload, push, and native bridge operations |
| `docs/mobile-command-error-recovery-catalog.md` | Error codes, transport status, retry policy, user copy key, telemetry, downgrade, and revocation behavior |
| `docs/mobile-command-state-machines.md` | Pairing, remote session, WebRTC, permission, approval, upload, revocation, reconnect, and background states |

Update the existing machine-readable schemas after these canonical documents are accepted:

- `docs/schemas/mobile-command.openapi.yaml`
- `docs/schemas/mobile-command-events.schema.json`
- `docs/schemas/mobile-command-native-bridge.schema.json`

Schemas must cover all matrix rows and must reject invalid discriminators, versions, bounds, and forbidden field combinations.

### 4.4 Platform And Product Contracts

Create:

| Document | Canonical responsibility |
|---|---|
| `docs/mobile-command-platform-support-matrix.md` | Supported feature level and degradation for every desktop/mobile platform pair |
| `docs/mobile-command-os-helper-decision.md` | Proven capture/input helper choices, IPC, permission, signing, packaging, and recovery |
| `docs/mobile-command-asr-decision.md` | Proven ASR primary/fallback choices, latency, quality, cost, privacy, and credential model |
| `docs/mobile-command-visual-design-system.md` | Brand-derived tokens, layouts, states, safe areas, dark mode, touch targets, and visual QA references |

The OS helper and ASR decision documents record completed spike results. They may not contain unexecuted evaluation tables at specification freeze.

### 4.5 Operations And Governance Contracts

Create:

| Document | Canonical responsibility |
|---|---|
| `docs/mobile-command-infrastructure-deployment.md` | Signaling, TURN, storage, push, TLS, secrets, capacity, cost, backup, and disaster recovery topology |
| `docs/mobile-command-privacy-retention-compliance.md` | Collected data, prohibited data, redaction, retention, deletion, EXIF, consent, and privacy copy |
| `docs/mobile-command-observability-support.md` | Telemetry schema, metrics, alerts, diagnostics package, dashboards, and support workflows |

These documents refine rather than duplicate the existing operations runbook. The runbook remains the procedural incident guide; the new documents own topology, data governance, and observability contracts.

## 5. Dependency Order

Documentation closes in six gates:

1. **Inventory gate:** create the spec index, identify canonical owners, and record all unresolved decisions.
2. **Repository truth gate:** complete the existing-system integration audit and resolve identity/data-model terminology.
3. **Domain gate:** finalize data, auth/identity, agent bridge, permissions, file transfer, and configuration contracts.
4. **Protocol gate:** finalize lifecycle state machines, error catalog, API completeness matrix, and machine-readable schemas.
5. **Evidence gate:** complete OS helper, ASR, TURN/storage/push, visual design, privacy, and observability decisions using recorded evidence.
6. **Traceability gate:** map every requirement to contracts and verification, eliminate ambiguity markers, and sign the readiness checklist.

A later gate may expose a defect in an earlier document. The earlier canonical document must then be revised and its dependent documents revalidated before closure continues.

## 6. Decision Records

Every unresolved choice receives a stable decision ID such as `MC-ADR-001`. Each record contains:

- problem and constraints;
- considered alternatives;
- selected alternative;
- evidence or repository observations;
- security and capability-gate effects;
- failure and fallback behavior;
- compatibility and migration consequences;
- documents superseded by the decision;
- decision owner and acceptance date.

Mandatory decisions include mobile application location and build system, native shell, identity mapping, OS capture/input technology, ASR, TURN, push, temporary storage, feature-flag source, and release coupling.

## 7. Requirements And Traceability

Requirements use stable IDs grouped by domain, for example:

- `MC-CMD-*` for agent command behavior;
- `MC-PAIR-*` for pairing and identity;
- `MC-LIVE-*` for observe/control behavior;
- `MC-PERM-*` for permissions and approvals;
- `MC-FILE-*` for upload/download behavior;
- `MC-OPS-*` for infrastructure and operations;
- `MC-PRIV-*` for privacy and retention;
- `MC-REL-*` for compatibility and release behavior.

Each row must identify:

1. normative requirement text;
2. canonical specification section;
3. protocol/schema reference where applicable;
4. planned repository owner;
5. automated test case ID;
6. manual/platform QA case ID where applicable;
7. release gate;
8. failure-mode classification: baseline fail-open, authority fail-safe, or ordinary recoverable failure.

No requirement may be marked ready with any mapping empty unless the row explains why that artifact is not applicable.

## 8. Validation Strategy

Specification validation is deterministic where possible:

- parse JSON Schema and OpenAPI files;
- verify every operation/event/native method has an API-matrix row;
- verify every error reference exists in the error catalog;
- verify every state transition referenced by a contract exists in the state-machine document;
- verify every requirement ID is unique and has required traceability columns;
- scan normative documents for unresolved markers including `TBD`, `TODO`, `待定`, and undecided alternative language;
- verify all relative document links resolve;
- compare named repository paths and exports against the current tree;
- verify capability-gate requirements have explicit negative and fallback test cases.

Human review remains required for platform evidence, threat modeling, privacy copy, visual design, operational costs, and store/signing obligations.

## 9. Specification Freeze Gate

AI implementation is authorized only when all conditions are true:

- the spec index marks every required document accepted;
- the decision log contains no unresolved mandatory decision;
- the repository integration audit names verified current interfaces and contains no guessed export;
- data and identity contracts match the accepted repository model;
- all external boundaries are represented by valid machine-readable schemas;
- every lifecycle and error has an explicit recovery or revocation path;
- OS helper, ASR, TURN, push, and storage decisions contain completed evidence;
- platform support and degradation are explicit;
- privacy, retention, observability, capacity, cost, rollback, and support behavior are accepted;
- the traceability matrix has no unexplained gaps;
- specification validation checks pass;
- a final ambiguity scan finds no unresolved placeholder or alternative;
- the readiness checklist is signed for product, engineering, security, design, and operations concerns.

Passing this gate means an implementation agent can execute a plan without inventing product behavior or architectural choices. It does not waive test-driven implementation, code review, platform QA, or the repository capability gate.

## 10. Scope Boundaries

This closure program produces specifications, evidence records, schema corrections, and validation tooling for documentation. It does not implement mobile pairing, remote sessions, WebRTC, OS input, native applications, server routes, or production infrastructure.

Small read-only probes and disposable prototypes are allowed only when needed to resolve an architectural decision. Prototype code is not production code and must not be wired into the application during this phase.

## 11. Success Criteria

The documentation phase is complete when a fresh implementation agent can answer, using canonical repository documents alone:

- what to build and what not to build;
- exactly where each responsibility belongs;
- every persisted and transmitted field;
- every valid state transition and error recovery path;
- how identity, licensing, authentication, permissions, and revocation interact;
- what each supported platform can do and how it degrades;
- which vendors and technologies are selected and why;
- how the system is deployed, observed, supported, rolled back, and governed;
- which tests prove every requirement and capability-gate invariant;
- whether a completed implementation is eligible for release.

If any answer requires guessing, the specification is not frozen.
