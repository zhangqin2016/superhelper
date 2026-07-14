# Lily Mobile Command Pro Release Readiness Checklist

## 1. Gate Semantics

This document is the sole authorization record for production release. A gate is `PASS` only when every required item is evidenced; an unrun, unapproved, or externally blocked item is `BLOCKED`, never implicitly passed. Specification coverage is not implementation evidence. The Phase 1 web demo core is separately tracked in [Mobile Command Current Demo Status](mobile-command-current-demo-status.md).

## 2. Specification Freeze — BLOCKED

| Gate | Requirement | Required evidence | Current evidence | Result |
|---|---|---|---|---|
| SF-01 | All mandatory decisions accepted | Every mandatory ADR accepted with owner/date | MC-ADR-001, 002, 004–010, 012 remain proposed | BLOCKED |
| SF-02 | Repository seams verified | MC-SPEC-005/036 accepted; exact current owners and callers | Repository audit exists, but dependent artifacts and owner approvals are not accepted | BLOCKED |
| SF-03 | Machine schemas complete and linked | OpenAPI/events/native schemas validate; every operation resolves | Task 6 schemas exist; final closure validation and acceptance are pending | BLOCKED |
| SF-04 | State, error, authority and recovery coverage complete | All normative rows mapped; no unexplained gap | Traceability mapping exists, but security/owner review and closure guard are pending | BLOCKED |
| SF-05 | Zero traceability gaps | Unique IDs, exact columns, bidirectional sampling, zero blocked rows | Sampling is recorded; blocked rows remain for external evidence | BLOCKED |
| SF-06 | Platform/provider/design/build choices evidence-backed | MC-ADR-001/002/004–010/012 accepted; MC-SPEC-015–023/029/034 accepted | MC-ADR-005–010 are explicitly unresolved; Windows/Linux/mobile device, TURN, ASR, push, storage, visual and signed-build evidence is absent | BLOCKED |
| SF-07 | Privacy, threat, observability and operations accepted | Security/privacy/legal/ops approvals; retention, deletion, telemetry and diagnostics proof | MC-SPEC-024–026/035 not accepted; legal, pipeline, deletion and drill evidence absent | BLOCKED |
| SF-08 | Ambiguity/link/closure validation passes | Task 10 closure test and Task 11 final-freeze review | Tasks 10–11 have not run | BLOCKED |

Specification Freeze result: **BLOCKED**. Production implementation is not authorized by this document.

## 3. Production Release — BLOCKED

Production Release cannot pass while Specification Freeze is blocked.

| Gate | Requirement | Required evidence | Current evidence | Result |
|---|---|---|---|---|
| PR-01 | Reproducible signed builds and accepted release coupling | iOS/Android/desktop/server/web artifacts, provenance, notarization/signing, store-lag and rollback policy | Phase 1 web demo code exists, but no production signed artifacts or release coupling evidence; MC-ADR-001/002/012 proposed | BLOCKED |
| PR-02 | Command/pairing/bridge implementation tests | Unit, integration, contract and E2E suites mapped to MC-TC IDs | Phase 1 demo has automated pairing/relay/bridge/admission/attachment checks; full production MC-TC mapping, native/live/control coverage, and owner approval remain absent | BLOCKED |
| PR-03 | Security, replay, revocation and approval race tests | Automated adversarial tests plus security approval | Phase 1 demo covers selected grant isolation, re-scan, idempotency, and revoke refusal; full adversarial/security approval is absent | BLOCKED |
| PR-04 | Integrity, idempotency, malformed/forged/oversized tests | Full automated negative suite and artifact logs | Phase 1 demo covers selected command idempotency and bounded attachment materialization; full production negative suite and artifact logs are absent | BLOCKED |
| PR-05 | Reconnect, relay loss, version skew and local preservation | Chaos/network matrix with durable replay and local-baseline assertions | Phase 1 demo has local fail-open behavior for selected bridge failures; no production chaos/network/version-skew matrix | BLOCKED |
| PR-06 | TURN capacity and live-session reliability | Regional relay credentials, load/abuse/cost results and SLO approval | MC-ADR-004 proposed; provider/load evidence absent | BLOCKED |
| PR-07 | Representative platform QA | Every advertised Windows/macOS/Linux × iOS/Android/PWA pair, permissions, background, accessibility and visual QA | MC-ADR-005–009 proposed; platform matrix unverified/blocked; visual artifact absent | BLOCKED |
| PR-08 | Monitoring, privacy, retention and support readiness | Dashboards/alerts, redaction tests, consent/legal approvals, deletion/export drill, support RBAC | Observability/status/diagnostics JSON schema and sensitive-field rejection tests exist; deployed pipeline/legal/provider/deletion/support evidence remains absent | BLOCKED |
| PR-09 | Staged kill switches and rollback rehearsal | Server/desktop/mobile flags exercised in canary and rollback drill | Demo capability flags and HTTP route-boundary fail-closed tests exist; production remote-config propagation, canary, rollback, and rehearsal evidence remain absent | BLOCKED |

Production Release result: **BLOCKED**. No checklist item is waived and none is `PASS`.

## 4. Evidence Required To Change A Result

Changing `BLOCKED` requires a repository artifact or external evidence ID, responsible approver, ISO date, and a link from the controlling ADR/spec row. A prose assertion, planned test name, candidate vendor document, or fallback design does not count as production evidence.
