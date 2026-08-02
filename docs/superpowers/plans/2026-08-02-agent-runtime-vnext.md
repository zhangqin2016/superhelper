# Agent Runtime vNext Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add request-scoped runtime identity, durable agent task graphs, unified checkpoints, a stable headless API/SDK, and public lifecycle hooks without changing Lily's default single-agent behavior.

**Architecture:** Keep OpenCode as the model and transcript runtime. Add small Lily-owned contract modules around admission, broker authorization, TaskRun coordination, checkpoint manifests, and RuntimeEvent streaming. Every subsystem is additive, versioned, kill-switchable, and guarded by focused failure-mode tests before production wiring.

**Tech Stack:** Node.js CommonJS/ESM, Electron main process, `node:crypto`, `node:sqlite`, MCP SDK, OpenCode plugins, NDJSON.

---

## File Map

New runtime modules:

- `src/main/runtime-identity.js`: canonical identity envelope, HMAC signing,
  verification, scope checks, and redaction.
- `src/main/runtime-identity-registry.js`: atomic engine-session-to-token registry
  consumed by the OpenCode plugin.
- `resources/opencode-plugins/runtime-identity.js`: injects the current signed
  token into Lily broker calls before execution.
- `src/main/agent-task-graph.js`: pure graph validation and state machine.
- `src/main/store/agent-task-graph-store.js`: durable graph, attempt, lease, and
  mailbox persistence.
- `src/main/runtime-checkpoint.js`: canonical manifest and integrity hashing.
- `src/main/store/runtime-checkpoint-store.js`: checkpoint prepare/commit,
  lineage, and restoration state.
- `src/main/public-hooks.js`: hook registry, policy, execution, timeout, and
  bounded decisions.
- `src/sdk/index.js`: public Node adapter for RuntimeEvent NDJSON.

Existing integration points:

- `src/main/mcp/tool-broker-mcp.js` and `tool-broker-registry.js`: request-level
  token extraction, verification, stripping, and tool visibility.
- `src/main/session-runner-pool.js`: install the identity plugin and pass stable
  registry configuration to the shared serve.
- `src/main/opencode-agent-session.js`: register/revoke engine-session grants.
- `src/main/task-run-runtime.js`: lazily project a TaskRun into a one-node graph.
- `src/main/store/schema.js`: additive graph/checkpoint/hook migrations.
- `src/shared/runtime-contract.json`: versioned agent/checkpoint/hook events.
- `scripts/lily-headless.mjs`: stable CLI arguments, NDJSON, exit codes, resume,
  and cancellation.
- `package.json`: expose `lily` bin and SDK export.
- `CAPABILITY-GATE.md`: register each closed-loop failure mode.

## Task 1: Request-scoped runtime identity

**Files:**
- Create: `src/main/runtime-identity.js`
- Create: `src/main/runtime-identity-registry.js`
- Create: `resources/opencode-plugins/runtime-identity.js`
- Create: `scripts/test-runtime-identity.mjs`
- Create: `scripts/test-runtime-identity-plugin.mjs`
- Modify: `src/main/mcp/tool-broker-mcp.js`
- Modify: `src/main/mcp/tool-broker-registry.js`
- Modify: `src/main/session-runner-pool.js`
- Modify: `src/main/opencode-agent-session.js`

- [ ] **Step 1: Write failing identity tests**

Cover canonical signing, tampering, expiry, audience mismatch, session mismatch,
revocation, redaction, registry atomicity, and plugin injection:

```js
const token = issueRuntimeIdentity(identity, { secret, audience: "tool-broker", now: 1000 });
assert.equal(verifyRuntimeIdentity(token, { secret, audience: "tool-broker", now: 1001 }).sessionId, "s1");
assert.throws(() => verifyRuntimeIdentity(`${token}x`, { secret, audience: "tool-broker", now: 1001 }), /INVALID_SIGNATURE/);
assert.throws(() => verifyRuntimeIdentity(token, { secret, audience: "other", now: 1001 }), /AUDIENCE_MISMATCH/);
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
node scripts/test-runtime-identity.mjs
node scripts/test-runtime-identity-plugin.mjs
```

Expected: module-not-found failures for the new runtime modules.

- [ ] **Step 3: Implement identity and registry modules**

Expose these stable functions:

```js
issueRuntimeIdentity(identity, options) -> string
verifyRuntimeIdentity(token, options) -> frozen identity
redactRuntimeIdentity(identity) -> audit-safe object
createRuntimeIdentityRegistry(options) -> { grant, revoke, resolve, prune }
```

Use base64url canonical JSON and HMAC-SHA256. Validate bounded string fields,
timestamps, nonce, capabilities, audience, and schema version. Compare signatures
with `crypto.timingSafeEqual`. Registry writes use temp-file plus rename and
never persist the secret.

- [ ] **Step 4: Integrate request authorization**

Add optional internal input field `__lilyRuntimeToken` to broker tool schemas.
The OpenCode plugin reads the engine session token from the registry and writes
it into `output.args` only for `lily_tool_broker_*` / `lily_tb_*` calls. Broker
callbacks extract and delete it before invoking handlers, verify it, and derive
context from the envelope. Invalid scoped tokens fail closed. With
`LILY_RUNTIME_IDENTITY_V1=0`, current platform-only behavior remains unchanged.

- [ ] **Step 5: Run focused and broker regression tests**

```bash
node scripts/test-runtime-identity.mjs
node scripts/test-runtime-identity-plugin.mjs
node scripts/test-tool-broker-registry.mjs
node scripts/test-mcp-config.mjs
node scripts/test-opencode-agent-session.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/runtime-identity.js src/main/runtime-identity-registry.js resources/opencode-plugins/runtime-identity.js scripts/test-runtime-identity.mjs scripts/test-runtime-identity-plugin.mjs src/main/mcp/tool-broker-mcp.js src/main/mcp/tool-broker-registry.js src/main/session-runner-pool.js src/main/opencode-agent-session.js
git commit -m "feat: add request-scoped runtime identity"
```

## Task 2: Durable agent task graph and mailbox

**Files:**
- Create: `src/main/agent-task-graph.js`
- Create: `src/main/store/agent-task-graph-store.js`
- Create: `scripts/test-agent-task-graph.mjs`
- Create: `scripts/test-agent-task-graph-store.mjs`
- Modify: `src/main/store/schema.js`
- Modify: `src/main/task-run-runtime.js`
- Modify: `src/main/subagent-runtime-projection.js`
- Modify: `src/shared/runtime-contract.json`

- [ ] **Step 1: Write failing graph tests**

Test cycle rejection, dependency release, CAS lease claims, lease expiry,
orphaning, retry policy, cancellation propagation, mailbox ordering,
acknowledgement, and two sessions claiming independent work concurrently.

```js
const graph = createAgentTaskGraph({ taskRunId: "run-1", sessionId: "s1" });
addAgentTask(graph, { id: "a", objective: "collect evidence" });
addAgentTask(graph, { id: "b", objective: "summarize", dependsOn: ["a"] });
assert.equal(claimReadyTask(graph, { workerId: "w1", now: 1 }).taskId, "a");
completeAgentTask(graph, "a", { handoff: "evidence", now: 2 });
assert.equal(graph.tasks.b.status, "ready");
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
node scripts/test-agent-task-graph.mjs
node scripts/test-agent-task-graph-store.mjs
```

- [ ] **Step 3: Implement the pure graph state machine**

Use explicit transitions and reject illegal transitions. Keep objectives and
handoffs bounded. Reject recursive worker depth above one, self-dependencies,
duplicate edges, cycles, and cross-session edges. Retry only when the caller
passes `replaySafe: true` and remaining attempts are positive.

- [ ] **Step 4: Implement additive SQLite persistence**

Append migrations for graphs, tasks, edges, attempts, and mailbox messages.
Use transactions for graph creation, claims, completion plus dependency release,
and mailbox acknowledgement. Claims update only when revision and lease state
match, so concurrent workers cannot both win.

- [ ] **Step 5: Project existing TaskRuns**

When the graph feature is enabled and a TaskRun starts, lazily create one lead
node. Convert OpenCode Task child telemetry into worker attempt events when
identifiers exist; otherwise preserve current telemetry without inventing a
worker. Add versioned `agent.*` and `agent.mailbox.*` RuntimeEvents.

- [ ] **Step 6: Verify**

```bash
node scripts/test-agent-task-graph.mjs
node scripts/test-agent-task-graph-store.mjs
node scripts/test-task-run-kernel.mjs
node scripts/test-subagent-runtime-projection.mjs
node scripts/test-runtime-event-schema.mjs
```

- [ ] **Step 7: Commit**

```bash
git add src/main/agent-task-graph.js src/main/store/agent-task-graph-store.js scripts/test-agent-task-graph.mjs scripts/test-agent-task-graph-store.mjs src/main/store/schema.js src/main/task-run-runtime.js src/main/subagent-runtime-projection.js src/shared/runtime-contract.json
git commit -m "feat: add durable agent task graph"
```

## Task 3: Unified checkpoints and forks

**Files:**
- Create: `src/main/runtime-checkpoint.js`
- Create: `src/main/store/runtime-checkpoint-store.js`
- Create: `scripts/test-runtime-checkpoint.mjs`
- Create: `scripts/test-runtime-checkpoint-store.mjs`
- Modify: `src/main/store/schema.js`
- Modify: `src/main/diff-capture.js`
- Modify: `src/main/session-manager.js`
- Modify: `src/shared/runtime-contract.json`

- [ ] **Step 1: Write failing manifest and crash-boundary tests**

Verify canonical hashes, prepare/commit idempotency, corrupt-component rejection,
pre-restore safety checkpoints, fork lineage, active-lease cancellation, and
explicit unresolved effects.

```js
const prepared = store.prepare({ sessionId: "s1", turnId: "t1", components });
assert.equal(store.get(prepared.id).status, "preparing");
store.commit(prepared.id, prepared.integrityHash);
assert.equal(store.get(prepared.id).status, "committed");
assert.throws(() => store.commit(prepared.id, "wrong"), /INTEGRITY/);
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
node scripts/test-runtime-checkpoint.mjs
node scripts/test-runtime-checkpoint-store.mjs
```

- [ ] **Step 3: Implement manifests and persistence**

Canonicalize component descriptors, hash the manifest, and store components in
the same transaction as prepare. Commit uses status and hash CAS. Restore has
`validating`, `restoring`, `restored`, and `failed` states. It records external
effects as unresolved unless a registered adapter declares reversible behavior.

- [ ] **Step 4: Add session/file adapters**

Expose current diff-capture snapshots as checkpoint components instead of
copying arbitrary workspace trees. Reuse OpenCode `revert`/`unrevert` for engine
history. Restore invalidates Character Worlds timed checkpoints through the
existing session rewind path. Fork creates a new Lily session and records parent
checkpoint lineage without mutating the source session.

- [ ] **Step 5: Verify**

```bash
node scripts/test-runtime-checkpoint.mjs
node scripts/test-runtime-checkpoint-store.mjs
node scripts/test-diff-capture.mjs
node scripts/test-session-manager.mjs
node scripts/test-character-worlds-capability-gate.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/main/runtime-checkpoint.js src/main/store/runtime-checkpoint-store.js scripts/test-runtime-checkpoint.mjs scripts/test-runtime-checkpoint-store.mjs src/main/store/schema.js src/main/diff-capture.js src/main/session-manager.js src/shared/runtime-contract.json
git commit -m "feat: add unified runtime checkpoints"
```

## Task 4: Public CLI and Node SDK

**Files:**
- Create: `src/sdk/index.js`
- Create: `scripts/test-lily-sdk.mjs`
- Modify: `scripts/lily-headless.mjs`
- Modify: `scripts/test-headless-runner.mjs`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Write failing protocol tests**

Test argument validation, single JSON output, NDJSON ordering, cursor resume,
backpressure, signal cancellation, timeout, allowed/denied tools, max turns,
and documented exit codes without spawning a live model.

- [ ] **Step 2: Confirm RED**

```bash
node scripts/test-headless-runner.mjs
node scripts/test-lily-sdk.mjs
```

- [ ] **Step 3: Extract a reusable headless client**

The SDK exports:

```js
createLilyClient(options)
client.run(input) -> AsyncIterable<RuntimeEvent>
client.resume(input) -> AsyncIterable<RuntimeEvent>
client.cancel(taskRunId)
client.steer(taskRunId, text)
client.checkpoint(taskRunId)
```

The CLI becomes argument parsing plus output formatting around this client.
NDJSON lines carry `protocolVersion`, monotonic `cursor`, event type, identity
references, timestamp, and payload. Unknown fields remain forward-compatible.

- [ ] **Step 4: Add package surface and docs**

Expose `lily` in `bin`, keep the existing `npm run headless`, and document
examples for interactive text, JSON, stream-json, resume, cancellation, and CI.

- [ ] **Step 5: Verify**

```bash
node scripts/test-headless-runner.mjs
node scripts/test-lily-sdk.mjs
npm run test:unit
```

- [ ] **Step 6: Commit**

```bash
git add src/sdk/index.js scripts/test-lily-sdk.mjs scripts/lily-headless.mjs scripts/test-headless-runner.mjs package.json README.md
git commit -m "feat: publish Lily headless protocol and SDK"
```

## Task 5: Public lifecycle hooks

**Files:**
- Create: `src/main/public-hooks.js`
- Create: `scripts/test-public-hooks.mjs`
- Modify: `src/main/turn-orchestrator.js`
- Modify: `src/main/turn-terminal-finalizer.js`
- Modify: `src/main/task-run-runtime.js`
- Modify: `src/shared/runtime-contract.json`

- [ ] **Step 1: Write failing hook tests**

Cover registration validation, observation fail-open, security fail-closed,
timeouts, malformed output, decision schema bounds, recursion prevention,
secret redaction, and lifecycle event ordering.

- [ ] **Step 2: Confirm RED**

```bash
node scripts/test-public-hooks.mjs
```

- [ ] **Step 3: Implement registry and executor**

Support command, HTTP, prompt, agent, and MCP adapters through injected
executors. The core never shells out or calls a model directly. It validates
hook declarations and passes a frozen, redacted event envelope. A mutable hook
returns only a bounded `{ allow, reason, contextAppend }` decision.

- [ ] **Step 4: Wire lifecycle events**

Wire turn admission/dispatch/terminal paths and agent/checkpoint services.
Existing OpenCode permission and verification hooks remain unchanged. Prevent a
hook-triggered action from recursively invoking the same hook execution chain.

- [ ] **Step 5: Verify**

```bash
node scripts/test-public-hooks.mjs
node scripts/test-turn-orchestrator.mjs
node scripts/test-turn-terminal-narrative.mjs
node scripts/test-task-run-kernel.mjs
node scripts/test-runtime-event-schema.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/main/public-hooks.js scripts/test-public-hooks.mjs src/main/turn-orchestrator.js src/main/turn-terminal-finalizer.js src/main/task-run-runtime.js src/shared/runtime-contract.json
git commit -m "feat: add public agent lifecycle hooks"
```

## Task 6: Capability gate and system verification

**Files:**
- Create: `scripts/test-agent-runtime-isolation-stress.mjs`
- Create: `scripts/test-agent-runtime-recovery.mjs`
- Modify: `CAPABILITY-GATE.md`

- [ ] **Step 1: Add isolation and recovery stress tests**

Run two principals, ten sessions, interactive plus scheduled admission, worker
lease expiry, broker calls, checkpoint prepare/commit interruption, CLI cursor
resume, and hook timeout. Assert no context, mailbox, grant, event, or file
component crosses session boundaries.

- [ ] **Step 2: Register closed-loop failure modes**

Add separate capability-gate rows for runtime identity, agent graph,
checkpoints, headless protocol, and public hooks. Each row names its kill switch
and fail-open baseline.

- [ ] **Step 3: Run focused stress tests**

```bash
node scripts/test-agent-runtime-isolation-stress.mjs
node scripts/test-agent-runtime-recovery.mjs
```

- [ ] **Step 4: Run full verification**

```bash
npm run test:unit
npm run test:renderer
npm run test:runtime
npm run test:service
npm run test:skills
node scripts/run-capability-gate.mjs
git diff --check
```

Expected: all automated gates pass. Live OpenCode soak, forced sleep/wake, and
network interruption are reported separately and never replaced by unit-test
claims.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-agent-runtime-isolation-stress.mjs scripts/test-agent-runtime-recovery.mjs CAPABILITY-GATE.md
git commit -m "test: close agent runtime capability gates"
```
