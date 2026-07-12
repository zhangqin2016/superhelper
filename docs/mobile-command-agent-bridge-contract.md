# Lily Mobile Command Pro Agent Bridge Contract

## 1. Purpose And Authority

This MC-SPEC-008 contract is the canonical semantic owner for injecting a mobile command into an existing Lily conversation and projecting that conversation back to mobile. Wire syntax remains owned by the OpenAPI and event schemas. Identity and revocation facts are owned by [MC-SPEC-007](mobile-command-auth-identity-contract.md), permission policy by [the threat model](mobile-command-permission-threat-model.md), and file transport by [the file-transfer contract](mobile-command-file-transfer-contract.md).

The bridge is an adapter around Lily's current local turn system, never a second agent runtime. It MUST preserve these repository facts:

- `TurnOrchestrator.sendUserMessage(sessionId, text, files, opts)` in `src/main/turn-orchestrator.js` is the sole command-injection entry point. Mobile code MUST NOT call a runner, OpenCode API, or `OpencodeAgentSession.sendUserMessage` directly.
- A Lily session has at most one active turn. A busy session uses its existing steer-or-FIFO-queue behavior; steer rejection or failure falls back to that same queue.
- Different Lily sessions may execute concurrently through the existing runner pool. The bridge MUST NOT add a global command lock.
- `RuntimeEventBus` and the orchestrator's normalized runtime events are the projection source. Raw engine events are prohibited.
- A turn's final artifact list is derived while `TurnArchive.buildRecord` seals the terminal record, using file changes, tool results, and assistant references. A live tool event is not proof that an artifact exists.

## 2. Non-Negotiable Invariants

1. Every accepted mobile command names exactly one existing `lilySessionId`; the authenticated remote session must be authorized for the exact desktop and mobile device tuple that owns the command.
2. Mobile Command never creates, resumes, mirrors, or writes a hidden second history. The local Lily transcript, turn archive, queue, and runtime sequence remain the only conversation truth.
3. A missing/deleted/unrecoverable target is a recoverable `SESSION_ABSENT` result. The bridge does not silently select the desktop's visible conversation and does not create a conversation. The user may explicitly create/select a task through the product flow and resend with its new ID.
4. Remote delivery uncertainty never becomes execution certainty. Only a successful local admission response may be reported as accepted/queued/steered.
5. Remote failure cannot interrupt, downgrade, replace, or hide a healthy local Lily turn. Security ambiguity denies remote authority while local Lily remains usable.

## 3. Command Envelope And Admission

The semantic command envelope contains `commandId`, `idempotencyKey`, `remoteSessionId`, `mobileDeviceId`, `desktopDeviceId`, `lilySessionId`, `text`, verified staged attachment references, `mode` (`queue` or `steer`), client protocol version, signed sequence, and timestamp. The bridge validates the authenticated identity tuple, version, signature/replay state, payload limits, attachment state, and target session before calling the orchestrator.

### 3.1 Target Conversation Selection

- The mobile composer must display/select a Lily conversation and send its stable `lilySessionId` on every command. Reconnect does not infer a target from desktop focus.
- A history continuation uses the same ID. A remote session may observe more than one authorized conversation, but each command binds only one.
- `SESSION_ABSENT`, target ownership mismatch, and deleted/unrecoverable history are explicit non-admissions. No user message is committed and no runner is created.
- Desktop-side rename, focus, or session switch does not retarget an already signed command.

### 3.2 Active Turn, Queue, And Ordering

| Target state | Requested mode | Required outcome |
|---|---|---|
| idle | `queue` or `steer` | Call `sendUserMessage`; start one normal Lily turn. |
| active | `queue` | Append one item to that session's existing FIFO queue. |
| active | `steer` and runner accepts | Commit the steering user message into the current turn only after engine acceptance; emit `turn.steered`. |
| active | `steer` unavailable/rejected/errors | Append once to the existing FIFO queue and return `steerFellBack`; do not commit an orphan message. |
| another session active | either | Admit independently according to the target session state; do not wait on the other session. |

Ordering is per `lilySessionId`, not global. After validation, commands are admitted in the desktop bridge's monotonically received signed-sequence order. Existing desktop/queued items and remote items share one orchestrator FIFO; the bridge MUST NOT maintain a parallel queue. A queue item's stable remote `commandId`/idempotency metadata must survive projection so reconnect can correlate it without changing queue order.

### 3.3 Idempotency

- `(desktopDeviceId, mobileDeviceId, idempotencyKey)` identifies one semantic command. The server/desktop deduplication record stores the canonical payload hash and admission result.
- An exact retry returns the prior result (`started`, `queued`, `steered`, rejected, or terminal reference) and MUST NOT call `sendUserMessage` again.
- Reuse with a different payload, target, attachments, or mode is `IDEMPOTENCY_CONFLICT` and is not admitted.
- A relay acknowledgement without a durable desktop admission result is `DELIVERY_UNKNOWN`, never “sent.” The client reconciles from snapshot/command status before retrying with the same key.
- Deduplication retention must cover the remote-session lifetime plus the event replay window. Expiry cannot authorize blind replay of a mutating command; an ambiguous expired record requires user-confirmed resend with a new key.

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
| `user.committed`, `turn.started`, `turn.accepted`, `turn.steered`, `queue.updated` | command/queue lifecycle | IDs, status, position forwarded; raw local file paths redacted | Correlate admission and the one local history; queue snapshots replace, not append to, mobile queue state. |
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
| terminal archive/`assistant.final` and `turn.*` | final answer and terminal | final assistant text, terminal status, safe error mapping forwarded/transformed | Final text supersedes assembled deltas. Exactly one terminal state per turn. |
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

Reconnect requests an authorized snapshot for each subscribed `lilySessionId` with the last acknowledged Lily sequence. The snapshot contains conversation identity/title metadata, current phase and active `turnId`, queue items visible to that device, safe active-turn state, pending requests with freshly computed eligibility, assembled safe assistant text, safe tool/progress states, last terminal record, authorized artifact descriptors, and a `snapshotSeq` boundary.

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
| Event replay/duplicate command | ignore duplicate event/return stored admission result | No duplicated text, queue item, tool, or side effect | Payload-hash conflict rejects; gap forces snapshot. |
| Device revoked during active turn | channel closed; no new response/cancel/command authority | Already admitted local turn continues unless desktop/policy stops it | Invalidate pending remote approvals/questions immediately. |

This is a mixed fail-open/fail-safe boundary: transport/projection failure **fails open to local Lily's current strong behavior**, while uncertain remote control, permission, identity, or replay state **fails safe by denying remote authority**.

## 8. Service And Client Boundaries

- Planned desktop `agent-bridge.js` owns validation-to-orchestrator admission, command correlation, ownership-aware cancellation, and snapshots. It delegates only to public orchestrator methods/seams.
- Planned `event-projector.js` owns allowlisting, redaction, cursoring, and terminal/artifact projection from normalized Lily state. It never parses raw OpenCode events.
- Planned `remote-api.js` is a domain facade over narrow exported `src/main/service-client.js` methods. Only `service-client.js` owns fetch, base/region selection, device signing/key access, and retry. No Mobile Command module imports private `serviceFetch` or signing helpers.
- Server relay authenticates, stores deduplication/ack cursors, and routes encrypted/signed envelopes; it does not become conversation truth, execute an agent, infer a terminal state, or approve local actions.
- Mobile client renders projections and submits signed intent. It does not merge histories, manufacture queue positions, resolve gaps heuristically, or treat cached eligibility as authority.

## 9. Verification Requirements

Implementation must add automated coverage for exact-once admission, idempotency conflict, target absence, per-session FIFO and cross-session concurrency, steer success/fallback, ownership-scoped cancel, desktop priority, revoke-during-turn, delta/reconnect snapshot convergence, event replay/gaps, reasoning and secret redaction, tool lifecycle, approval eligibility/timeout/race, terminal mappings, artifact failure isolation, version skew, relay loss, and the capability-gate proof that every bridge failure preserves local Lily chat, tools, history, model, and artifacts.
