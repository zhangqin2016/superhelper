# Lily Mobile Command Pro Privacy, Retention, And Compliance Evidence

## 1. Status

- Spec: MC-SPEC-024
- Status: **evidence-needed**
- Evidence date: 2026-07-12
- Approval: **BLOCKED** pending selected deployment regions/providers, legal basis/consent copy, cross-border decisions, implemented deletion controls, and deletion proof.

This is the canonical data-governance contract. Product implementation may choose shorter retention or collect less data; it may not silently collect more, retain longer, or cross a border without a reviewed update.

## 2. Universal Prohibitions

Telemetry, logs, push payloads, audit summaries, and diagnostics must never contain screen/video frames, screenshots, typed text/key codes, clipboard content, raw audio, transcript text, file bodies/chunks, file system paths, original object keys/URLs, notification message content, access/refresh tokens, private keys, cookies, authorization headers, signed URLs, precise location, contact lists, or unbounded user/agent text.

Remote control data is purpose-limited to the active authorized session. It must not be used for advertising, model training, employee browsing, product replay, or behavioral profiling. Raw content must not be copied into general logs or analytics even during errors.

## 3. Data Inventory And Retention Gates

Numeric TTLs already appearing in draft domain contracts are proposed product limits, not proof of deployed lifecycle enforcement.

| Data class | Purpose and collector | Allowed fields/storage | Retention/deletion | Evidence state |
|---|---|---|---|---|
| Screen/media frames | peer-to-peer or TURN transport during observe/control | encrypted in transit; no server persistence or telemetry | discard after transport buffers drain/session ends | **BLOCKED**: capture/relay test, TURN logging config, crash/core-dump inspection, consent copy |
| Input events | authorized DataChannel to desktop adapter | bounded event type/coordinates; typed characters remain transport-only | discard after delivery/ack; no replay store beyond protocol necessity | **BLOCKED**: adapter/log inspection, authorization and revocation tests |
| Clipboard | explicit user request only | encrypted session transport; type/size may be bucketed | discard after delivery/failure | **BLOCKED**: consent UI/copy and no-log test |
| Signaling, SDP, ICE candidates and network endpoints | mobile/desktop WebRTC clients collect local candidates and SDP; signaling service relays offers/answers/candidates; selected STUN/TURN provider processes connectivity endpoints | only protocol version, opaque remote-session/correlation binding, message type, sequence/timestamp needed for ordering, SDP offer/answer body in encrypted transient relay, ICE candidate fields required by WebRTC (`foundation`, `component`, `protocol`, `priority`, `address`, `port`, `type`, related address/port, TCP type, username fragment) and TURN-authenticated endpoint data. Candidate addresses/IPs are sensitive and must be minimized/redacted outside the live connection path | memory/transient relay only; TTL is a **BLOCKED validation hypothesis**. Delete on delivery/ack, expiry, session end/revoke, device revoke or incident purge. No general logs, analytics, audit bodies, SDP persistence, replay archive or backup; exports omit bodies/endpoints and expose only approved aggregate connection/error facts | **BLOCKED**: signaling/TURN data-flow and provider-access evidence; encrypted-transit capture; memory/queue TTL and crash/restart tests; log/APM/core-dump redaction; cross-border/region/subprocessor approval; backup/dead-letter absence; export/delete/revoke/incident-purge proof; representative ICE candidate privacy review |
| Audio | local voice capture or accepted ASR transport | raw audio only in memory or approved encrypted temporary object fallback | default no server persistence; fallback TTL requires accepted provider/storage lifecycle | **BLOCKED**: ASR/provider region, retention/logging and deletion evidence |
| Transcript | compose draft/user turn | user-visible local/session data; never general telemetry | follows draft/turn deletion and account export policy | **UNVERIFIED**: account deletion/export mapping and provider no-retention evidence |
| Upload/file bytes | mobile local draft, private temporary object, desktop staging | encrypted, opaque key; sanitized name only where needed | proposed temp object/staging TTLs are not active until lifecycle proof exists | **BLOCKED**: private bucket, lifecycle/version/multipart/backup deletion proof |
| EXIF | mobile pre-upload transform | orientation allowed; location stripped by default; timestamp only when task needs it | transformed copy follows file TTL; discarded metadata not uploaded | **UNVERIFIED**: iOS/Android transform and golden-file tests |
| Device/account metadata | pairing/session authorization | opaque IDs, platform/app/protocol versions, trust/revocation state | state-machine/account retention; erase or pseudonymize when no legal/security need | **BLOCKED**: final data migration, deletion/export job and policy approval |
| IP/network metadata | abuse/security and coarse reliability | IP restricted to security access; analytics use region/network buckets | raw IP TTL requires legal/security approval; bucketed aggregate may outlive raw value | **BLOCKED**: legal basis, exact TTL, hashing/key rotation and access audit |
| Audit records | security/revocation/approval accountability | bounded codes, opaque IDs, timestamps; no content | draft data model proposes 365 days after pseudonymization | **UNVERIFIED**: legal/security approval, migration, purge test and backup proof |
| Telemetry | reliability/capacity/support | allowlisted event fields in MC-SPEC-025 | event/raw aggregate TTLs require accepted telemetry backend and policy | **BLOCKED**: schema enforcement, TTL, sampling, dashboard access and deletion test |
| Diagnostics bundle | user-authorized troubleshooting | allowlisted version/config/error/bucket fields plus integrity digests only for the generated diagnostics archive and allowlisted diagnostic record blobs; never user uploads/artifacts/desktop paths/file bodies or content hashes | generated locally; upload only on explicit consent; server TTL must be displayed | **BLOCKED**: package implementation, manifest/digest-scope/redaction test, private support storage/deletion proof |
| Push registration | advisory notification routing | platform token encrypted; app environment, opaque device binding | delete on invalidation, logout, device revoke, account deletion | **BLOCKED**: provider/project, token lifecycle/revoke test |
| Push/advisory intent and provider payload | server push producer; server transient queue; APNs/FCM or an accepted provider processes delivery | strict allowlist only: opaque event type, opaque device/session binding, short-lived correlation ID, and provider-required routing metadata. No message/task/file names or bodies, user/agent content, transcript, command/approval content, secrets, signed URLs, raw error text, or notification copy derived from content | TTL is a **BLOCKED validation hypothesis** until provider/queue evidence is accepted; collapse/dedupe by device + opaque event type + session so stale intents are replaced, not accumulated; delete on successful handoff when no retry is required, expiry, device/session revoke, logout/account deletion, provider invalid-token response, or incident purge | **BLOCKED**: queue schema/config and region; APNs/FCM/provider payload captures; TTL/retry/collapse/dedupe tests; revoke/delete/invalid-token tests; provider receipt semantics; backup/dead-letter absence or approved lifecycle; cross-border approval and audit evidence |

Push outages do not relax this row. Any queued advisory intent uses the same allowlist, retention, regional, access, deletion and audit rules; the queue must never contain notification content or reconstructable task/message/file content. Provider acceptance/delivery receipts may retain only provider message ID (opaque), bounded result code and timestamps needed for retry/audit, and must follow an accepted TTL/deletion schedule. The selected queue and APNs/FCM processing/storage regions, subprocessors and cross-border path must be included in the MC-SPEC-024 data-flow approval before push is enabled.

SDP and ICE handling does not inherit the broader telemetry or diagnostics allowlists. Candidate IPs/network endpoints remain sensitive even when private, relayed, hashed or truncated. Only the live connectivity path may access exact values; operational metrics use approved region/network-class aggregates, and support/customer-visible status cannot reveal endpoints or provider internals.

## 4. Access, Encryption, Export, And Deletion

- In transit: authenticated TLS; WebRTC DTLS-SRTP/DataChannel encryption. Certificate/cipher verification is **UNVERIFIED** until staging scan evidence exists.
- At rest: selected databases and private buckets must document encryption/KMS ownership and least-privilege roles. Candidate marketing claims are insufficient.
- Access: production content access is denied by default. Support sees redacted diagnostics only after explicit, time-bounded user authorization under MC-SPEC-025.
- Export: account export must enumerate device/session/audit/push/upload metadata and user-visible drafts/transcripts without exporting secrets, other users, expired temp content, or security-only material prohibited by law.
- Deletion trigger: account deletion, device revoke, session/upload expiry, user cancellation, invalid push token, or support-case closure invokes the owning deletion workflow.
- Deletion proof must identify request/subject, object/table classes, region/provider, requested/completed timestamps, result counts, remaining legal holds, versions/multipart/replicas/backups, verifier, and immutable proof ID. It must contain no deleted content.
- A provider “delete” API response alone is not complete proof. Required test: seeded data through primary, replica/version/multipart and backup paths; deletion execution; read/list denial; lifecycle expiry; restore-window verification; proof record review.

Exact TTLs, backup expiry, legal-hold rules, export SLA, and deletion SLA are **BLOCKED**. Required artifacts: approved retention schedule by data class and region, implemented job/config, automated clock-based tests, provider lifecycle exports, backup inventory/expiry, deletion drill results, and legal/security/privacy signatures.

## 5. Consent And User Copy

Before collection, copy must state what surface/data is shared, destination device/service, purpose, whether a provider/region receives it, whether content is temporarily stored, expiry/deletion behavior, how to stop/revoke, and what remains in audit records. Separate explicit actions are required for microphone, screen/desktop observation, control, clipboard, upload, EXIF preservation, and diagnostics upload. OS permission alone is not product consent.

Store privacy disclosures and in-product copy are **BLOCKED** pending final provider/region and legal review. Required artifacts: versioned zh-CN/en copy, consent-state test matrix, App Store/Google Play/vendor-store forms, privacy policy diff, and named approvers.

## 6. Cross-Border And Regional Approval

The current UAE entry is a Singapore edge proxy to a China stateful service; it is not UAE residency. Any UAE user metadata, telemetry, temporary file/audio, signaling, support diagnostic, or IP routed to China/Singapore is a cross-border data flow requiring explicit legal/privacy/security approval.

Before enabling a region, attach:

- data-flow diagram with source, transit, processing, storage, support access and backup locations;
- selected provider/legal entity, DPA, subprocessors and breach/deletion terms;
- lawful basis/consent and localization/transfer assessment for China, Singapore, UAE and any support location;
- bucket/database/log/telemetry region console exports and network tests;
- approved user/store copy and data-subject request workflow;
- cross-border approval ID, owner, scope, date and expiry/re-review trigger.

Until those artifacts exist, UAE/overseas Mobile Command content transfer and production telemetry are **BLOCKED**. Chat Only/current desktop behavior remains available.

## 7. Acceptance Gate

MC-SPEC-024 remains `evidence-needed` until inventory/schema enforcement, prohibited-data tests, provider/region approval, exact retention schedule, automated purge, deletion/backup proof, export/deletion workflows, consent copy, and cross-border approvals are all recorded. No provider selection may be inferred from this document.
