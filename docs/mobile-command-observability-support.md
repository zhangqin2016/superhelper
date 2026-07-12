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

### 3.1 Infrastructure Metrics Allowlist

Infrastructure metrics are a separate server/provider-derived contract; they are not client telemetry events and do not expand the event allowlist above. Every metric must declare `metricName`, type/unit, collector, source, collection interval, allowed labels, retention/aggregation, owner and schema version. Collection and export remain subject to MC-SPEC-024 prohibitions and regional/access approval.

| Metric | Type/unit | Collector and source | Allowed labels |
|---|---|---|---|
| `mobile_temp_object_deletion_lag_seconds` | histogram, seconds | lifecycle verifier from private storage inventory/deletion receipts | `environment`, `region`, `storageClass`, `result` |
| `mobile_turn_relay_bytes_total` | counter, bytes | TURN service/provider aggregate | `environment`, `region`, `transport`, `direction` |
| `mobile_turn_sessions` | gauge, sessions | TURN service/provider aggregate | `environment`, `region`, `transport`, `state` |
| `mobile_turn_relay_ratio` | gauge, bounded ratio | metrics processor from aggregate relayed/connected session counters | `environment`, `region`, `networkClass` |
| `mobile_temp_storage_bytes` | gauge, bytes | private bucket inventory | `environment`, `region`, `storageClass` |
| `mobile_temp_storage_objects` | gauge, objects | private bucket inventory | `environment`, `region`, `storageClass`, `lifecycleState` |
| `mobile_temp_storage_growth_bytes` | gauge, bytes per accepted interval | metrics processor from bucket inventory deltas | `environment`, `region`, `storageClass` |
| `mobile_telemetry_events_sent_total` | counter, events | telemetry gateway aggregate | `environment`, `region`, `eventName`, `result` |
| `mobile_telemetry_events_dropped_total` | counter, events | client/server schema and ingestion aggregate | `environment`, `region`, `eventName`, `dropReason` |
| `mobile_telemetry_ingestion_lag_seconds` | histogram, seconds | ingestion pipeline from accepted/processed timestamps | `environment`, `region`, `eventName` |
| `mobile_cost_estimate_currency` | gauge, configured billing currency | cost processor from aggregate usage and dated price sheet | `environment`, `region`, `costCategory`, `currency` |
| `mobile_cost_budget_currency` | gauge, configured billing currency | approved budget configuration | `environment`, `region`, `costCategory`, `currency` |

Label values must be bounded enums from a versioned schema. Metrics must never carry account/user/device/session/correlation IDs, raw IP or endpoint, provider tenant/internal host, object key/name/URL, file/task/message content, SDP/ICE bodies, secrets, arbitrary errors or free-form labels. Provider identity may exist only as a bounded internal inventory field when operationally required and approved; it is not a public status field. Per-series cardinality budgets, scrape/export interval, raw retention, aggregation/downsampling and deletion are **BLOCKED** pending backend capacity/cost testing and privacy approval. Dashboards and alerts must use these metrics rather than synthesizing unlisted client events.

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

- P0: any proven authorization bypass, revoked-device control, secret exposure, prohibited-content telemetry, or kill switch that fails to apply, fails to propagate, evaluates enabled when denial is required, or otherwise leaves a sensitive capability usable (authority-side fail-open);
- P1: sustained regional inability to pair/signal/connect/upload, deletion backlog beyond approved SLA, signing/credential failures, or uncontrolled TURN/storage cost;
- P2: degraded single-platform/provider path with Chat Only/local Lily intact.

A kill switch that correctly disables sensitive authority is the required fail-safe behavior, not an incident. Its resulting loss of Mobile Command availability may be recorded and triaged as an availability degradation according to measured customer impact, while Chat Only/current local Lily remains available. Alert logic must test effective authority at the consuming service/client boundary; observing a configuration write alone does not prove propagation or containment.

Until measured thresholds and routing tests exist, production enablement is **BLOCKED**; “alert configured” without a fired-and-acknowledged drill is insufficient.

## 5. Dashboards And Trace Correlation

Required views: regional session funnel; signaling/WebRTC connectivity; P2P versus TURN and bandwidth/cost; upload lifecycle/storage/deletion; permission/revocation security; push by platform/environment; kill-switch propagation; error catalog; app/protocol compatibility; telemetry health.

Correlation joins only through the short-lived `correlationId` and bounded pseudonyms. A support search must not accept raw email, phone, content, object URL, or file name as a telemetry query. Dashboard data source, queries, refresh, owner, RBAC, retention and screenshots are **BLOCKED** artifacts.

## 6. Customer-Visible Status

Customer-visible status is a separate, human-approved projection of confirmed incidents. Status-page and client advisories may expose only:

```text
service, region, capability,
phase, impact, fallback,
startedAt, updatedAt, resolvedAt, incidentId
```

The schema uses stable codes:

- `phase`: `investigating | identified | monitoring | resolved`;
- `impact`: `unavailable | partial | degraded | none`;
- `fallback`: `chat_only | observe_only | local_desktop_only | none`.

`service`, `region`, and `capability` also come from bounded, versioned public enums; `incidentId` is an opaque public case ID. UI and status-page prose is localized from these stable codes and is not part of the payload. The public schema rejects free-text title, summary, message, cause, workaround, provider, or error fields. Public output must not contain user/account/device/session/correlation IDs, IP/network endpoints, provider names/tenants/internal topology, error bodies, metrics labels, secrets, or content.

`phase = resolved` requires `impact = none`, `fallback = none`, a non-null `resolvedAt`, and effective recovery observed at the consuming boundary. Non-resolved records require `resolvedAt = null`. `impact = partial` or `impact = degraded` requires `fallback != none`; the fallback code states the actually safe remaining surface, not a proposed workaround. `impact = none` is valid only for `phase = resolved`. `fallback = none` on an active incident is permitted only when the capability is `unavailable` and no safe Mobile Command fallback exists; current local Lily behavior still must not be weakened. Region is published only at the approved customer-facing granularity, and recovery removes stale client advisory state.

Trigger contract: a confirmed P0 customer-impacting incident requires a status-page and in-app advisory; a P1 publishes when the accepted impact/duration matrix says customers must act or a regional capability is materially degraded; a P2 remains internal unless the accepted matrix requires an in-app advisory for a known platform/capability cohort. Security detail may be withheld, but the safe capability impact and fallback cannot be misstated. These are publication classes, not numeric thresholds; the exact confirmation, duration and audience rules remain evidence-gated below.

Triggering and update cadence are **UNVERIFIED**. Required acceptance artifacts: incident-severity-to-publication matrix; measured detection/confirmation rule; maximum initial/update/resolution intervals; named incident commander and communications approver; status-page schema/screenshots; regional and partial-degradation tests; recovery verification; audit trail. Each open incident must be updated at the accepted cadence even when there is no material change, then receive a recovery/`resolved` update after boundary verification. Automation may draft but cannot publish or resolve an incident without recorded human approval, except a separately approved emergency template that still records approver/authority and post-review.

The same allowlisted projection must be localized in approved zh-CN/en copy, meet accessible semantic/contrast/screen-reader requirements, and remain consistent across status page, in-app advisory and push. Push contains only opaque advisory intent under MC-SPEC-024; clients fetch the approved status projection. If push fails, in-app polling/reconnect fetches status; if the status service fails, the client shows a bounded generic availability notice and preserves Chat Only/current local Lily without guessing provider or cause.

## 7. Diagnostics Package

The package is generated locally after explicit consent and contains a signed manifest plus allowlisted JSON records:

```text
manifestVersion, createdAt, expiresAt, app/platform/protocol versions,
region/config-version and kill-switch states, correlation IDs,
canonical error codes, bucketed WebRTC/network counters,
schema-validation results, packageIntegrityDigests and redaction report
```

`packageIntegrityDigests` may contain only integrity digests of the generated diagnostics archive and its allowlisted diagnostic record blobs. It must never hash or identify user uploads, Lily artifacts, desktop paths, file bodies, message/task content, screen/audio/clipboard data, or other prohibited content; a content hash is still derived personal/sensitive data when it fingerprints forbidden input. MC-SPEC-024 owns that prohibition and retention/deletion treatment.

The package must exclude all content prohibited by MC-SPEC-024, secrets, raw IPs, precise timestamps unnecessary for correlation, full environment dumps, arbitrary logs, database rows, crash dumps and unrestricted stack traces. The UI must preview categories and expiry before upload. Upload uses the accepted private support store, is case-bound, least-privilege, audited and deleted on case closure/expiry.

Implementation, signing key/audience, package size, TTL and support storage are **BLOCKED**. Required artifacts: JSON schema; golden/redaction/adversarial tests; consent/preview screenshots; signature verification; private bucket/RBAC; access audit; expiry/deletion drill.

## 8. Support Access Workflow

1. User opens a case and explicitly authorizes specified diagnostic categories and duration.
2. System issues a case-bound, read-only grant to an assigned support role; no shared account.
3. Strong authentication and approval are required for production access; support cannot access screen/input/clipboard/audio/file content.
4. Every view/download/export records operator, case, purpose, fields, timestamp and outcome.
5. Grant expires automatically and is revoked on user request, case closure, role removal or incident.
6. Security/privacy escalation is mandatory for suspected authorization bypass, secret/prohibited-data exposure, cross-border violation or deletion failure.

RBAC roles, identity provider, approval path, maximum access duration, audit retention and on-call roster are **UNVERIFIED**. Required artifacts: role/policy export, joiner-mover-leaver test, approval and expiry test, access-log sample, quarterly review owner, incident drill, privacy/security sign-off.

## 9. Acceptance Gate

MC-SPEC-025 remains `evidence-needed` until schemas enforce the event and infrastructure-metric allowlists/redaction/cardinality rules; SLOs and alerts are based on measured data and drilled routes; dashboards and telemetry retention are approved; customer-visible status publication/recovery is accessible, localized and human-approved; diagnostics pass adversarial privacy tests; support access is time-bound/audited; and cost/capacity evidence is attached. This document does not assert implementation.
