# Lily Mobile Command Pro Agent Bridge Contract

## 1. Purpose And Authority

This MC-SPEC-008 contract is the canonical semantic owner for injecting a mobile command into an existing Lily conversation and projecting that conversation back to mobile. Wire syntax remains owned by the OpenAPI and event schemas. Identity and revocation facts are owned by [MC-SPEC-007](mobile-command-auth-identity-contract.md), permission policy by [the threat model](mobile-command-permission-threat-model.md), and file transport by [the file-transfer contract](mobile-command-file-transfer-contract.md).

The bridge is an adapter around Lily's current local turn system, never a second agent runtime. It MUST preserve these repository facts:

- Today, `TurnOrchestrator.sendUserMessage(sessionId, text, files, opts)` in `src/main/turn-orchestrator.js` is the sole local turn-injection path. It does **not** currently provide crash-safe external idempotent admission. Production Mobile Command therefore requires the planned narrow `TurnOrchestrator.admitExternalCommand(envelope)` seam defined below; mobile code MUST NOT call `sendUserMessage`, a runner, OpenCode API, or `OpencodeAgentSession.sendUserMessage` directly.
- A Lily session has at most one active turn. Existing local UI callers may use today's steer-or-FIFO behavior. Remote admission uses the stricter deterministic queue rule below until the engine exposes command-ID idempotent steer acceptance and outcome lookup.
- Different Lily sessions may execute concurrently through the existing runner pool. The bridge MUST NOT add a global command lock.
- `RuntimeEventBus` and the orchestrator's normalized runtime events are the projection source. Raw engine events are prohibited.
- A turn's final artifact list is derived while `TurnArchive.buildRecord` seals the terminal record, using file changes, tool results, and assistant references. A live tool event is not proof that an artifact exists.

## 2. Non-Negotiable Invariants

1. Every accepted mobile command names exactly one existing `lilySessionId`; the authenticated remote session must be authorized for the exact desktop and mobile device tuple that owns the command.
2. Mobile Command never creates, resumes, mirrors, or writes a hidden second history. The local Lily transcript, turn archive, queue, and runtime sequence remain the only conversation truth.
3. A missing/deleted/unrecoverable target is a recoverable `SESSION_ABSENT` result. The bridge does not silently select the desktop's visible conversation and does not create a conversation. The user may explicitly create/select a task through the product flow and resend with its new ID.
4. Remote delivery uncertainty never becomes execution certainty. Only a successful local admission response may be reported as accepted/queued; `steered` is reportable only under the future proven engine capability gate below.
5. Remote failure cannot interrupt, downgrade, replace, or hide a healthy local Lily turn. Security ambiguity denies remote authority while local Lily remains usable.

## 3. Command Envelope And Admission

The semantic command envelope contains `commandId`, `idempotencyKey`, `remoteSessionId`, `mobileDeviceId`, `desktopDeviceId`, `lilySessionId`, `text`, verified staged attachment references, `mode` (`queue` or `steer`), client protocol version, signed sequence, and timestamp. The bridge validates the authenticated identity tuple, version, signature/replay state, payload limits, attachment state, and target session before calling the planned orchestrator admission seam. Validation alone is not admission.

### 3.1 Target Conversation Selection

- The mobile composer must display/select a Lily conversation and send its stable `lilySessionId` on every command. Reconnect does not infer a target from desktop focus.
- A history continuation uses the same ID. A remote session may observe more than one authorized conversation, but each command binds only one.
- `SESSION_ABSENT`, target ownership mismatch, and deleted/unrecoverable history are explicit non-admissions. No user message is committed and no runner is created.
- Desktop-side rename, focus, or session switch does not retarget an already signed command.

### 3.2 Active Turn, Queue, And Ordering

| Target state | Requested mode | Required outcome |
|---|---|---|
| idle | `queue` or `steer` | Atomically admit through `admitExternalCommand`; attach ownership metadata to the started turn/user record, then use the existing local turn start path. |
| active | `queue` | Append one item to that session's existing FIFO queue. |
| active | remote `steer` with current engine | Do **not** call `runner.steer`. Deterministically admit one durable FIFO item with `requestedMode=steer`, `effectiveMode=queue`, and `downgradeReason=STEER_IDEMPOTENCY_UNAVAILABLE`. |
| active | remote `steer` with future proven engine capability | Effective steer is allowed only after the engine can idempotently accept by `commandId`, query the durable acceptance outcome after reconnect/crash, and capability handshake plus automated crash/replay tests prove both. Otherwise use the row above. |
| another session active | either | Admit independently according to the target session state; do not wait on the other session. |

Ordering is per `lilySessionId`, not global. After validation, commands are admitted in the desktop bridge's monotonically received signed-sequence order. Existing desktop/queued items and remote items share one orchestrator FIFO; the bridge MUST NOT maintain a parallel queue. A queue item's stable remote `commandId`, idempotency key, payload hash, requested/effective mode, downgrade reason, and source ownership MUST be durable queue options/metadata and MUST survive `_tryStartQueuedItem` dispatch into the started turn/user record. Current steer-to-queue normalization retains the same `commandId` and ledger record, is visible to mobile, and is never a new command.

`runner.steer` is an external engine side effect outside the local session-store transaction. The current runner API accepts no `commandId` and provides no idempotent acceptance/outcome lookup. Calling it before local commit risks a side effect with no ledger; calling it after commit risks a crash-driven replay or an admitted command whose outcome cannot be reconciled. Therefore current remote steer is prohibited even when the runner is healthy. Queue is the capability-gate fail-open behavior: execution is delayed to the next normal turn but local Lily is never duplicated or weakened.

### 3.3 Crash-Safe Exact-Once Admission And Idempotency

The canonical deduplication ledger MUST live in the same durable local Lily session store and the same atomic session mutation/flush boundary as the only conversation history and queue. A server receipt, relay cache, or separate desktop database is not an admission record. `admitExternalCommand` is the only external admission entry and performs one serialized durable session mutation:

1. Load/recover the session ledger, queue, active-turn input, and committed user history together.
2. Look up `(desktopDeviceId, mobileDeviceId, idempotencyKey)`. A different canonical payload hash returns `IDEMPOTENCY_CONFLICT`; an existing matching record returns its stored state without calling the local send/start/steer path again.
3. Create the `pending` ledger record and transition it to `queued` or `started` while atomically attaching the same command metadata to the queue item or started turn plus committed user record. With today's engine, requested steer always creates `queued` with `effectiveMode=queue` and never invokes `runner.steer`. The `steered` state is reserved for the future proven engine gate.
4. Flush the ledger and queue/turn/history mutation together. Only successful durable flush may return accepted/queued. A future `steered` response additionally requires a queryable engine acceptance record keyed by the same `commandId`. There is no acknowledgement window between recording admission and recording its sole local-history destination.

Required ledger fields are: `schemaVersion`, `lilySessionId`, `commandId`, `idempotencyKey`, canonical `payloadHash`, `desktopDeviceId`, `mobileDeviceId`, `remoteSessionId`, signed source sequence, `requestedMode`, `effectiveMode`, nullable `downgradeReason`, state, `queueItemId` or `turnId`/committed-user reference, ownership/source, `createdAt`, `updatedAt`, terminal type/error reference, and `retainUntil`. Allowed states are `pending`, `queued`, `started`, future-gated `steered`, `completed`, `failed`, `interrupted`, `stalled`, and `rejected_conflict`; `pending` is internal and is never acknowledged before the atomic flush establishes its destination.

Every successful admission response MUST forward the persisted `commandId`, `idempotencyKey`, state and destination reference, and MUST forward/transform the ledger fields under these exact names: `requestedMode`, `effectiveMode`, and nullable `downgradeReason`. A current requested steer response therefore reports `{ requestedMode: "steer", effectiveMode: "queue", downgradeReason: "STEER_IDEMPOTENCY_UNAVAILABLE" }`; a normal queue reports `{ requestedMode: "queue", effectiveMode: "queue", downgradeReason: null }`. The mobile client MUST render these as distinct outcomes and MUST NOT label a downgraded steer as either a successful steer or an ordinary user-requested queue.

Crash semantics are normative:

- Crash before commit leaves neither ledger admission nor queue/turn/history mutation; same-key retry is safe.
- Crash after commit recovers the matching ledger plus its queue/turn/history destination and returns the stored state without a second send from the retry/admission path. If the durable destination is still `queued`, only the normal recovered FIFO dispatcher may perform its first local dispatch.
- If a caller cannot determine whether commit completed, it returns `DELIVERY_UNKNOWN`. Startup/reconnect MUST first recover and reconcile the ledger, queue, active turn, and committed history from that same session store. It MUST NOT call `sendUserMessage`/steer again while the state is indeterminate.
- An exact retry returns the recovered stored state and terminal reference. Reuse with different target, text, attachments, mode, or ownership has a different canonical hash and returns `IDEMPOTENCY_CONFLICT` without mutation.
- Crash before, during, or after current remote steer normalization cannot leave an engine-side steer because `runner.steer` is never called; recovery finds either no admission or the one durable queue item. For future effective steer, crash at each engine-call/ledger boundary MUST reconcile by querying the engine with `commandId`; an unknown outcome MUST queue neither a replay nor a second steer and must surface `DELIVERY_UNKNOWN` until query resolves.

Terminalization updates the ledger in the same durable turn-finalization mutation that seals the local terminal record. Terminal ledger records remain at least through the remote-session lifetime, event replay window, and reconnect/offline retry window. Cleanup is allowed only after `retainUntil`, no queue/active-turn/history reference remains unresolved, and the terminal archive is durable. Expiry never authorizes blind replay: an absent/ambiguous old key requires an explicit user-confirmed resend with a new key.

### 3.4 Cancellation And Priority Ownership

- A mobile device may cancel only its own still-queued command by `commandId`. It may request interruption of an active turn only when that turn was admitted from that same device and current policy grants that operation. A mobile cancel MUST NOT clear unrelated desktop or other-device queue items.
- The existing broad `TurnOrchestrator.interrupt()`/`interruptAndSend()` semantics clear or replace a session queue; they are therefore not directly exposed to mobile. A planned bridge adapter must enforce ownership and add/select a narrow orchestrator seam before invoking interruption.
- The desktop user owns the conversation and has highest priority: desktop stop, delete, rewind, local approval/denial, or local message wins over a concurrent remote request. Desktop stop may clear the local queue under existing behavior. Mobile receives the resulting projection and cannot undo it.
- Revoking a mobile device immediately blocks new commands, cancellation, answers, approvals, and reconnect. An already admitted local turn is not silently killed merely because its source device was revoked; Lily continues it locally unless the desktop user/policy explicitly interrupts it. Any pending remote-origin approval/question authority from that device is invalidated, and no further remote side effect may be authorized from it.

## 4. Projection Source And Common Envelope

The projector consumes only normalized Lily runtime events and sealed local records. Each projected event carries the authorized remote-session scope plus `lilySessionId`, `turnId` (nullable only where Lily permits it), Lily `eventId`, per-session `seq`, timestamp, projected type, schema version, and a redaction/version marker. Lily's `seq` is the ordering cursor; server relay sequence may supplement but never replace it.

Projection classifications mean:

- **Forwarded:** field meaning and value are preserved.
- **Transformed:** derived/renamed/bounded for mobile, with no added authority.
- **Redacted:** sensitive detail is replaced by an allowlisted summary.
- **Prohibited:** never leaves the desktop.

## 5. Event Projection Contract

| Lily source | Mobile projection | Field treatment | Required behavior |
|---|---|---|---|
| `user.committed`, `turn.started`, `turn.accepted`, `turn.steered`, `queue.updated` | non-terminal command/queue lifecycle | IDs, status, position and `requestedMode`/`effectiveMode` forwarded; nullable `downgradeReason` forwarded or transformed to an allowlisted code; raw local file paths redacted | `queue.updated` MUST include the three mode fields for every external item using the exact ledger names. `turn.started`, `turn.accepted`, and future-gated `turn.steered` preserve them. Correlate admission and the one local history; queue snapshots replace, not append to, mobile queue state. Mobile distinguishes downgraded steer from normal queue. |
| `turn.self_heal_retry`, `turn.self_heal_notice` | non-terminal recovery lifecycle | safe kind/error code transformed; internal probe/config detail redacted | These are post-terminal-allowed notices in the current runtime schema, not terminal events and not a new admission. |
| `assistant.delta` | assistant delta | text forwarded after output-policy filtering; event IDs/seq forwarded | Append exactly once by event ID/seq. Deltas are partial, never terminal. |
| `assistant.thinking.delta` | reasoning activity | raw text prohibited by default | Mobile gets at most transformed `reasoning_active`/phase metadata. Raw chain-of-thought, hidden prompts, and provider reasoning are never sent. A future explicit summarized-reasoning field requires a separate allowlisted contract. |
| `tool.started` | tool started | tool ID/name/title/status forwarded; input transformed to an allowlisted preview | Never forward environment, secrets, headers, tokens, raw shell payloads, or absolute paths. |
| `tool.input.delta`, `tool.input.done` | normally omitted/tool updated | raw/partial JSON prohibited; safe preview may be transformed | Input streaming is not a mobile data channel. |
| `engine.notice`, `task.step.progress`, `task.liveness.updated`, safe `process.event` | progress | code/phase/bounded progress transformed | Show liveness without claiming completion. Raw stdout/stderr and arbitrary process payloads are prohibited. |
| `tool.done` | tool terminal | ID/status/duration forwarded; result transformed/redacted | Send bounded allowlisted summary only. Tool failure does not itself terminalize the turn. |
| `permission.requested` | permission request | request ID, safe action/risk/resource summary, expiry transformed | Projection is informational until eligibility below is proven. Never expose raw model/tool input. |
| `user_question.requested` | question request | request ID, user-facing prompt/options transformed | Answers bind exact device, remote session, Lily session, turn, request, and pending generation. |
| `permission.resolved`, `permission.timeout`, `user_question.resolved` | request terminal | outcome/status forwarded; responder identity transformed | First valid terminal resolution wins; late/replayed responses are rejected and audited. |
| `context.compactionDecision`, compact boundary/failure notices | memory maintenance | action/status transformed; token counts optional/redacted | Never send compacted raw context, summaries containing private prompt/tool data, model identifiers, or resume IDs. Compaction failure remains non-terminal and local chat continues. |
| terminal archive/`assistant.final` plus exactly `turn.completed`, `turn.failed`, `turn.interrupted`, or `turn.stalled` | final answer and terminal | final assistant text, terminal status, safe error mapping forwarded/transformed | These four `turn.*` values are the complete current terminal set. Final text supersedes assembled deltas. Exactly one terminal state per turn. |
| sealed `record.artifacts` | artifact descriptors | opaque artifact ID, kind, display name, size and availability forwarded; path transformed/prohibited | Emit artifact availability only after terminal derivation/registration and authorization. Content/download uses the file contract. |

Always prohibited: device/private keys, bearer/refresh/TURN credentials, signing material, environment variables, system/developer prompts, raw reasoning, resume IDs, account/license internals not needed by UI, absolute/local paths, unrestricted tool input/result, raw stderr, clipboard/screen/file content outside its separately authorized channel, and events from another Lily session.

### 5.1 Permission, Question, And Approval Eligibility

The bridge may accept a remote response only if all are true at decision time: identity/grant/session/key/license are active; device is not revoked; event protocol is supported; request is still pending in the exact Lily session/turn; request ID and generation match; requester is eligible under the permission threat model; action is remotely answerable; and the desktop has not already resolved it. Sensitive operations and desktop-control grants require desktop-side approval and are never eligible for mobile self-approval. Hooks/internal runtime controls are desktop-only and are not projected as remotely actionable.

Eligibility is recomputed, not trusted from the earlier projection. Failure/timeout resolves deny or leaves the local desktop prompt authoritative according to local policy; it never defaults to allow. The bridge calls only `respondPermission` or `respondUserQuestion` after this gate. Desktop resolution has priority and late mobile replies return `NOT_PENDING`/stale without changing the turn.

### 5.2 Artifacts And Partial Failure

Artifacts are terminal-record facts, not guesses from streaming text. A descriptor is created from the sealed turn record and then resolved through the local artifact source. Registration or lookup failure emits `artifact_unavailable` while preserving the assistant answer and terminal turn. It never changes `turn.completed` to success-with-download, fabricates a URL, or deletes the local file. Temporary remote transfer failure is governed by the file contract and does not mutate the local registry.

If relay loss occurs after partial deltas/tools, the local turn continues and persists normally. Mobile marks the view disconnected/partial, keeps the last contiguous cursor, and on reconnect replaces provisional state with the desktop snapshot plus subsequent events. A partial assistant buffer is never presented as a completed answer; terminal archive text is authoritative.

### 5.3 Terminal Mapping

| Lily terminal | Mobile terminal | Retry semantics |
|---|---|---|
| `turn.completed` | `completed` | Final answer authoritative; missing artifact transfer is a separate recoverable failure. |
| `turn.failed` | `failed` | Forward safe code/category and retryability; redact stack/raw provider error. Never synthesize an assistant success. |
| `turn.interrupted` | `cancelled` | Preserve partial assistant text as explicitly partial; identify desktop/policy/mobile owner when safe. |
| `turn.stalled` | `stalled` | Preserve recoverable partial answer and require explicit resume/retry path; do not map to completed. |

## 6. Reconnect, Replay, And Snapshot

Reconnect requests an authorized snapshot for each subscribed `lilySessionId` with the last acknowledged Lily sequence. Before responding, desktop recovery reconciles the co-persisted command ledger with its queue/active-turn/committed-history/terminal references. The snapshot contains conversation identity/title metadata, current phase and active `turnId`, queue items visible to that device, recovered command admission states, safe active-turn state, pending requests with freshly computed eligibility, assembled safe assistant text, safe tool/progress states, last terminal record, authorized artifact descriptors, and a `snapshotSeq` boundary. Every external command/queue entry in the snapshot MUST include the exact same `requestedMode`, `effectiveMode`, and nullable `downgradeReason` values as its ledger and admission response. Snapshot recovery cannot erase or reinterpret the distinction between a requested steer downgraded to queue and a normal requested queue.

The client atomically applies the snapshot, discards provisional state beyond its old cursor, then applies events with `seq > snapshotSeq`. Duplicate `eventId` or `seq` is ignored. A gap, out-of-order event, unknown mandatory event, or replay older than retained history triggers another snapshot; it never guesses a transition. The in-memory bus's recent-event limit is an implementation detail, not a durability promise, so reconnect correctness must use persisted projection/turn data and current orchestrator state.

Version skew follows additive compatibility: unknown optional fields/events may be ignored; an unsupported mandatory schema/event, approval semantic, or redaction policy disables remote admission/action and returns `CLIENT_UPGRADE_REQUIRED`. It does not alter local Lily.

## 7. Failure Matrix

| Failure | Remote outcome | Local Lily invariant | Authorization rule |
|---|---|---|---|
| Relay loss before admission acknowledgement | `DELIVERY_UNKNOWN`; reconcile status/snapshot before retry | No assumed mutation; if admitted, the one local turn/queue remains truth | Never infer acceptance from server receipt. |
| Relay loss during turn | reconnecting/partial; replay or snapshot later | Turn, tools, persistence, and local UI continue | Pending remote authority is revalidated on reconnect. |
| Malformed/oversized mobile payload | reject `INVALID_COMMAND` before admission | No transcript, queue, runner, or history change | Unknown fields cannot become tool instructions or paths. |
| Injection/preflight failure | explicit recoverable/final admission error; no fake assistant result | Existing local session remains usable; orchestrator error is authoritative | Retry only under idempotency rules; never direct-call runner. |
| Target session absent/deleted | `SESSION_ABSENT`, user may explicitly choose/create another task | No hidden/new session and no retargeting | No authority transfer to desktop-current session. |
| Client/server/projector version skew | `CLIENT_UPGRADE_REQUIRED` or read-only projection | Local model/tools/history unchanged | Unknown security semantics disable remote mutation. |
| Artifact derivation/lookup/transfer failure | `artifact_unavailable` with retry path | Assistant terminal and local artifact/file remain intact | No fabricated URL or broadened path access. |
| Permission/question/approval timeout | timeout/denied/stale | Local prompt may remain/resolve under local owner; chat history preserved | Never auto-allow; late response rejected. |
| Event replay/duplicate command | ignore duplicate event/return the co-persisted local admission state | No duplicated text, queue item, tool, or side effect; never call the local send path twice | Payload-hash conflict rejects; indeterminate admission forces ledger/session recovery; event gap forces snapshot. |
| Remote `mode=steer` on current engine | accepted once as durable FIFO queue; expose `requestedMode=steer`, `effectiveMode=queue`, `downgradeReason=STEER_IDEMPOTENCY_UNAVAILABLE` | Active turn is untouched; exactly one later turn uses the same command ID/key | Never call `runner.steer`; queue is fail-open. |
| Future steer capability missing/fails handshake or outcome lookup | same deterministic queue normalization, or `DELIVERY_UNKNOWN` if a previously proven engine outcome is being reconciled | No duplicate engine side effect or hidden user record | Effective steer is disabled until capability and crash/replay tests pass again. |
| Device revoked during active turn | channel closed; no new response/cancel/command authority | Already admitted local turn continues unless desktop/policy stops it | Invalidate pending remote approvals/questions immediately. |

This is a mixed fail-open/fail-safe boundary: transport/projection failure **fails open to local Lily's current strong behavior**, while uncertain remote control, permission, identity, or replay state **fails safe by denying remote authority**.

## 8. Service And Client Boundaries

- Planned desktop `agent-bridge.js` owns validation and calls the planned public `TurnOrchestrator.admitExternalCommand` seam; it does not own a separate dedup ledger. The orchestrator/session store owns the atomic ledger+queue/turn/history admission, while the bridge owns correlation, ownership-aware cancellation, and snapshots.
- Planned `event-projector.js` owns allowlisting, redaction, cursoring, and terminal/artifact projection from normalized Lily state. It never parses raw OpenCode events.
- Planned `remote-api.js` is a domain facade over narrow exported `src/main/service-client.js` methods. Only `service-client.js` owns fetch, base/region selection, device signing/key access, and retry. No Mobile Command module imports private `serviceFetch` or signing helpers.
- Server relay authenticates, may cache transport delivery/ack cursors, and routes encrypted/signed envelopes; any relay deduplication is only an optimization and never proof of admission. The canonical command ledger is co-persisted with the local Lily session. The server does not become conversation truth, execute an agent, infer a terminal state, or approve local actions.
- Mobile client renders projections and submits signed intent. It does not merge histories, manufacture queue positions, resolve gaps heuristically, or treat cached eligibility as authority.

## 9. Verification Requirements

Implementation must add automated coverage for exact-once admission, idempotency conflict, target absence, per-session FIFO and cross-session concurrency, current remote steer never calling `runner.steer`, persisted requested/effective mode and downgrade reason, same-key replay producing one queue item, crash before/during/after normalization, future engine capability handshake and command-ID acceptance/outcome lookup, handshake/query failure returning to queue without duplicate side effects, ownership-scoped cancel, desktop priority, revoke-during-turn, delta/reconnect snapshot convergence, event replay/gaps, reasoning and secret redaction, tool lifecycle, approval eligibility/timeout/race, terminal mappings, artifact failure isolation, version skew, relay loss, and the capability-gate proof that every bridge failure preserves local Lily chat, tools, history, model, and artifacts.
