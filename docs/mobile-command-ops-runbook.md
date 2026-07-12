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

Proposed credential validation hypothesis:

- bound to account/session
- refresh before expiry
- revoke by ending remote session

The `30 minutes` value in the draft WebRTC contract is an **UNVERIFIED initial validation bound**, not an accepted operations threshold and not evidence of a security-approved protocol maximum. MC-ADR-004 must cite the accepted credential-threshold artifact that distinguishes any protocol/schema maximum from the shorter operations-selected issuance TTL. Before release, the issuer/clients must be tested across expiry, refresh, replay, revoke, clock skew and active-session rotation, and the infrastructure/security owners must approve the value. Runtime code and provider configuration must not hardcode `30 minutes` until that acceptance exists.

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
- device revocation failures
- kill switch failed to apply or propagate while sensitive authority remained usable

P1 alerts:

- spike in unauthorized input attempts without confirmed bypass
- TURN bandwidth runaway
- upload storage runaway
- signing verification failures spike
- WebRTC connect success below threshold
- upload failure rate spike
- signaling error spike
- push delivery failure spike

A kill switch that successfully fails closed and disables Mobile Command authority is expected safety behavior. Record the resulting user impact as an availability degradation; do not page P0 merely because the sensitive feature became unavailable. P0 requires authority-side fail-open, such as non-propagation or continued sensitive capability after denial.

## 7. Rate Limits

**PROPOSED TEST HYPOTHESES — not runtime defaults:**

| Action | Initial validation bound |
|---|---:|
| pairing start | 10 / hour / desktop |
| pairing consume | 20 / hour / account |
| remote session create | 60 / hour / account |
| permission request | 30 / hour / session |
| signaling messages | bounded per session |
| upload create | 100 / day / device |
| upload bandwidth | account quota |
| TURN bandwidth | account/session quota |

These values are inputs for abuse/load/false-positive testing only. They must not be presented as accepted defaults, shipped as literals, or copied into provider configuration until MC-SPEC-023/025 records representative traffic/load evidence, the exact counter/window/scope semantics, capability-gate behavior, and an accepted threshold artifact with infrastructure, security, product and support owner approval. Any security-canonical protocol/schema maximum must be cited separately; an operations-selected threshold may be stricter but cannot silently redefine that maximum.

After an operations threshold is accepted, exceeding it returns the canonical rate-limit error selected by the protocol/error catalog. `SERVER_RATE_LIMITED` is a draft compatibility label here, not proof of the final wire code.

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

1. Apply the accepted emergency issuance TTL; if no TTL threshold has been accepted, stop new TURN credential issuance for the affected scope instead of inventing or hardcoding one during the incident.
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

For every numeric TTL, rate limit, quota, SLO and alert threshold, attach the measured test result, counter/window semantics, selected value, approving owners and accepted artifact ID. Until then values labeled as hypotheses above are documentation-only and must not be runtime defaults.

Required kill switches, all currently planned rather than implemented, are: `mobileCommandEnabled`, `desktopControlEnabled`, `webrtcEnabled`, upload enablement, voice/provider enablement, push enablement, and region/account/device scoped denial. Verification must show signed/configured authority, audience, propagation time, active-session behavior, audit event, stale-config behavior, and recovery. Missing evidence blocks release.

## 13. Acceptance Criteria

- Operators can disable Desktop Control without disabling Chat Only.
- TURN cost is observable and capped.
- Upload temp storage cannot grow unbounded.
- Security incidents have documented first actions.
- Diagnostics preserve privacy.
