# Lily Mobile Command Current Demo Status

## 1. Status

Status: **demo core usable** as of 2026-07-14.

This document records the current implementation state after the Phase 1 demo work. It does not authorize a production Mobile Command Pro release, native mobile app release, screen mirroring, voice input, OS input injection, clipboard access, push delivery, TURN/WebRTC relay, or support/ops readiness.

## 2. Demo Core That Exists Now

The current web/mobile command demo supports:

- QR pairing with no phone login: the desktop creates a pairing challenge, the phone consumes it with a grant-scoped token, and the desktop explicitly approves or rejects the pending phone.
- Desktop pairing management: the desktop can list paired/pending phones and revoke a grant.
- Mobile command submission: a paired phone can send a task into the currently controlled Lily desktop session through the relay and desktop bridge.
- Stream/projection feedback: desktop projections can flow back to the phone, including admitted-command state and refreshed session context.
- Session context and recent history: the phone can ask which Lily session it controls and see a bounded recent conversation projection.
- Mobile session selection: the phone requests the current desktop project's session list, can choose a target Lily session, and sends subsequent mobile commands to that selected session without stealing the desktop UI's active session. If no session is selected or the selected session disappears, the bridge falls back to the desktop foreground session.
- One-tap interrupt: the phone can request interruption through the desktop bridge seam; failures acknowledge cleanly instead of throwing.
- Browser dictation input: the phone page exposes a microphone button that uses the browser's built-in `SpeechRecognition`/`webkitSpeechRecognition` when available and appends recognized text to the normal task input. Unsupported browsers or denied microphone permission fail visibly back to typed text. This is not production native voice/ASR.
- Phone image attachments: the phone page can attach a camera/gallery image; the desktop materializes it as a local temp file and passes it to the normal Lily turn path so the existing vision preflight handles it.
- Re-scan recovery: pairing the same phone again supersedes the lingering live pairing instead of wedging on the live-pair uniqueness rule.
- Command correlation: phone command frames carry a `correlationId`; desktop admission/rejection acks and bridge logs preserve it so support can match a phone-visible send with desktop-side handling.
- Visible delivery failures: the phone page now shows desktop-offline relay feedback with command correlation when available, reconnect progress, reconnect exhaustion, disconnected send/stop attempts, and dropped/partial image attachment delivery instead of silently implying success.
- Queued send feedback: after the phone sends a command, it clears stale reply text and shows a waiting-for-desktop state until the desktop turn starts streaming or completes.
- Protocol failure guard: unsupported mobile command protocol versions, oversized text, and too many attachments are rejected before desktop admission, preserving the local Lily baseline.
- Attachment retention hygiene: phone-sent temp attachments use bounded filenames and the desktop best-effort cleans expired `mcmd_` temp files without touching unrelated files.
- Specification fixture closure: the 62 stable MC-TC fixture rows are now executable-checked against canonical byte length and SHA-256.
- Final-shape server surface: the documented remote-session, permission, TURN, upload, artifact, push, and diagnostics HTTP routes are registered. Chat-level remote sessions are implemented as a bounded server-local v1; permission elevation, TURN, native, voice, push, diagnostics upload, direct artifact byte serving, and live control routes return typed disabled responses with `chat_only` fallback instead of 404 or accidental success.
- Server-local remote session v1: create/refresh/end session routes return a short-lived `chat` permission session descriptor with protocol-version and device-mismatch guards. It does not grant screen observation, control, clipboard, or TURN authority.
- Server-local file transfer v1: upload create/chunk/status/complete and artifact descriptor/download-token routes run against a bounded server-local implementation with chunk/full-file SHA-256 checks, idempotent chunk retry, simple risk classification, and short-lived `mobile-artifact://` download handles. Production object storage, background upload, and desktop staging remain evidence-gated.
- Capability metadata: the phone page reads `/api/mobile/capabilities` and shows the current usable demo surface while keeping screen, voice, and mouse/keyboard control visibly gated.
- Kill-switch contract: capability metadata accepts explicit flags for global Mobile Command, remote sessions, uploads, and artifacts; configured-off capabilities fail closed at the route boundary with `MC-ERR-CONFIG-FEATURE-DISABLED` while preserving `chat_only` fallback.
- Capability contract ownership: server capability/disabled responses live in `server/src/services/mobile-command-capabilities.js`, non-pairing final-shape routes live in `server/src/routes/public/mobile-command-surface.js`, and the desktop settings status now reads the same capability contract.

## 3. Implementation Evidence

Representative code owners:

- Desktop pairing orchestration: `src/main/mobile-pairing-manager.js`
- Desktop IPC and bridge wiring: `src/main/ipc-mobile-pairing.js`
- Relay-to-agent bridge: `src/main/mobile-agent-bridge.js`
- External command admission: `src/main/external-command-admission.js`
- Phone attachment materialization: `src/main/mobile-attachments.js`
- Server pairing and relay services: `server/src/services/mobile-pairing.js`, `server/src/services/mobile-relay.js`
- Phone web pairing/command page: `web/app/m/pair/page.js`
- Pairing migrations: `server/migrations/025_mobile_pairing.sql`, `server/migrations/026_mobile_pairing_vouched.sql`

Representative automated checks:

- `server/scripts/mobile-command-e2e.mjs`: real server plus Postgres pairing -> relay -> command/projection round trip, including desktop-vouched no-login phone pairing, re-scan supersession, and revoke refusal.
- `scripts/test-mobile-command-e2e.mjs`: no-DB integration smoke for relay -> desktop bridge -> external admission -> mobile admission projection.
- `scripts/test-mobile-agent-bridge.mjs`: command admission, interrupt handling, session context, and attachment materialization behavior.
- `scripts/test-mobile-agent-bridge.mjs`: mobile session-list and session-select frames return bounded context and fail safe when unavailable.
- `scripts/test-external-command-admission.mjs`: durable admission decisions retain the command correlation id in records and mobile responses.
- `scripts/test-mobile-attachments.mjs`: bounded phone attachment decoding and temp-file materialization.
- `scripts/test-mobile-attachments.mjs`: expired mobile temp attachment cleanup deletes only old `mcmd_` files.
- `scripts/test-mobile-pair-web.mjs`: phone page command frame includes optional attachment payload.
- `scripts/test-mobile-pair-web.mjs`: phone page renders queued send, desktop offline, reconnect failure, disconnected send/stop, and dropped/partial attachment states.
- `scripts/test-mobile-relay-auth.mjs`: peer-offline feedback preserves command correlation ids when the relay can parse them.
- `scripts/test-mobile-protocol-version.mjs`: unsupported protocol and oversized command frames do not reach desktop admission.
- `scripts/test-mobile-command-spec-closure.mjs`: MC-TC manifest rows match the canonical fixture object pointers, byte lengths, and SHA-256 hashes.
- `scripts/test-mobile-server-final-shape.mjs`: final Mobile Command HTTP routes are registered, chat-level remote sessions and file transfer routes work, and evidence-gated capabilities fail safe as typed disabled responses.
- `scripts/test-mobile-command-error-contract.mjs`: runtime Mobile Command error codes stay aligned with the canonical error catalog and OpenAPI `ErrorCode` enum.
- `scripts/test-mobile-command-kill-switch.mjs`: global and upload-specific kill switches disable advertised capability and block route mutation with `chat_only` fallback.
- `scripts/test-mobile-command-schema-references.mjs`: API matrix machine references resolve against OpenAPI, WebSocket/DataChannel event schema, and native bridge schema, including HTTP operation inventory.
- `scripts/test-mobile-command-privacy-redlines.mjs`: evidence-gated push and diagnostics contracts stay metadata-only with explicit diagnostics consent, redacted diagnostic outputs, and no raw content/path/body/text/header fields in those payloads.
- `scripts/test-mobile-command-observability-contracts.mjs`: observability/support schema contracts compile, accept bounded telemetry/status/diagnostics manifests, enforce status fallback invariants, and reject sensitive/free-text fields.
- `scripts/test-mobile-file-transfer.mjs`: server-local upload/artifact service verifies chunk hashes, full-file hashes, idempotent retries, risk classification, and descriptor/download-token generation.
- `scripts/test-mobile-remote-session.mjs`: server-local remote session service creates, refreshes, ends, and rejects unsupported protocol or wrong-device access.
- `scripts/test-mobile-pairing-manager.mjs`, `scripts/test-mobile-pairing-ui.mjs`, `scripts/test-mobile-pairing-wiring.mjs`: desktop pairing UI/IPC/manager wiring plus shared server capability status rendering.
- `scripts/test-mobile-relay-auth.mjs`, `scripts/test-mobile-relay-core.mjs`: relay authorization and grant isolation.

## 4. Boundaries That Still Matter

The demo is not the same as production Mobile Command Pro. These remain blocked or evidence-needed:

- Native iOS/Android app release, signed builds, app-store distribution, background execution, mobile push, and OS permission matrices.
- Screen mirroring or desktop/app observation through WebRTC/TURN.
- Mouse, keyboard, IME, secure-desktop, or clipboard control.
- Production voice input/ASR provider choice, privacy path, latency/accuracy evidence, and battery/performance matrix. Browser dictation is only a local text-entry convenience on browsers that support it.
- Production private temporary-object storage for large/background uploads, audio, and screen data.
- Production privacy, retention, diagnostics, support access, cost, capacity, regional residency, and incident-response evidence.
- Full representative device/OS/browser matrix. The current demo has automated server/desktop/web coverage, but production support claims still require dated real-device evidence.

## 5. Product Wording

Use this wording internally:

- "Phase 1 web demo core is usable."
- "Phone command, image attachment, browser dictation text entry, session selection, stream/projection, interrupt, history, pairing management, chat-level remote sessions, and server-local file/artifact transfer are implemented for the demo path."
- "Phase 2 live observation/control/voice/native production remains gated by evidence and explicit design decisions."

Do not use:

- "Full remote control is live."
- "Mobile Command Pro production release is ready."
- "All mobile platforms are supported."
- "Screen mirroring, OS input injection, production voice/ASR, push, or native app support is implemented."
