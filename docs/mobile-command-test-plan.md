# Lily Mobile Command Pro Test Plan

## 1. Purpose And Current Status

This plan verifies the stable requirements in [traceability](mobile-command-requirements-traceability.md) through the exact [MC-TC cases](mobile-command-test-cases.md). It does not claim that planned files exist or pass. Current Specification Freeze and Production Release are both **BLOCKED**.

## 2. Required Layers

| Layer | Required scope | Evidence accepted at release |
|---|---|---|
| Unit | permission policy, state transitions, bounds, merge and redaction | test log tied to commit/build and MC-TC IDs |
| Contract | OpenAPI, WS/DataChannel and native JSON Schema including malformed/oversized/version skew | validator output plus negative fixtures |
| Integration | identity, route, relay, storage, orchestrator, staging, artifact and config seams | isolated service/desktop test logs |
| Security | forged signatures, replay, revocation races, missing policy, approval/audit failure and secret prohibition | adversarial suite plus security approval |
| E2E/platform | real desktop/mobile pairs, native/PWA downgrade, OS permissions, lifecycle and accessibility | exact versioned MC-MAN record and artifacts |
| Reliability | relay loss, reconnect/snapshot, load, chaos, store lag, kill switch and rollback | load/chaos/drill reports |

## 3. Stable Suite Ownership

Automated filenames are recorded beside every case in the case catalog. Test discovery uses `scripts/test-*.mjs`; implementation must not silently rename an `MC-TC-*` ID. One file may implement multiple cases, but its output must enumerate the exact IDs. A changed invariant gets a new requirement/test ID or an explicit supersession record.

Minimum negative fixtures are mandatory: malformed envelope, forged signature/body, maximum+1 oversized command/upload/native payload, revoke-versus-consume/refresh/complete race, missing/stale/exception permission state, relay loss before and after acknowledgement, unsupported major/unknown mandatory semantic, and local transcript/session checksum before/after remote failure.

## 4. Platform And Network Matrix

Run every capability advertised for Windows, macOS and Linux against iOS native, Android native and PWA where the [platform evidence matrix](mobile-command-platform-support-matrix.md) claims support. Unverified pairs stay disabled and are tested only for explicit downgrade; they cannot be counted as a capability pass.

Each supported pair covers direct and forced TURN TCP/TLS, 5/10/20% loss, 300/700/1200 ms latency, offline/reconnect, phone background/lock, desktop lock/sleep/wake, topology/DPI change, permission revoke while active, IME/keyboard ambiguity, camera/share/background upload, and native-to-PWA downgrade. Current matrix has no fully approved pair, so these are Production Release blockers.

## 5. Assertions Required In Every Case

Every result record must state preconditions and fixture IDs; exact input/event bytes or canonical fixture hash; expected state before/after; exact response/error; forbidden calls/state changes; allowlisted audit/telemetry; cleanup confirmation; and platform scope. A passing positive assertion cannot mask a forbidden side effect. Sensitive body absence is checked structurally, not by visual log inspection.

Capability-gate assertions are always explicit: remote/relay/native/storage/ASR failure preserves today's local Lily baseline; missing or ambiguous authority denies the sensitive action; recoverable operations resume only a durable checkpoint; limits act on schema bounds or confirmed state and never silently kill evolving local work.

## 6. Release Gates And Severity

The authoritative gate status is [the readiness checklist](mobile-command-release-readiness-checklist.md). Specification Freeze requires accepted ADRs, complete traceability and closure validation. Production Release additionally requires implemented tests, signed builds, representative platform QA, load/chaos evidence, monitoring/privacy/support approval, rollback rehearsal and staged kill switches.

Severity: P0 is unauthorized control/action, cross-account/session leak, private key/content disclosure, or local Lily corruption; P1 is failed revocation/expiry/integrity, unusable relay for an advertised pair, or irrecoverable duplicate/loss; P2 is bounded quality, copy, visual or non-sensitive observability defect. Any P0/P1 blocks release; waived P2 requires owner, reason, expiry and linked follow-up.

## 7. Evidence Retention

Store machine logs, schema fixtures, screenshots/video where permitted, build/provenance IDs, network profiles, reviewer/date, and cleanup proof under the future release evidence manifest. Never store clipboard, raw input, prompt/file bodies, private keys, tokens, TURN credentials, or unredacted diagnostics. Planned case names and candidate-vendor documentation are not execution evidence.

## 8. Canonical Fixture And Hash Contract

Fixture JSON uses UTF-8 without BOM or trailing newline. Recursively sort object keys by Unicode code point; preserve array order and JSON number/string spelling; serialize with `JSON.stringify` and no whitespace. Binary fixtures use the descriptor `binary:v1;contentType=<type>;length=<decimal>;sha256=<lower-hex>` and the hash is over the actual bytes, not the descriptor. Every final expanded fixture has `schemaVersion:1`, `protocolVersion:1`, its schema boundary, UTF-8 byte length and lowercase SHA-256 in the case catalog. A base plus patch is allowed only when the catalog also records the final expanded hash.

Fixtures use reserved synthetic IDs (`usr_test`, `desk_test`, `mob_test`, `rs_test`, `sess_test`) and repeated non-secret bytes. They MUST NOT contain real credentials, signatures, keys, TURN secrets, push tokens, file contents or PII.

Verification command (reads the catalog, expands any declared patch, canonicalizes, then checks bytes/hash and all 62 case references):

```bash
node scripts/test-mobile-command-spec-closure.mjs --fixtures docs/fixtures/mobile-command-test-fixtures.json --manifest docs/mobile-command-test-cases.md
```

The validator is implemented at `scripts/test-mobile-command-spec-closure.mjs` and must be run after any MC-TC manifest or fixture change:

```bash
node scripts/test-mobile-command-spec-closure.mjs --fixtures docs/fixtures/mobile-command-test-fixtures.json --manifest docs/mobile-command-test-cases.md
```

Visual comparison or trusting a pasted digest is not acceptable.
