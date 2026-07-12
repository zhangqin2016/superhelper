# Lily Mobile Command Pro Specification Closure Dashboard

## 1. Current Gate

Status: **not build-ready**. The existing set supports architecture review, but production implementation remains unauthorized. The canonical artifact states are in the [specification index](mobile-command-spec-index.md); unresolved alternatives are in the [decision log](mobile-command-decision-log.md).

This dashboard reports closure work, not product implementation work. Generated code, CI jobs, native helpers, deployed infrastructure, and production routes belong to a later implementation plan unless evidence gathering explicitly requires a disposable prototype.

This dashboard is a projection, never a second source of truth. Projection references use `@ID.Field`: `@MC-SPEC-*.DependsOn`, `@MC-SPEC-*.EvidenceApproval`, and `@MC-SPEC-*.Status` resolve to the matching index row; `@MC-ADR-*.EvidenceRefs` and `@MC-ADR-*.Status` resolve to the matching decision record. Owners are canonical IDs, not duplicated descriptions.

Update rule: first change the canonical index row or ADR, then refresh this projection in the same commit. A dashboard cell containing independent dependency, evidence, or status prose is invalid. If projections disagree, the index/ADR wins and this file must be corrected before review.

## 2. Closure Dashboard

| Gap | Owner artifact | Depends on | Evidence required to close | Status |
|---|---|---|---|---|
| Repository integration and mobile app boundary | MC-SPEC-005, MC-SPEC-036, MC-ADR-001 | @MC-SPEC-005.DependsOn | @MC-SPEC-005.EvidenceApproval; @MC-ADR-001.EvidenceRefs | @MC-SPEC-005.Status; @MC-ADR-001.Status |
| Identity, licensing, authentication, and persisted data | MC-SPEC-006, MC-SPEC-007, MC-SPEC-026, MC-ADR-003 | @MC-SPEC-006.DependsOn; @MC-SPEC-007.DependsOn | @MC-SPEC-006.EvidenceApproval; @MC-SPEC-007.EvidenceApproval; @MC-ADR-003.EvidenceRefs | @MC-SPEC-006.Status; @MC-SPEC-007.Status; @MC-ADR-003.Status |
| Agent bridge and existing conversation behavior | MC-SPEC-008, MC-SPEC-009, MC-SPEC-010, MC-SPEC-011 | @MC-SPEC-008.DependsOn | @MC-SPEC-008.EvidenceApproval | @MC-SPEC-008.Status |
| Complete lifecycle, error, and API inventory | MC-SPEC-009, MC-SPEC-010, MC-SPEC-011 | @MC-SPEC-009.DependsOn; @MC-SPEC-010.DependsOn; @MC-SPEC-011.DependsOn | @MC-SPEC-009.EvidenceApproval; @MC-SPEC-010.EvidenceApproval; @MC-SPEC-011.EvidenceApproval | @MC-SPEC-009.Status; @MC-SPEC-010.Status; @MC-SPEC-011.Status |
| Machine-readable HTTP, event, and native boundaries | MC-SPEC-012, MC-SPEC-013, MC-SPEC-014, MC-ADR-002 | @MC-SPEC-012.DependsOn; @MC-SPEC-013.DependsOn; @MC-SPEC-014.DependsOn | @MC-SPEC-012.EvidenceApproval; @MC-SPEC-013.EvidenceApproval; @MC-SPEC-014.EvidenceApproval; @MC-ADR-002.EvidenceRefs | @MC-SPEC-012.Status; @MC-SPEC-013.Status; @MC-SPEC-014.Status; @MC-ADR-002.Status |
| Windows capture and input | MC-SPEC-016, MC-SPEC-019, MC-ADR-005 | @MC-SPEC-016.DependsOn; @MC-SPEC-019.DependsOn | @MC-SPEC-016.EvidenceApproval; @MC-SPEC-019.EvidenceApproval; @MC-ADR-005.EvidenceRefs | @MC-SPEC-016.Status; @MC-SPEC-019.Status; @MC-ADR-005.Status |
| macOS capture and input | MC-SPEC-016, MC-SPEC-019, MC-ADR-006 | @MC-SPEC-016.DependsOn; @MC-SPEC-019.DependsOn | @MC-SPEC-016.EvidenceApproval; @MC-SPEC-019.EvidenceApproval; @MC-ADR-006.EvidenceRefs | @MC-SPEC-016.Status; @MC-SPEC-019.Status; @MC-ADR-006.Status |
| Linux support/degradation | MC-SPEC-015, MC-SPEC-016, MC-SPEC-019, MC-ADR-007 | @MC-SPEC-015.DependsOn; @MC-SPEC-016.DependsOn; @MC-SPEC-019.DependsOn | @MC-SPEC-015.EvidenceApproval; @MC-SPEC-016.EvidenceApproval; @MC-SPEC-019.EvidenceApproval; @MC-ADR-007.EvidenceRefs | @MC-SPEC-015.Status; @MC-SPEC-016.Status; @MC-SPEC-019.Status; @MC-ADR-007.Status |
| ASR provider and privacy path | MC-SPEC-017, MC-SPEC-020, MC-SPEC-021, MC-ADR-008 | @MC-SPEC-017.DependsOn; @MC-SPEC-020.DependsOn; @MC-SPEC-021.DependsOn | @MC-SPEC-017.EvidenceApproval; @MC-SPEC-021.EvidenceApproval; @MC-ADR-008.EvidenceRefs | @MC-SPEC-017.Status; @MC-SPEC-020.Status; @MC-SPEC-021.Status; @MC-ADR-008.Status |
| Native shell and Capacitor boundary | MC-SPEC-014, MC-SPEC-028, MC-SPEC-034, MC-ADR-002 | @MC-SPEC-014.DependsOn; @MC-SPEC-028.DependsOn; @MC-SPEC-034.DependsOn | @MC-SPEC-014.EvidenceApproval; @MC-SPEC-028.EvidenceApproval; @MC-SPEC-034.EvidenceApproval; @MC-ADR-002.EvidenceRefs | @MC-SPEC-014.Status; @MC-SPEC-028.Status; @MC-SPEC-034.Status; @MC-ADR-002.Status |
| WebRTC and TURN topology | MC-SPEC-023, MC-SPEC-029, MC-ADR-004 | @MC-SPEC-023.DependsOn; @MC-SPEC-029.DependsOn | @MC-SPEC-023.EvidenceApproval; @MC-SPEC-029.EvidenceApproval; @MC-ADR-004.EvidenceRefs | @MC-SPEC-023.Status; @MC-SPEC-029.Status; @MC-ADR-004.Status |
| Push topology | MC-SPEC-023, MC-SPEC-024, MC-SPEC-025, MC-SPEC-028, MC-ADR-009 | @MC-SPEC-023.DependsOn; @MC-SPEC-028.DependsOn | @MC-SPEC-023.EvidenceApproval; @MC-SPEC-028.EvidenceApproval; @MC-ADR-009.EvidenceRefs | @MC-SPEC-023.Status; @MC-SPEC-028.Status; @MC-ADR-009.Status |
| Temporary upload/artifact/audio storage | MC-SPEC-006, MC-SPEC-023, MC-SPEC-024, MC-SPEC-025, MC-SPEC-027, MC-ADR-010 | @MC-SPEC-023.DependsOn; @MC-SPEC-024.DependsOn; @MC-SPEC-027.DependsOn | @MC-SPEC-023.EvidenceApproval; @MC-SPEC-024.EvidenceApproval; @MC-SPEC-027.EvidenceApproval; @MC-ADR-010.EvidenceRefs | @MC-SPEC-023.Status; @MC-SPEC-024.Status; @MC-SPEC-027.Status; @MC-ADR-010.Status |
| Feature flags and remote configuration | MC-SPEC-005, MC-SPEC-023, MC-SPEC-034, MC-ADR-011 | @MC-SPEC-005.DependsOn; @MC-SPEC-023.DependsOn; @MC-SPEC-034.DependsOn | @MC-SPEC-005.EvidenceApproval; @MC-SPEC-023.EvidenceApproval; @MC-SPEC-034.EvidenceApproval; @MC-ADR-011.EvidenceRefs | @MC-SPEC-005.Status; @MC-SPEC-023.Status; @MC-SPEC-034.Status; @MC-ADR-011.Status |
| Visual design and brand evidence | MC-SPEC-022, MC-SPEC-031, MC-SPEC-032, MC-SPEC-033 | @MC-SPEC-022.DependsOn; @MC-SPEC-031.DependsOn; @MC-SPEC-032.DependsOn; @MC-SPEC-033.DependsOn | @MC-SPEC-022.EvidenceApproval; @MC-SPEC-031.EvidenceApproval; @MC-SPEC-032.EvidenceApproval; @MC-SPEC-033.EvidenceApproval | @MC-SPEC-022.Status; @MC-SPEC-031.Status; @MC-SPEC-032.Status; @MC-SPEC-033.Status |
| Privacy, retention, observability, and support | MC-SPEC-024, MC-SPEC-025 | @MC-SPEC-024.DependsOn; @MC-SPEC-025.DependsOn | @MC-SPEC-024.EvidenceApproval; @MC-SPEC-025.EvidenceApproval | @MC-SPEC-024.Status; @MC-SPEC-025.Status |
| Build, signing, compatibility, and release coupling | MC-SPEC-034, MC-ADR-012 | @MC-SPEC-034.DependsOn | @MC-SPEC-034.EvidenceApproval; @MC-ADR-012.EvidenceRefs | @MC-SPEC-034.Status; @MC-ADR-012.Status |
| Requirements, tests, and final sign-off | MC-SPEC-003, MC-SPEC-004, MC-SPEC-037, MC-SPEC-038 | @MC-SPEC-003.DependsOn; @MC-SPEC-004.DependsOn; @MC-SPEC-037.DependsOn; @MC-SPEC-038.DependsOn | @MC-SPEC-003.EvidenceApproval; @MC-SPEC-004.EvidenceApproval; @MC-SPEC-037.EvidenceApproval; @MC-SPEC-038.EvidenceApproval | @MC-SPEC-003.Status; @MC-SPEC-004.Status; @MC-SPEC-037.Status; @MC-SPEC-038.Status |

## 3. Closure Sequence

| Gate | Exit condition | Current status |
|---|---|---|
| Inventory | Index, conflict rules, mandatory ADRs, and dashboard exist | @MC-SPEC-001.Status; @MC-SPEC-002.Status; @MC-SPEC-040.Status |
| Repository truth | Current interfaces and identity/config terminology are verified | @MC-SPEC-005.Status; @MC-SPEC-036.Status |
| Domain | Data, auth, bridge, permission, file, and configuration semantics are reconciled | @MC-SPEC-006.Status; @MC-SPEC-007.Status; @MC-SPEC-008.Status; @MC-SPEC-020.Status; @MC-SPEC-026.Status; @MC-SPEC-027.Status; @MC-SPEC-028.Status; @MC-SPEC-031.Status; @MC-SPEC-032.Status; @MC-SPEC-033.Status |
| Protocol | State/error/API owners and all three machine-readable schemas are complete and valid | @MC-SPEC-009.Status; @MC-SPEC-010.Status; @MC-SPEC-011.Status; @MC-SPEC-012.Status; @MC-SPEC-013.Status; @MC-SPEC-014.Status; @MC-SPEC-030.Status |
| Evidence | OS, ASR, TURN, push, storage, design, privacy, observability, and support evidence is accepted | @MC-SPEC-015.Status; @MC-SPEC-016.Status; @MC-SPEC-017.Status; @MC-SPEC-018.Status; @MC-SPEC-019.Status; @MC-SPEC-021.Status; @MC-SPEC-022.Status; @MC-SPEC-023.Status; @MC-SPEC-024.Status; @MC-SPEC-025.Status; @MC-SPEC-029.Status; @MC-SPEC-034.Status; @MC-SPEC-035.Status |
| Traceability | Every requirement maps to contract, owner, test, and release gate; readiness is signed | @MC-SPEC-003.Status; @MC-SPEC-004.Status; @MC-SPEC-037.Status; @MC-SPEC-038.Status |

A later gate may reopen an earlier artifact. The canonical owner must be corrected and all dependents revalidated; the dashboard status may move backward.

### 3.1 Task 7 Evidence Checkpoint — 2026-07-12

- MC-SPEC-015/016/019 and MC-ADR-005/006/007 remain `evidence-needed`/`proposed`. macOS evidence is limited to Electron API presence with an asleep display returning 0 sources/empty thumbnails, ScreenCaptureKit typecheck, CGEvent permission `false`, and blocked signing/notarization prerequisites. Windows and Linux have no real device/VM evidence.
- MC-SPEC-017/021 and MC-ADR-008 remain `evidence-needed`/`proposed`. Official sources prove candidate API capability only; no shared corpus, real mobile device, credentials, latency, accuracy, mixed-language, privacy-deployment, cost, or battery result exists.
- MC-SPEC-022 remains `evidence-needed` and its planned visual-system document was not created. High-fidelity screens, brand-derived token proof, required state screenshots, accessibility QA, and design approval are missing.
- The evidence gate therefore remains blocked. Unverified Live, control, native, and ASR capabilities must not be advertised; the required design degradation is explicit Chat Only/text input while today's local Lily remains unchanged.

## 4. Historical Gap Disposition

The previous gap inventory is preserved here by disposition rather than repeated as parallel prose:

| Historical item | Owner | Dependency | Evidence | Status | Current disposition |
|---|---|---|---|---|---|
| Concrete repository integration | MC-SPEC-005, MC-SPEC-036, MC-ADR-001 | @MC-SPEC-005.DependsOn | @MC-SPEC-005.EvidenceApproval; @MC-ADR-001.EvidenceRefs | @MC-SPEC-005.Status; @MC-ADR-001.Status | Projection: first three closure-dashboard rows |
| Machine-readable schemas and shared validators | MC-SPEC-009, MC-SPEC-010, MC-SPEC-011, MC-SPEC-012, MC-SPEC-013, MC-SPEC-014 | @MC-SPEC-012.DependsOn; @MC-SPEC-013.DependsOn; @MC-SPEC-014.DependsOn | @MC-SPEC-012.EvidenceApproval; @MC-SPEC-013.EvidenceApproval; @MC-SPEC-014.EvidenceApproval | @MC-SPEC-012.Status; @MC-SPEC-013.Status; @MC-SPEC-014.Status | Projection: schema closure row |
| Real account/license/device model | MC-SPEC-006, MC-SPEC-007, MC-ADR-003 | @MC-SPEC-006.DependsOn; @MC-SPEC-007.DependsOn | @MC-SPEC-006.EvidenceApproval; @MC-SPEC-007.EvidenceApproval; @MC-ADR-003.EvidenceRefs | @MC-SPEC-006.Status; @MC-SPEC-007.Status; @MC-ADR-003.Status | Projection: identity/data closure row |
| Desktop OS helper design | MC-SPEC-016, MC-SPEC-018, MC-SPEC-019, MC-ADR-005, MC-ADR-006, MC-ADR-007 | @MC-SPEC-016.DependsOn; @MC-SPEC-019.DependsOn | @MC-SPEC-016.EvidenceApproval; @MC-SPEC-019.EvidenceApproval; @MC-ADR-005.EvidenceRefs; @MC-ADR-006.EvidenceRefs; @MC-ADR-007.EvidenceRefs | @MC-SPEC-016.Status; @MC-SPEC-019.Status; @MC-ADR-005.Status; @MC-ADR-006.Status; @MC-ADR-007.Status | Projection: platform-specific ADR rows |
| Voice input/ASR | MC-SPEC-017, MC-SPEC-020, MC-SPEC-021, MC-ADR-008 | @MC-SPEC-017.DependsOn; @MC-SPEC-021.DependsOn | @MC-SPEC-017.EvidenceApproval; @MC-SPEC-021.EvidenceApproval; @MC-ADR-008.EvidenceRefs | @MC-SPEC-017.Status; @MC-SPEC-021.Status; @MC-ADR-008.Status | Projection: ASR closure row |
| Brand asset pipeline | MC-SPEC-022, MC-SPEC-031, MC-SPEC-032, MC-SPEC-033 | @MC-SPEC-022.DependsOn; @MC-SPEC-033.DependsOn | @MC-SPEC-022.EvidenceApproval; @MC-SPEC-032.EvidenceApproval; @MC-SPEC-033.EvidenceApproval | @MC-SPEC-022.Status; @MC-SPEC-032.Status; @MC-SPEC-033.Status | Projection: visual-design closure row |
| Mobile build/packaging | MC-SPEC-034, MC-ADR-001, MC-ADR-002, MC-ADR-012 | @MC-SPEC-034.DependsOn | @MC-SPEC-034.EvidenceApproval; @MC-ADR-001.EvidenceRefs; @MC-ADR-002.EvidenceRefs; @MC-ADR-012.EvidenceRefs | @MC-SPEC-034.Status; @MC-ADR-001.Status; @MC-ADR-002.Status; @MC-ADR-012.Status | Projection: build/release closure row |
| Service deployment/TURN | MC-SPEC-023, MC-SPEC-024, MC-SPEC-025, MC-SPEC-029, MC-ADR-004, MC-ADR-009, MC-ADR-010 | @MC-SPEC-023.DependsOn; @MC-SPEC-024.DependsOn; @MC-SPEC-025.DependsOn; @MC-SPEC-029.DependsOn | @MC-SPEC-023.EvidenceApproval; @MC-SPEC-024.EvidenceApproval; @MC-SPEC-025.EvidenceApproval; @MC-SPEC-029.EvidenceApproval; @MC-ADR-004.EvidenceRefs; @MC-ADR-009.EvidenceRefs; @MC-ADR-010.EvidenceRefs | @MC-SPEC-023.Status; @MC-SPEC-024.Status; @MC-SPEC-025.Status; @MC-SPEC-029.Status; @MC-ADR-004.Status; @MC-ADR-009.Status; @MC-ADR-010.Status | Projection: infrastructure closure rows |
| UI visual tokens | MC-SPEC-022, MC-SPEC-031, MC-SPEC-032, MC-SPEC-033 | @MC-SPEC-022.DependsOn; @MC-SPEC-031.DependsOn | @MC-SPEC-022.EvidenceApproval; @MC-SPEC-031.EvidenceApproval | @MC-SPEC-022.Status; @MC-SPEC-031.Status | Projection: visual-design closure row |
| Full acceptance tests | MC-SPEC-003, MC-SPEC-004, MC-SPEC-037, MC-SPEC-038 | @MC-SPEC-003.DependsOn; @MC-SPEC-004.DependsOn | @MC-SPEC-003.EvidenceApproval; @MC-SPEC-004.EvidenceApproval; @MC-SPEC-037.EvidenceApproval; @MC-SPEC-038.EvidenceApproval | @MC-SPEC-003.Status; @MC-SPEC-004.Status; @MC-SPEC-037.Status; @MC-SPEC-038.Status | Projection: traceability/readiness closure row |
| Offline drafts, i18n copy, telemetry, privacy, admin/support diagnostics | MC-SPEC-010, MC-SPEC-011, MC-SPEC-024, MC-SPEC-025, MC-SPEC-031 | @MC-SPEC-010.DependsOn; @MC-SPEC-011.DependsOn; @MC-SPEC-024.DependsOn; @MC-SPEC-025.DependsOn; @MC-SPEC-031.DependsOn | @MC-SPEC-010.EvidenceApproval; @MC-SPEC-011.EvidenceApproval; @MC-SPEC-024.EvidenceApproval; @MC-SPEC-025.EvidenceApproval; @MC-SPEC-031.EvidenceApproval | @MC-SPEC-010.Status; @MC-SPEC-011.Status; @MC-SPEC-024.Status; @MC-SPEC-025.Status; @MC-SPEC-031.Status | Projection: domain/privacy/support rows |

This disposition preserves the historical concerns while removing duplicate ownership and stale “next document” lists.

### Task 8 evidence blockers recorded 2026-07-12

- MC-SPEC-023 is `evidence-needed`: the verified production shape is a China stateful origin plus Singapore UAE-policy edge proxy. TURN (Twilio/coturn), APNs/FCM, and Qiniu/Alibaba temporary-storage options remain candidates. Missing Lily accounts/configuration, regional availability, representative load/failure tests, secret rotation, deletion proof, dated quotes/budgets and rollback drills are **BLOCKED** artifacts.
- MC-SPEC-024 is `evidence-needed`: exact retention/backup/legal-hold schedules, purge implementation, deletion/restore proof, consent/store copy, data-subject workflows and China/Singapore/UAE cross-border approvals are **BLOCKED**.
- MC-SPEC-025 is `evidence-needed`: telemetry schema enforcement, redaction/cardinality budgets, measured SLO/alert thresholds, dashboards, routing drills, diagnostics package/private store, support RBAC/expiry/audit and cost evidence are **BLOCKED**.
- MC-ADR-004, MC-ADR-009 and MC-ADR-010 remain `proposed`. No provider or threshold may be inferred from candidate documentation; production enablement stays blocked while Chat Only/current desktop behavior remains the capability-gate fallback.

## 5. Definition Of Specification Closure

The specification is closed only when:

- every blocking artifact in MC-SPEC-001 through MC-SPEC-038 plus MC-SPEC-040 is `accepted`; MC-SPEC-039 remains explicitly `superseded` and non-blocking;
- every mandatory MC-ADR record is accepted with evidence, owner, and date;
- machine-readable schemas validate and cover every API-matrix operation;
- every lifecycle/error has explicit recovery, revocation, and capability-gate classification;
- platform, vendor, infrastructure, privacy, operations, and visual evidence is recorded and approved;
- every requirement maps to its canonical contract, planned repository owner, automated/manual verification, and release gate;
- the final ambiguity and link scans pass; and
- the readiness checklist is signed for product, engineering, security, design, and operations.

Until then, implementation agents must not infer missing product or architecture decisions.
