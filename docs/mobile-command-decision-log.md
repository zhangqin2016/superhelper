# Lily Mobile Command Pro Decision Log

## 1. Governance

This log is the only canonical place that chooses among Mobile Command architectural, platform, vendor, operational, and release alternatives. Descriptive specifications may state constraints and link here, but may not silently choose an alternative.

Decision statuses are `proposed`, `accepted`, and `superseded`. A mandatory decision cannot be `accepted` until its evidence is recorded, affected canonical artifacts are reconciled, and the named owner records approval and date.

Every ADR retains the nine required compatibility fields and adds four auditable approval fields:

- `Evidence refs` contains only repository paths, artifact IDs, test/evidence IDs, or links to the controlling plan heading; `Pending` means the evidence does not exist yet.
- `Evidence owner` is an accountable human role, never a document or task name.
- `Approved by` is the approving person or role; proposed records use `Pending`.
- `Approved on` is an ISO `YYYY-MM-DD` date; proposed records use `Pending`.
- `Accepted by date` is the required compatibility summary. While proposed it is `Pending`. When accepted its machine-readable value must be exactly `<Approved by> / <Approved on>` and therefore must agree with those two authoritative fields.

Supersession is append-only: create a new `MC-ADR-*` ID, set its `Supersedes` field to the old ID, and change the old record's status to `superseded`. Never edit an accepted decision in place to represent a different choice, and never delete the old record.

Repository-truth decisions may be accepted by the accountable architecture role when the audited current code is sufficient. Vendor, platform, product-location, and production-topology choices remain proposed until their separate evidence gates complete.

## MC-ADR-001 — Mobile application repository and build boundary

- Status: proposed
- Decision: Determine whether the mobile web application lives at `web/mobile-command/`, a separate top-level application, or another repository-grounded boundary, and select its package/build ownership.
- Repository evidence: Existing documents only call `web/mobile-command/` “preferred” or “suggested”; the repository-truth gate must inspect current workspace, build, deploy, and dependency conventions.
- Evidence refs: Pending — MC-SPEC-005, MC-SPEC-036
- Evidence owner: Repository architecture lead
- Alternatives: nested Next.js application; separate top-level mobile application; separate repository/package.
- Capability gate: Mobile packaging must remain additive and must not weaken desktop chat or local agent execution.
- Failure fallback: Until accepted, no production mobile package or build wiring may be created; desktop Lily remains unchanged.
- Compatibility migration: Must define dependency isolation, shared schema consumption, deployment URLs, and migration from any prototype location.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-002 — Capacitor and native capability shell boundary

- Status: proposed
- Decision: Select the native shell technology and exact boundary between web-owned UX/protocol logic and native-only secure keys, background upload, push, share sheet, camera, permissions, and lifecycle behavior.
- Repository evidence: [Native capability shell](mobile-command-native-shell.md) defines a proposed narrow bridge and [build/release](mobile-command-build-release.md) assumes Capacitor, but no repository integration or platform build evidence is recorded.
- Evidence refs: Pending — MC-SPEC-005, MC-SPEC-014, MC-SPEC-015, MC-SPEC-028, MC-SPEC-034
- Evidence owner: Mobile platform lead
- Alternatives: Capacitor; platform-native iOS/Android shells; PWA-only baseline; another embedded-web shell.
- Capability gate: Native capability failure must preserve the web Chat Only baseline; missing authority fails safe.
- Failure fallback: Unsupported native methods return explicit errors and leave text chat available; no unconfigured native fallback.
- Compatibility migration: Must freeze bridge versioning, plugin ownership, minimum OS versions, signing, and web-only degradation.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-003 — User, license, desktop, and mobile identity mapping

- Status: accepted
- Decision: Use `users.id` as `user_id`; use the unified existing `devices.id` as `device_id` for both desktop and mobile devices, with role/pairing represented additively; use `user_sessions.id` only for account authentication state; and use `licenses.id` through `license_devices` as entitlement context. `mobile_remote_sessions.id` is a distinct additive remote-channel concept and must never be stored in, encoded as, or called a `user_sessions` account session or a local conversation.
- Repository evidence: `server/migrations/001_initial.sql:1-32` defines licenses, devices, and license bindings; `server/migrations/007_client_config_profiles.sql:43-56` binds device keys/nonces to the same device; `server/migrations/022_account_wallet.sql:1-63` defines users, user sessions, and user-device links; `server/src/routes/public/auth.js:88-111,213-231` creates account sessions and user-device links.
- Evidence refs: MC-SPEC-005 §2–3; `server/migrations/001_initial.sql`; `server/migrations/007_client_config_profiles.sql`; `server/migrations/022_account_wallet.sql`; `server/src/services/device-identity.js`; `server/src/routes/public/auth.js`; `server/src/services/account-auth.js`
- Evidence owner: Identity and security lead
- Alternatives: user-primary ownership; license-primary ownership; device-primary ownership; explicit linked identity domains.
- Capability gate: Identity uncertainty must reject pairing/control authority without invalidating local desktop licensing or local sessions.
- Failure fallback: Authentication/binding ambiguity denies remote actions; local Lily remains usable.
- Compatibility migration: This accepted ADR fixes only current-code identity mapping and concept boundaries; it requires no reinterpretation of existing rows. Proposed key history, composite constraints, revocation cascades, retention, and normative Appendix DDL belong to the draft [data model](mobile-command-data-model.md) and are not accepted implementation evidence under this ADR.
- Supersedes: None.
- Approved by: Identity and security lead
- Approved on: 2026-07-12
- Accepted by date: Identity and security lead / 2026-07-12

## MC-ADR-004 — WebRTC topology and TURN service

- Status: proposed
- Decision: Select signaling ownership, STUN/TURN topology, managed versus self-hosted TURN, credential issuer, regions, relay policy, capacity, and cost controls.
- Repository evidence: [WebRTC runbook](mobile-command-webrtc-runbook.md) defines desired behavior and [operations runbook](mobile-command-ops-runbook.md) defines operational needs, but no provider, deployment, load, or cost evidence exists.
- Evidence refs: Pending — MC-SPEC-015, MC-SPEC-023, MC-SPEC-025, MC-SPEC-029
- Evidence owner: Infrastructure and operations lead
- Alternatives: self-hosted coturn; managed TURN; hybrid regional topology; relay-only or P2P-first policy.
- Capability gate: WebRTC/TURN failure must degrade to Chat Only and never terminate or weaken the local Lily session.
- Failure fallback: Bounded ICE/reconnect attempts then explicit `failed_chat_only`; no endless retry or silent control continuation.
- Compatibility migration: Must cover credential/version compatibility, region rollout, provider migration, and old-client feature disablement.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-005 — Windows capture and input implementation

- Status: proposed
- Decision: Select and prove Windows app/desktop capture and scoped input injection technologies, helper language/library, IPC, permission, signing, packaging, update, and crash recovery.
- Repository evidence: Existing OS documents list Electron desktop capture, Windows Graphics Capture, and `SendInput` candidates; [OS helper spike](mobile-command-os-helper-spike.md) has no measured result.
- Evidence refs: Pending — MC-SPEC-015, MC-SPEC-016, MC-SPEC-018, MC-SPEC-019
- Evidence owner: Windows platform lead
- Alternatives: Electron-only capture; Windows Graphics Capture helper; Node native addon; Rust/C++ helper using `SendInput`; observe-only degradation.
- Capability gate: Helper failure cannot affect desktop chat; input outside the approved surface must be rejected.
- Failure fallback: Input failure downgrades to observe or Chat Only as authority permits; crash fails loud and revokes control.
- Compatibility migration: Must cover Windows versions, DPI/multi-monitor mapping, code signing, updater compatibility, and helper protocol versioning.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-006 — macOS capture and input implementation

- Status: proposed
- Decision: Select and prove macOS app/desktop capture and scoped input injection technologies, permission flow, helper boundary, signing, notarization, packaging, update, and crash recovery.
- Repository evidence: Existing OS documents list ScreenCaptureKit/Electron and CGEvent/Accessibility candidates; no real-device permission or notarization evidence exists.
- Evidence refs: Pending — MC-SPEC-015, MC-SPEC-016, MC-SPEC-018, MC-SPEC-019
- Evidence owner: macOS platform lead
- Alternatives: Electron capture; ScreenCaptureKit helper; CGEvent helper; observe-only degradation.
- Capability gate: Missing Screen Recording or Accessibility authority denies the affected mode while preserving Chat Only.
- Failure fallback: Permission denial or helper failure produces explicit recoverable state; control is revoked, never continued invisibly.
- Compatibility migration: Must cover supported macOS versions, permission changes, hardened runtime, entitlements, notarization, and helper protocol versioning.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-007 — Linux capture and input support level

- Status: proposed
- Decision: Select the supported Linux display/session matrix and whether each environment provides observe, control, or explicit Chat Only degradation.
- Repository evidence: Existing documents mention PipeWire/portal and limited input but do not record distro, Wayland/X11, portal, packaging, or security evidence.
- Evidence refs: Pending — MC-SPEC-015, MC-SPEC-016, MC-SPEC-018, MC-SPEC-019
- Evidence owner: Linux platform lead
- Alternatives: Wayland portal observe only; X11 capture/control; helper-based control; Linux Chat Only.
- Capability gate: Unsupported Linux environments must fail loud to Chat Only rather than advertise unsafe or nonfunctional control.
- Failure fallback: Missing portal/helper/authority disables Live capability without affecting local Lily.
- Compatibility migration: Must publish a platform matrix and ensure release metadata never advertises an unverified capability.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-008 — ASR primary and fallback providers

- Status: proposed
- Decision: Select configured ASR primary/fallback order, service endpoints, credentials, privacy path, thresholds, languages, latency/quality targets, and cost limits.
- Repository evidence: [ASR provider spike](mobile-command-asr-provider-spike.md) contains only `TBD` evaluation results; [voice input contract](mobile-command-voice-input.md) contains a proposed provider order.
- Evidence refs: Pending — MC-SPEC-017, MC-SPEC-020, MC-SPEC-021, MC-SPEC-024
- Evidence owner: Speech and privacy lead
- Alternatives: browser speech; native OS speech; Lily streaming ASR; Lily non-streaming ASR; configured model transcription; text-only fallback.
- Capability gate: ASR failure preserves existing typed text and partial transcript; voice never bypasses approval or switches to an unconfigured provider.
- Failure fallback: Follow only the accepted configured chain, then retain the draft and return to text input.
- Compatibility migration: Must define server-config compatibility, disabled-provider behavior, privacy copy, credential rotation, and older web/native clients.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-009 — Push notification providers and credential ownership

- Status: proposed
- Decision: Select iOS and Android push providers, registration/token lifecycle, credential ownership, notification content policy, environments, and revocation behavior.
- Repository evidence: UI/native/build documents specify required behavior but do not choose APNs/FCM integration topology or record operational evidence.
- Evidence refs: Pending — MC-SPEC-023, MC-SPEC-024, MC-SPEC-025, MC-SPEC-028
- Evidence owner: Mobile infrastructure lead
- Alternatives: direct APNs plus FCM; managed aggregation service; no push in baseline; platform-specific staged rollout.
- Capability gate: Push is advisory only; failure cannot block commands, approvals, or local Lily, and notification content cannot grant authority.
- Failure fallback: Commands remain available on reconnect/poll; invalid tokens are retired; sensitive content is omitted.
- Compatibility migration: Must cover token rotation, app environment separation, old clients, provider outage, and device revocation.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-010 — Temporary object storage and retention

- Status: proposed
- Decision: Select temporary upload/artifact/audio storage, regions, encryption, signed access, scanning, quotas, retention, deletion proof, backup exclusion, and cost controls.
- Repository evidence: File, voice, and operations documents propose TTLs and behavior but do not identify a deployed storage topology or verified lifecycle policy.
- Evidence refs: Pending — MC-SPEC-023, MC-SPEC-024, MC-SPEC-025, MC-SPEC-027
- Evidence owner: Data infrastructure lead
- Alternatives: existing object storage; dedicated object bucket; server-local staging; provider-managed temporary storage.
- Capability gate: Storage failure must preserve local chat and drafts; unverifiable or expired objects must not enter agent execution.
- Failure fallback: Fail upload explicitly, preserve retriable metadata where safe, and delete/expire objects according to the accepted policy.
- Compatibility migration: Must define object-key/version compatibility, region migration, stale-client URLs, and deletion during provider change.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-011 — Feature-flag source and configuration merge

- Status: accepted
- Decision: Preserve two authoritative current delivery paths: `GET /api/client/bootstrap` owns unsigned region/routing/bootstrap feature policy, while signed `POST /api/client/config` owns device-resolved effective configuration merged from enabled `config_profiles` by scope/priority. Mobile Command adds versioned fields and kill switches to the appropriate path; it does not collapse the two sources or create an unreviewed third config service.
- Repository evidence: `server/src/routes/public/client-config.js:61-103,106-175` shows profile filtering/`deepMerge`, the bootstrap GET, and the signed config POST; `src/main/service-client.js:293-328` calls bootstrap directly without the signed `serviceFetch`; `src/main/remote-config.js:275-326` verifies and caches effective config.
- Evidence refs: MC-SPEC-005 §2–3; `server/src/routes/public/client-config.js`; `src/main/service-client.js`; `src/main/remote-config.js`; MC-SPEC-023; MC-SPEC-034
- Evidence owner: Configuration platform lead
- Alternatives: existing Lily remote config; dedicated Mobile Command config; build-time flags; hybrid signed remote config.
- Capability gate: Unknown, expired, or unavailable remote authority disables sensitive remote capabilities while preserving today's desktop/local behavior.
- Failure fallback: Fail open to the existing desktop baseline and fail safe for pairing, observe, control, upload, voice-provider, and push authority.
- Compatibility migration: Must define additive fields, older-client ignore behavior, rollback, cached-config expiry, and scope changes.
- Supersedes: None.
- Approved by: Configuration platform lead
- Approved on: 2026-07-12
- Accepted by date: Configuration platform lead / 2026-07-12

## MC-ADR-012 — Desktop, server, web, and native release coupling

- Status: proposed
- Decision: Select independent versus coupled release units, compatibility windows, minimum versions, schema negotiation, phased rollout order, kill switches, store lag policy, and rollback order.
- Repository evidence: [Build and release](mobile-command-build-release.md) proposes artifacts and compatibility rules but no verified CI/deploy/store evidence or accepted application boundary exists.
- Evidence refs: Pending — MC-SPEC-003, MC-SPEC-004, MC-SPEC-012–015, MC-SPEC-023, MC-SPEC-034
- Evidence owner: Release engineering lead
- Alternatives: lockstep release; independently versioned components with compatibility matrix; desktop/server first then mobile; feature-flagged staged rollout.
- Capability gate: Mixed versions and rollback must never remove existing desktop capability; unsupported remote features stay disabled.
- Failure fallback: Incompatible Mobile Command surfaces fail to an explicit upgrade/Chat Only state without changing local desktop sessions.
- Compatibility migration: This decision owns the compatibility window, protocol/schema versions, migration sequencing, store delay, rollback, and deprecation policy.
- Supersedes: None.
- Approved by: Pending
- Approved on: Pending
- Accepted by date: Pending

## MC-ADR-013 — Public route registration boundary

- Status: accepted
- Decision: Register future public Mobile Command routes through one cohesive public registrar called by `publicRoutes`; `registerRoutes` remains the top-level composition owner. The routes must remain visible to `buildDocApp` OpenAPI enumeration.
- Repository evidence: `server/src/app.js:91-114` calls and exports `registerRoutes`; `server/src/routes/public.js:14-37` is the actual public registrar. There is no `server/src/routes/public/index.js`.
- Evidence refs: MC-SPEC-005 §2; `server/src/app.js`; `server/src/routes/public.js`
- Evidence owner: Server architecture lead
- Alternatives: direct registration in `app.js`; scattered route registration; a new unreferenced public index.
- Capability gate: Registration failure or feature disablement cannot affect existing public routes or desktop behavior.
- Failure fallback: Keep the registrar disabled/absent and preserve today's route graph.
- Compatibility migration: Add routes and schemas without changing existing URLs or registration order; preserve doc-app coverage.
- Supersedes: None.
- Approved by: Server architecture lead
- Approved on: 2026-07-12
- Accepted by date: Server architecture lead / 2026-07-12

## MC-ADR-014 — Existing-conversation command and event boundary

- Status: accepted
- Decision: Inject remote commands only through `TurnOrchestrator.sendUserMessage` for an existing local session. Busy behavior, queue ordering, steer fallback, transcript ownership, normalized runtime events, permission events, and question events remain owned by the current orchestrator/runtime adapter chain; Mobile Command must not call the engine session directly or forward raw OpenCode events.
- Repository evidence: `src/main/turn-orchestrator.js:841-925` owns dispatch/queue/steer fallback; assistant IPC and scheduled tasks call it at `src/main/ipc-assistant.js:106,176` and `src/main/scheduled-tasks.js:276`; runtime normalization lives in `src/main/runtime/opencode-message-parts.js` and `src/main/runtime/opencode-runtime-reducer.js`.
- Evidence refs: MC-SPEC-005 §2–3; `src/main/turn-orchestrator.js`; `src/main/ipc-assistant.js`; `src/main/scheduled-tasks.js`; `src/main/runtime/opencode-message-parts.js`; `src/main/runtime/opencode-runtime-reducer.js`
- Evidence owner: Desktop agent architecture lead
- Alternatives: direct `OpencodeAgentSession` calls; parallel remote conversation store; raw runtime event proxy.
- Capability gate: Bridge/steer failure degrades to today's queue/local behavior and never weakens the local session.
- Failure fallback: Reject before dispatch when authority is invalid; after a valid busy dispatch, use the existing queue fallback.
- Compatibility migration: Preserve local session IDs, transcript ordering, renderer events, permission/question handling, and kill switch behavior.
- Supersedes: None.
- Approved by: Desktop agent architecture lead
- Approved on: 2026-07-12
- Accepted by date: Desktop agent architecture lead / 2026-07-12

## MC-ADR-015 — Artifact registry and file staging reuse boundary

- Status: accepted
- Decision: Reuse the current artifact registry only as a workspace-confined local artifact source and the file staging manager only as a local destination after remote bytes are fully authorized and verified. Neither current module is a remote transfer, authorization, retention, replay, scanning, or live-artifact-event service.
- Repository evidence: `src/main/artifact-registry.js:175-277` requires workspace paths and owns local manifest identity; `src/main/turn-artifacts.js:264-357` derives artifacts from terminal record inputs through `buildTurnArtifacts`, called by `src/main/turn-archive.js:15-49` and the legacy backfill at `src/main/session-artifact-backfill.js:8-29`; `src/main/file-staging-manager.js:67-150` stages whole local paths/buffers with random IDs and has no chunk/hash/idempotency/risk contract.
- Evidence refs: MC-SPEC-005 §2–3; `src/main/artifact-registry.js`; `src/main/turn-artifacts.js`; `src/main/turn-archive.js`; `src/main/session-artifact-backfill.js`; `src/main/file-staging-manager.js`; MC-SPEC-027
- Evidence owner: Desktop data-boundary lead
- Alternatives: treat existing modules as complete remote transfer services; duplicate all local registries; build network logic into either module.
- Capability gate: Remote transfer failure leaves current local artifacts and attachments unchanged; unverifiable input never reaches execution.
- Failure fallback: Fail remote upload/download explicitly and retain today's local-only path.
- Compatibility migration: Preserve manifest format and current staging callers; add adapters and remote descriptors outside these modules.
- Supersedes: None.
- Approved by: Desktop data-boundary lead
- Approved on: 2026-07-12
- Accepted by date: Desktop data-boundary lead / 2026-07-12

## 2. Mandatory Decision Closure Summary

| Decision | Responsible role | Current status |
|---|---|---|
| MC-ADR-001 | Repository architecture lead | proposed |
| MC-ADR-002 | Mobile platform lead | proposed |
| MC-ADR-003 | Identity and security lead | accepted |
| MC-ADR-004 | Infrastructure and operations lead | proposed |
| MC-ADR-005 | Windows platform lead | proposed |
| MC-ADR-006 | macOS platform lead | proposed |
| MC-ADR-007 | Linux platform lead | proposed |
| MC-ADR-008 | Speech and privacy lead | proposed |
| MC-ADR-009 | Mobile infrastructure lead | proposed |
| MC-ADR-010 | Data infrastructure lead | proposed |
| MC-ADR-011 | Configuration platform lead | accepted |
| MC-ADR-012 | Release engineering lead | proposed |
| MC-ADR-013 | Server architecture lead | accepted |
| MC-ADR-014 | Desktop agent architecture lead | accepted |
| MC-ADR-015 | Desktop data-boundary lead | accepted |

The specification-freeze gate is blocked while any row remains `proposed`.
