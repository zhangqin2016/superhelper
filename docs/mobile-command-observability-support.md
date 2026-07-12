# Lily Mobile Command Pro Observability And Support Evidence

## 1. Status

- Spec: MC-SPEC-025
- Status: **evidence-needed**
- Evidence date: 2026-07-12
- Approval: **BLOCKED**; no Mobile Command telemetry pipeline, dashboards, alerts, diagnostics package, support workflow, or measured SLO is proven deployed.

This document defines the allowed contract and evidence gate. The ops runbook owns incident actions.

## 2. Telemetry Envelope And Event Allowlist

Every accepted event must use a versioned schema and reject unknown fields:

```text
eventName, schemaVersion, occurredAt, environment, region,
appPlatform, appVersion, protocolVersion, correlationId,
resultCode, durationBucket, count
```

`correlationId` is random and short-lived; account/device/session identifiers must be rotating pseudonyms scoped to the minimum diagnostic window. Free-form messages, URLs, headers, provider responses, stack traces, object names, and user/agent content are not envelope fields.

Allowed event names:

| Event | Extra allowlisted fields |
|---|---|
| `mobile.pairing.completed` | `resultCode`, `durationBucket` |
| `mobile.remote_session.transition` | `fromState`, `toState`, `sourceMode`, `resultCode` |
| `mobile.signaling.connection` | `transport`, `attemptBucket`, `resultCode`, `durationBucket` |
| `mobile.webrtc.connection` | `connectionMode` (`p2p/turn/failed`), `rttBucket`, `lossBucket`, `reconnectBucket`, `resultCode` |
| `mobile.permission.decision` | `permissionKind`, `decision`, `resultCode` |
| `mobile.upload.transition` | `fromState`, `toState`, `sizeBucket`, `riskBucket`, `resultCode` |
| `mobile.push.delivery` | `platform`, `environment`, `resultCode`, `durationBucket` |
| `mobile.device.revocation` | `resultCode`, `activeSessionBucket` |
| `mobile.kill_switch.evaluated` | `switchName`, `effectiveState`, `configAgeBucket`, `resultCode` |
| `mobile.diagnostics.created` | `manifestVersion`, `uploadConsent`, `resultCode` |

Anything not listed is prohibited until schema, privacy review, retention and cardinality budget are approved.

## 3. Redaction And Cardinality

Redact/drop before serialization, again at ingestion, and before support export. Drop keys matching secret/token/auth/cookie/key/url/path/content/text/audio/frame/clipboard/file-name patterns; reject payloads above the accepted schema bound. Hashing forbidden content does not make it allowed.

Bounded enums and numeric buckets are required. Never label metrics by raw account, device, session, correlation ID, IP, error message, user agent, file name, model text, object key, or URL. Pseudonymous IDs may exist only in access-controlled trace/event stores, never metric labels.

Cardinality budgets, sampling rates, payload byte limit, pseudonym rotation and raw-event TTL are **UNVERIFIED**. Required artifacts: representative traffic model; backend-specific series/event estimate; load/cost test; schema rejection/redaction tests; approved budgets per event/label; sampled-event correctness proof; privacy approval.

## 4. SLIs, SLOs, And Alerts

Required SLIs:

- pairing and remote-session authorization success;
- signaling connect success and duration;
- WebRTC P2P/relay connect success, setup duration, reconnect exhaustion;
- permission bypass/revocation correctness;
- upload verify/stage success and duration;
- push acceptance/delivery where provider receipts permit;
- temp-object lifecycle/deletion lag;
- kill-switch/config propagation and age;
- TURN bandwidth, storage growth, telemetry ingestion loss and monthly cost.

All numeric SLOs and alert thresholds are **UNVERIFIED**; draft numbers elsewhere are test hypotheses, not operational promises. Each threshold requires: 28-day or representative preproduction baseline, numerator/denominator query, exclusions, region/platform split, burn-rate/error-budget method, minimum sample size, alert owner/route, synthetic probe, false-positive review, and approved customer impact classification.

Mandatory alert classes without invented thresholds:

- P0: any proven authorization bypass, revoked-device control, secret exposure, prohibited-content telemetry, or kill switch failing closed for sensitive capability;
- P1: sustained regional inability to pair/signal/connect/upload, deletion backlog beyond approved SLA, signing/credential failures, or uncontrolled TURN/storage cost;
- P2: degraded single-platform/provider path with Chat Only/local Lily intact.

Until measured thresholds and routing tests exist, production enablement is **BLOCKED**; “alert configured” without a fired-and-acknowledged drill is insufficient.

## 5. Dashboards And Trace Correlation

Required views: regional session funnel; signaling/WebRTC connectivity; P2P versus TURN and bandwidth/cost; upload lifecycle/storage/deletion; permission/revocation security; push by platform/environment; kill-switch propagation; error catalog; app/protocol compatibility; telemetry health.

Correlation joins only through the short-lived `correlationId` and bounded pseudonyms. A support search must not accept raw email, phone, content, object URL, or file name as a telemetry query. Dashboard data source, queries, refresh, owner, RBAC, retention and screenshots are **BLOCKED** artifacts.

## 6. Diagnostics Package

The package is generated locally after explicit consent and contains a signed manifest plus allowlisted JSON records:

```text
manifestVersion, createdAt, expiresAt, app/platform/protocol versions,
region/config-version and kill-switch states, correlation IDs,
canonical error codes, bucketed WebRTC/network counters,
schema-validation results, file hashes and redaction report
```

It must exclude all content prohibited by MC-SPEC-024, secrets, raw IPs, precise timestamps unnecessary for correlation, full environment dumps, arbitrary logs, database rows, crash dumps and unrestricted stack traces. The UI must preview categories and expiry before upload. Upload uses the accepted private support store, is case-bound, least-privilege, audited and deleted on case closure/expiry.

Implementation, signing key/audience, package size, TTL and support storage are **BLOCKED**. Required artifacts: JSON schema; golden/redaction/adversarial tests; consent/preview screenshots; signature verification; private bucket/RBAC; access audit; expiry/deletion drill.

## 7. Support Access Workflow

1. User opens a case and explicitly authorizes specified diagnostic categories and duration.
2. System issues a case-bound, read-only grant to an assigned support role; no shared account.
3. Strong authentication and approval are required for production access; support cannot access screen/input/clipboard/audio/file content.
4. Every view/download/export records operator, case, purpose, fields, timestamp and outcome.
5. Grant expires automatically and is revoked on user request, case closure, role removal or incident.
6. Security/privacy escalation is mandatory for suspected authorization bypass, secret/prohibited-data exposure, cross-border violation or deletion failure.

RBAC roles, identity provider, approval path, maximum access duration, audit retention and on-call roster are **UNVERIFIED**. Required artifacts: role/policy export, joiner-mover-leaver test, approval and expiry test, access-log sample, quarterly review owner, incident drill, privacy/security sign-off.

## 8. Acceptance Gate

MC-SPEC-025 remains `evidence-needed` until schemas enforce the allowlist/redaction/cardinality rules; SLOs and alerts are based on measured data and drilled routes; dashboards and telemetry retention are approved; diagnostics pass adversarial privacy tests; support access is time-bound/audited; and cost/capacity evidence is attached. This document does not assert implementation.
