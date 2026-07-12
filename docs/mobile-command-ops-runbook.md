# Lily Mobile Command Pro Ops Runbook

## 1. Purpose

This document defines operational requirements for Mobile Command Pro: service deployment, TURN, temporary storage, monitoring, alerting, abuse controls, incident response, and cost guardrails.

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

### 9.1 Remote Control Risk

If unauthorized control is suspected:

1. Disable `desktopControlEnabled`.
2. Revoke active remote sessions.
3. Preserve audit summaries.
4. Rotate affected TURN credentials.
5. Notify affected users if confirmed.

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

## 13. Acceptance Criteria

- Operators can disable Desktop Control without disabling Chat Only.
- TURN cost is observable and capped.
- Upload temp storage cannot grow unbounded.
- Security incidents have documented first actions.
- Diagnostics preserve privacy.
