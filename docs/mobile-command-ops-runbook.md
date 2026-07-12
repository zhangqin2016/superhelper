# Lily Mobile Command Pro Ops Runbook

## 1. Purpose

This document defines operational requirements for Mobile Command Pro: service deployment, TURN, temporary storage, monitoring, alerting, abuse controls, incident response, and cost guardrails.

Canonical facts and gates live in [infrastructure deployment](mobile-command-infrastructure-deployment.md), [privacy/retention/compliance](mobile-command-privacy-retention-compliance.md), and [observability/support](mobile-command-observability-support.md). All three are `evidence-needed`; this runbook is procedural and does not claim any service, threshold, alert, or kill switch is implemented.

## 2. Services

Required server capabilities:

- mobile pairing
- mobile devices
- remote sessions
- signaling WebSocket
- TURN credential issuer
- temporary upload storage
- remote audit summary
- push notification dispatch

## 3. TURN Operations

Provider selection is **BLOCKED** under MC-ADR-004. Twilio and coturn are candidates only; use of either requires the account/region/configuration, load, abuse, privacy and quote artifacts in MC-SPEC-023.

Options:

- managed TURN provider
- self-hosted coturn

Self-hosted coturn requirements:

- TLS support
- UDP and TCP listeners
- region close to users
- short-lived credentials
- bandwidth metrics
- abuse throttling

Credential rules:

- max TTL 30 minutes
- bound to account/session
- refresh before expiry
- revoke by ending remote session

## 4. Temporary Storage

Provider selection is **BLOCKED** under MC-ADR-010. Do not use the current public Qiniu release/feedback bucket for Mobile Command content. Only a dedicated private, region-approved bucket that passes MC-SPEC-023/024 deletion evidence may be enabled.

Used for:

- mobile upload chunks
- desktop artifact transfer
- temporary audio fallback for ASR

Requirements:

- opaque object keys
- short TTL
- server-side size limits
- lifecycle cleanup
- no raw desktop paths
- no permanent storage unless explicit product feature

## 5. Monitoring

Metrics:

- pairing success/failure
- remote session starts/ends
- WebSocket reconnects
- WebRTC connect success
- TURN usage rate
- TURN bandwidth
- upload success/failure
- approval grant/deny
- permission denied counts
- device revocation counts
- error code counts

No content telemetry:

- no screen frames
- no typed text
- no clipboard content
- no file body
- no transcript content by default

## 6. Alerts

The classifications below describe escalation intent. Numeric trigger thresholds are **UNVERIFIED** until MC-SPEC-025 baseline, query, routing and drill artifacts are accepted.

P0 alerts:

- suspicious permission bypass signal
- spike in unauthorized input attempts
- TURN bandwidth runaway
- upload storage runaway
- signing verification failures spike
- device revocation failures

P1 alerts:

- WebRTC connect success below threshold
- upload failure rate spike
- signaling error spike
- push delivery failure spike

## 7. Rate Limits

Default limits:

| Action | Limit |
|---|---:|
| pairing start | 10 / hour / desktop |
| pairing consume | 20 / hour / account |
| remote session create | 60 / hour / account |
| permission request | 30 / hour / session |
| signaling messages | bounded per session |
| upload create | 100 / day / device |
| upload bandwidth | account quota |
| TURN bandwidth | account/session quota |

Exceeded limits return `SERVER_RATE_LIMITED`.

## 8. Abuse Controls

- revoke suspicious mobile device
- kill active remote sessions for account
- disable Desktop Control per account
- force relay-only or disable TURN for abusive sessions
- require re-pairing after anomaly
- block repeated failed signatures

## 9. Incident Response

The actions below are required operator intent, not proof the referenced controls exist. Before production rollout, every command, audience, propagation time, audit result and baseline-fallback test must be recorded.

### 9.1 Remote Control Risk

If unauthorized control is suspected:

1. Disable `desktopControlEnabled`.
2. Revoke active remote sessions.
3. Preserve audit summaries.
4. Rotate affected TURN credentials.
5. Notify affected users if confirmed.

If the scoped switch is unavailable or propagation is unverified, stop issuing remote-session/TURN authority at the server boundary and preserve Chat Only/current desktop behavior. Do not claim containment until active-session rejection is observed.

### 9.2 TURN Cost Spike

1. Reduce max session TTL.
2. Enforce bandwidth limits.
3. Disable relay for suspected accounts.
4. Keep Chat Only available.

### 9.3 Upload Abuse

1. Disable new uploads for account/device.
2. Preserve metadata for investigation.
3. Cleanup temp objects after retention.
4. Keep existing Lily desktop sessions unaffected.

## 10. Diagnostics Package

User-authorized diagnostic package may include:

- app version
- protocol version
- remote session id
- correlation ids
- error codes
- connection stats buckets
- feature config snapshot

Must not include:

- screen frames
- input text
- clipboard content
- file body
- raw audio

The package schema, consent, support RBAC, private storage and deletion drill are **BLOCKED** artifacts owned by MC-SPEC-025.

## 11. Dashboards

Required dashboards:

- remote session funnel
- WebRTC connectivity
- TURN bandwidth and cost
- upload reliability
- permission/approval funnel
- error code heatmap
- platform compatibility

## 12. Release Operations

Before enabling stable rollout:

- verify kill switches
- verify alert routing
- verify temp storage cleanup
- verify TURN credential expiry
- verify rate limits
- verify rollback keeps Chat Only or desktop baseline

Required kill switches, all currently planned rather than implemented, are: `mobileCommandEnabled`, `desktopControlEnabled`, `webrtcEnabled`, upload enablement, voice/provider enablement, push enablement, and region/account/device scoped denial. Verification must show signed/configured authority, audience, propagation time, active-session behavior, audit event, stale-config behavior, and recovery. Missing evidence blocks release.

## 13. Acceptance Criteria

- Operators can disable Desktop Control without disabling Chat Only.
- TURN cost is observable and capped.
- Upload temp storage cannot grow unbounded.
- Security incidents have documented first actions.
- Diagnostics preserve privacy.
