# Lily Mobile Command Pro Specification Closure Dashboard

## 1. Current Gate

Status: **not build-ready**. The existing set supports architecture review, but production implementation remains unauthorized. The canonical artifact states are in the [specification index](mobile-command-spec-index.md); unresolved alternatives are in the [decision log](mobile-command-decision-log.md).

This dashboard reports closure work, not product implementation work. Generated code, CI jobs, native helpers, deployed infrastructure, and production routes belong to a later implementation plan unless evidence gathering explicitly requires a disposable prototype.

## 2. Closure Dashboard

| Gap | Owner artifact | Depends on | Evidence required to close | Status |
|---|---|---|---|---|
| Repository integration and mobile app boundary | MC-SPEC-005, MC-SPEC-036; MC-ADR-001 | Inventory gate | Verified exports, callers, route/table/config owners, build/deploy conventions, and corrected implementation map | evidence-needed |
| Identity, licensing, authentication, and persisted data | MC-SPEC-006–007, MC-SPEC-026; MC-ADR-003 | MC-SPEC-005 | Current schema/identity audit, final mappings, constraints, credential lifecycle, retention, and security review | evidence-needed |
| Agent bridge and existing conversation behavior | MC-SPEC-008; related protocol rows in MC-SPEC-009–011 | MC-SPEC-005, MC-SPEC-007 | Verified session/turn/event/artifact/file seams, concurrency and fail-open behavior | evidence-needed |
| Complete lifecycle, error, and API inventory | MC-SPEC-009–011 | MC-SPEC-006–008 | One canonical state/error set and every user flow mapped to every transport/native operation | draft |
| Machine-readable HTTP, event, and native boundaries | MC-SPEC-012–014 | MC-SPEC-006–011; MC-ADR-002 | Valid OpenAPI/JSON Schema, complete matrix coverage, negative validation cases, prose reconciliation | draft |
| Windows capture and input | MC-SPEC-016, MC-SPEC-019; MC-ADR-005 | MC-SPEC-005, MC-SPEC-018 | Real-device spike for capture/input, DPI, bounds, permissions, IPC, signing, packaging, crash recovery | evidence-needed |
| macOS capture and input | MC-SPEC-016, MC-SPEC-019; MC-ADR-006 | MC-SPEC-005, MC-SPEC-018 | Real-device spike for Screen Recording/Accessibility, bounds, IPC, signing, notarization, recovery | evidence-needed |
| Linux support/degradation | MC-SPEC-015–016, MC-SPEC-019; MC-ADR-007 | MC-SPEC-005, MC-SPEC-018 | Wayland/X11/portal evidence and explicit observe/control/Chat Only support decision | evidence-needed |
| ASR provider and privacy path | MC-SPEC-017, MC-SPEC-020–021; MC-ADR-008 | Identity, error, privacy, and config contracts | Measured latency/accuracy/battery/cost, credential model, retention path, and reviewed privacy copy | evidence-needed |
| Native shell and Capacitor boundary | MC-SPEC-014, MC-SPEC-028, MC-SPEC-034; MC-ADR-002 | MC-ADR-001; platform evidence | Technology proof, bridge validation, web-only degradation, signing/build evidence | evidence-needed |
| WebRTC and TURN topology | MC-SPEC-023, MC-SPEC-029; MC-ADR-004 | Identity, protocol, platform, and operations contracts | Provider/topology selection, credential issuer, regions, load/cost tests, failure and DR proof | evidence-needed |
| Push topology | MC-SPEC-023–025, MC-SPEC-028; MC-ADR-009 | Identity, native, privacy, and operations contracts | Provider credentials, token lifecycle, outage behavior, notification privacy, operational review | evidence-needed |
| Temporary upload/artifact/audio storage | MC-SPEC-006, MC-SPEC-023–027; MC-ADR-010 | Data, file, voice, privacy, and operations contracts | Storage topology, encryption, signed access, scanning, quotas, TTL/deletion proof, backup/cost policy | evidence-needed |
| Feature flags and remote configuration | MC-SPEC-005, MC-SPEC-023, MC-SPEC-034; MC-ADR-011 | Repository audit and release topology | Current config mapping, precedence/scopes, cache/expiry, kill switch, fail-open/fail-safe tests | evidence-needed |
| Visual design and brand evidence | MC-SPEC-022, MC-SPEC-031–033 | Product states and platform matrix | Desktop-derived tokens, safe areas, dark mode, touch/motion/waveform specs, reference renders, design approval | evidence-needed |
| Privacy, retention, observability, and support | MC-SPEC-024–025 | All data/transport/platform contracts | Data inventory, prohibited fields, deletion/consent copy, telemetry schema, alerts, diagnostics, support review | evidence-needed |
| Build, signing, compatibility, and release coupling | MC-SPEC-034; MC-ADR-012 | MC-ADR-001–002, MC-ADR-004–011 | Verified CI/deploy/store constraints, compatibility window, rollout/rollback and mixed-version evidence | evidence-needed |
| Requirements, tests, and final sign-off | MC-SPEC-003–004, MC-SPEC-037–038 | All canonical contracts and decisions | Complete requirement mappings, deterministic validation, platform/manual QA IDs, cross-functional approval | draft |

## 3. Closure Sequence

| Gate | Exit condition | Current status |
|---|---|---|
| Inventory | Index, conflict rules, mandatory ADRs, and dashboard exist | review-ready |
| Repository truth | Current interfaces and identity/config terminology are verified | evidence-needed |
| Domain | Data, auth, bridge, permission, file, and configuration semantics are reconciled | draft |
| Protocol | State/error/API owners and all three machine-readable schemas are complete and valid | draft |
| Evidence | OS, ASR, TURN, push, storage, design, privacy, observability, and support evidence is accepted | evidence-needed |
| Traceability | Every requirement maps to contract, owner, test, and release gate; readiness is signed | draft |

A later gate may reopen an earlier artifact. The canonical owner must be corrected and all dependents revalidated; the dashboard status may move backward.

## 4. Historical Gap Disposition

The previous gap inventory is preserved here by disposition rather than repeated as parallel prose:

| Historical item | Current disposition |
|---|---|
| Concrete repository integration | Consolidated into the first three dashboard rows and MC-ADR-001/003 |
| Machine-readable schemas and shared validators | Consolidated into lifecycle/API and schema rows; production type generation is post-freeze implementation |
| Real account/license/device model | Consolidated into identity/data row and MC-ADR-003 |
| Desktop OS helper design | Split by Windows/macOS/Linux evidence in MC-ADR-005–007 |
| Voice input/ASR | Consolidated into ASR row and MC-ADR-008; the voice UX contract remains a dependency |
| Brand asset pipeline | Spec closure now tracks visual/design evidence; generation script/assets are later implementation outputs |
| Mobile build/packaging | Consolidated into app boundary, native shell, and release-coupling rows |
| Service deployment/TURN | Consolidated into WebRTC/TURN, push, storage, privacy, and operations rows |
| UI visual tokens | Consolidated into visual design/brand evidence row |
| Full acceptance tests | Consolidated into requirements/tests/sign-off row |
| Offline drafts, i18n copy, telemetry, privacy, admin/support diagnostics | Assigned to state/error, UI, privacy, observability, and support canonical artifacts |

This disposition preserves the historical concerns while removing duplicate ownership and stale “next document” lists.

## 5. Definition Of Specification Closure

The specification is closed only when:

- every required artifact in MC-SPEC-001 through MC-SPEC-040 is `accepted` or explicitly `superseded` by an accepted owner;
- every mandatory MC-ADR record is accepted with evidence, owner, and date;
- machine-readable schemas validate and cover every API-matrix operation;
- every lifecycle/error has explicit recovery, revocation, and capability-gate classification;
- platform, vendor, infrastructure, privacy, operations, and visual evidence is recorded and approved;
- every requirement maps to its canonical contract, planned repository owner, automated/manual verification, and release gate;
- the final ambiguity and link scans pass; and
- the readiness checklist is signed for product, engineering, security, design, and operations.

Until then, implementation agents must not infer missing product or architecture decisions.
