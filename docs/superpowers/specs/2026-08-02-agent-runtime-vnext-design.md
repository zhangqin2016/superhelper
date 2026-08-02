# Lily Agent Runtime vNext Design

Date: 2026-08-02
Status: Approved for implementation

## 1. Goal

Close Lily's remaining gap with top-tier coding agents without weakening its
existing local workbench capabilities. The runtime must provide request-level
isolation, durable multi-agent coordination, unified checkpoints, a stable
headless API, and a public hook contract while preserving OpenCode as the
owner of model history, model calls, native tools, permissions, and compaction.

## 2. Non-goals

- Do not replace OpenCode's agent loop or transcript.
- Do not move ordinary local work into a cloud service.
- Do not make multi-agent execution mandatory for normal turns.
- Do not replay shell commands or unknown tools automatically.
- Do not add a second conversation store or a second permission model.
- Do not break existing sessions, scheduled tasks, Character Worlds, mobile
  commands, runtime packs, skills, or native OpenCode resume behavior.

## 3. Architecture

The runtime is split into five bounded units that share versioned contracts.

```text
Desktop / Scheduler / Mobile / CLI / SDK
                   |
             Turn Admission
                   |
        Runtime Identity Envelope
                   |
          Durable Agent Task Graph
          /          |           \
      Lead Agent   Worker      Worker
          \          |           /
           Mailbox + Dependency Engine
                   |
       Session-scoped Tool Broker
                   |
       OpenCode + MCP + Skills + Hooks
                   |
       Runtime Event Log + Checkpoints
```

### 3.1 Runtime identity envelope

Every admitted execution receives one immutable envelope:

```js
{
  schemaVersion: 1,
  principalId,
  workspaceId,
  projectId,
  sessionId,
  turnId,
  taskRunId,
  agentId,
  attemptId,
  issuedAt,
  expiresAt,
  nonce,
  capabilities,
  signature
}
```

The host creates and signs the envelope. Tool processes receive only a bounded
opaque token. They resolve it through a host-owned context registry and cannot
select another session by sending arbitrary IDs. Tokens are short-lived,
single-runtime scoped, revocable, and validated for signature, expiry,
principal, workspace, session, and attempt.

Shared MCP processes remain possible, but context is resolved per request.
Platform-only tools use an explicit platform token; absence of identity never
silently upgrades a request to platform authority. Existing platform-only
behavior remains available behind a compatibility adapter during migration.

### 3.2 Durable agent task graph

A TaskRun owns a directed acyclic graph of agent tasks. Each node has one
objective, bounded context input, declared dependencies, lease state, attempt
history, output handoff, and terminal result. The graph supports:

- `blocked`, `ready`, `leased`, `running`, `waiting`, `completed`, `failed`,
  `cancelled`, and `orphaned` node states;
- compare-and-swap claims and expiring leases;
- automatic dependency release after successful prerequisites;
- bounded retry for explicitly replay-safe work;
- deterministic failure propagation and cancellation;
- per-session and global concurrency budgets without a global single-run lock;
- lead-to-worker and worker-to-lead mailboxes with durable acknowledgements;
- attach, steer, pause, resume, cancel, and retry control operations;
- compact worker handoffs instead of copying worker transcripts into the lead
  context.

Workers never nest recursively by default. A policy may allow a bounded second
level later, but the initial contract rejects it. Coding workers can receive a
separate Git worktree through a workspace adapter. Non-Git and non-code tasks
use an isolated scratch directory. Worktree creation is optional and failure
falls back to serialized execution only when that preserves correctness.

### 3.3 Unified checkpoints

A checkpoint is a manifest, not an implicit promise that all side effects can
be reversed. It atomically references:

- Lily session and turn boundary;
- OpenCode engine session and message boundary;
- TaskRun and task graph revisions;
- active worker leases and mailbox cursors;
- tracked file before/after manifests;
- recoverable process-job checkpoints;
- Character Worlds timed state references;
- tool-effect records and compensation metadata;
- runtime event sequence and integrity hash.

Checkpoint creation uses a prepare/commit protocol. A failed prepare leaves no
restorable checkpoint. Restore first validates every referenced component,
creates a pre-restore safety checkpoint, cancels live leases, restores only
owned reversible state, and records unresolved external effects. Fork creates
a new Lily session and TaskRun lineage while reusing immutable evidence and
file objects. External services, shell commands, payments, messages, and
unknown tools are never replayed or compensated without explicit semantics.

### 3.4 Headless CLI and SDK

Desktop, scheduler, mobile, CLI, and SDK use the same admission and event
contracts. The public CLI supports:

```text
lily run [prompt]
  --session <id>
  --resume <id>
  --workspace <path>
  --json
  --stream-json
  --allowed-tools <list>
  --denied-tools <list>
  --max-turns <n>
  --timeout <duration>
```

The stream is newline-delimited, versioned RuntimeEvent JSON. Process exit
codes distinguish success, user input required, permission denied, cancelled,
runtime unavailable, and task failure. The Node SDK is a thin adapter over the
same protocol and exposes async iteration, cancellation, steering, resume, and
checkpoint operations. It does not embed Electron APIs.

### 3.5 Public hook contract

Hooks observe or control documented lifecycle points:

- `session.start`, `session.end`;
- `turn.admitted`, `turn.before_dispatch`, `turn.completed`, `turn.failed`;
- `tool.before`, `tool.after`, `tool.failed`;
- `agent.spawned`, `agent.started`, `agent.waiting`, `agent.completed`;
- `checkpoint.before`, `checkpoint.after`, `checkpoint.restore`;
- `compaction.before`, `compaction.after`;
- `worktree.create`, `worktree.remove`.

Hook implementations may be command, HTTP, prompt, agent, or MCP-tool hooks.
Every hook declares timeout, authority, input schema, failure policy, and
whether it may mutate a bounded decision object. Observation hooks fail open.
Security and permission hooks fail closed. Hook output is untrusted input and
cannot directly mutate identity, tool authority, or persisted state.

## 4. Data ownership

- OpenCode owns model transcript, native compaction, provider calls, and native
  tool execution.
- Lily SessionManager owns product sessions and visible messages.
- Turn admission owns immutable identity and the initial intent snapshot.
- Agent task graph owns worker coordination, leases, dependencies, and
  handoffs.
- Runtime event persistence owns ordered observability.
- Checkpoint service owns restore manifests and lineage, not arbitrary external
  rollback.
- Tool broker owns per-request visibility and host-side authorization.

No component may infer identity from the currently focused UI session.

## 5. Persistence and migration

Schema changes are additive. New tables use a runtime schema version and keep
foreign identifiers as application-validated text because existing session
stores may be imported independently. Required tables are:

- `runtime_identity_grants` for revocation and audit metadata, never raw signing
  secrets;
- `agent_task_graphs`, `agent_tasks`, `agent_task_edges`, and
  `agent_task_attempts`;
- `agent_mailbox_messages` and durable cursors;
- `runtime_checkpoints`, `runtime_checkpoint_components`, and lineage;
- `runtime_hook_executions` for bounded audit and recovery.

Existing TaskRun data is lazily projected as a one-node graph. Existing
sessions do not require an eager rewrite. Existing platform-only MCP remains a
compatibility mode until every first-party call site supplies an envelope.

## 6. Failure and recovery rules

1. Identity failure denies the scoped tool call and does not expose another
   session's tools.
2. Event persistence failure cannot manufacture successful completion.
3. Lease expiry marks an attempt orphaned before another worker can claim it.
4. Retry requires tool semantics to prove replay safety; unknown means unsafe.
5. Worker failure returns a bounded handoff and does not poison the lead
   transcript.
6. Checkpoint restore validates integrity before changing live state.
7. CLI disconnect does not cancel durable work unless requested; clients can
   resume the event cursor.
8. Hook timeout follows its declared fail-open or fail-closed policy and emits
   an auditable event.
9. Every new subsystem has a kill switch that preserves today's strong single-
   agent path.

## 7. Security

- Runtime envelope signatures use a per-install secret held by the main
  process, with constant-time verification and key rotation support.
- Tokens are audience-bound to the broker/runtime process and include a nonce.
- Tool arguments cannot override envelope scope.
- Worker context is least-authority and receives only declared files, skills,
  tools, and evidence.
- Mailbox content is bounded, schema-validated, provenance-tagged, and treated
  as untrusted agent output.
- Hook commands inherit the existing environment allowlist and never receive
  cloud credentials by default.
- Audit records redact secrets and retain hashes for integrity checks.

## 8. Compatibility and rollout

Each unit is guarded independently:

- `LILY_RUNTIME_IDENTITY_V1=0`
- `LILY_AGENT_TASK_GRAPH=0`
- `LILY_UNIFIED_CHECKPOINTS=0`
- `LILY_HEADLESS_PROTOCOL_V1=0`
- `LILY_PUBLIC_HOOKS_V1=0`

The default single-agent turn remains byte-equivalent when the corresponding
feature is disabled or not requested. Rollout order is identity, graph,
checkpoints, CLI/SDK, then hooks. A later stage cannot bypass an earlier
stage's authority checks.

## 9. Verification

Automated gates must cover:

- two principals, ten sessions, scheduled and interactive turns under
  concurrent load with no cross-session context or tools;
- token forgery, expiry, replay, revocation, wrong audience, and wrong attempt;
- graph cycle rejection, dependency release, lease expiry, worker crash,
  cancellation, and idempotent retry;
- process crash and restart at each checkpoint prepare/commit boundary;
- restore and fork after file edits, worker completion, compaction, and partial
  external side effects;
- CLI JSON compatibility, cursor resume, cancellation, backpressure, and exit
  codes;
- hook timeout, malformed output, permission denial, recursion prevention, and
  secret redaction;
- unchanged native single-agent prompts, tools, model selection, permissions,
  Character Worlds, scheduling, mobile commands, and document workflows.

The full capability gate and architecture ratchet must pass. Live validation
adds an OpenCode multi-hour soak, forced process termination, sleep/wake,
network interruption, and concurrent scheduled-task stress test.

## 10. Delivery slices

1. Identity contract, signer/verifier, registry, broker resolution, migration,
   and isolation stress tests.
2. Task graph store, dependency engine, leases, mailbox, worker adapter,
   controls, and runtime projection.
3. Checkpoint manifest/store, file adapter, graph/session adapters, restore,
   fork, and recovery UI/IPC.
4. Shared headless service, CLI parser, NDJSON transport, Node SDK, and CI
   examples.
5. Hook registry, executor adapters, lifecycle wiring, policy UI/config, and
   audit viewer.

Every slice is independently releasable, test-first, migration-safe, and must
add its failure mode to `CAPABILITY-GATE.md` before it is considered complete.
