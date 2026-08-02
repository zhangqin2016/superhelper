# Durable Long Task Kernel Design

## Objective

Lily must execute useful agentic work for tens of hours without relying on one
unbounded model request. A task survives renderer reload, application restart,
engine restart, network interruption, host sleep, and worker completion while
the model is not running. Different owners, projects, and conversations remain
strictly isolated.

## Non-goals

- Keeping a model request open merely to claim a long duration.
- Replaying writes whose outcome is unknown.
- Building a distributed cloud scheduler. This kernel is local-first.
- Replacing OpenCode. OpenCode remains the reasoning engine.

## Architecture

The system has three independent lifetimes:

1. **Turn**: one bounded OpenCode reasoning loop.
2. **Task run**: a durable sequence of reasoning and worker stages.
3. **Worker job**: a deterministic local process with logs, progress and
   outputs.

The durable task run is the owner of the other two. A turn may start a worker
and sleep. A worker completion creates a durable wake event. The host admits one
idempotent continuation into the exact originating conversation. A fresh turn
then validates outputs and chooses the next stage.

## Persistence

`long-tasks.db` is the single source of truth for worker jobs and wake events.
SQLite WAL, transactions, compare-and-swap versions, fencing epochs and unique
idempotency keys replace the global `jobs.json` read/modify/write registry.

Every row carries:

- `owner_scope`, `session_id`, `project_id`, `turn_id`
- immutable command, cwd, process identity and creation time
- status, version, lease owner, lease expiry and fencing epoch
- progress sequence, last progress time and last observed time
- bounded health metadata, output paths and terminal result
- continuation policy and a unique wake idempotency key

The old JSON registry is imported once. Legacy rows are visible only through a
legacy local scope and never attached to a conversation automatically.

## Trusted Scope

The shared OpenCode MCP transport does not identify the originating Lily
conversation. Lily therefore signs a short-lived capability containing owner,
session, project, turn and allowed process-job operations. The token is injected
into that turn's protected guidance. The MCP verifies signature, expiry and
operation before every read or mutation. Scope fields are never accepted from
untrusted tool arguments.

List, status, logs and stop are filtered by the verified scope. A job cannot be
observed or stopped from another conversation, project or account.

## Worker Lifecycle

Workers start in a new process group. The persisted identity includes PID,
process-group ID, platform start fingerprint and a random launch nonce passed in
the environment. Liveness requires both PID and identity to match, preventing
PID reuse from attaching an unrelated process.

The worker writes stdout/stderr plus structured
`[lily-progress]` records. Progress sequence and log growth renew the progress
lease. Merely polling status does not. Logs are copy-truncated to a retained
tail under per-job and global quotas. Output paths are bounded and normalized.

Stopping targets the complete process group on POSIX and the complete process
tree on Windows. Graceful termination is followed by a bounded force kill.

## Long Turn Policy

There is no fixed one-hour termination for a progressing turn. The host uses:

- a no-progress window;
- an active-tool lease renewed only by real activity;
- repeated engine health probes;
- bounded step/depth/loop controls;
- an optional administrative absolute deadline, disabled by default.

The watchdog recovers official OpenCode output before aborting. Heartbeats that
do not prove progress never renew the progress lease.

## Restart And Sleep Recovery

At startup and after resume from sleep, the supervisor reconciles every
non-terminal job:

- matching live identity: reattach observation and renew supervisor lease;
- process exited with a terminal marker: finalize from the marker;
- process missing before any side effect: mark retryable;
- process missing after possible side effects: mark outcome unknown;
- expired competing lease: claim with a higher fencing epoch.

Accepted model turns remain outcome-unknown and are not blindly replayed.
Deterministic worker stages may be resumed only when their declared replay
policy and idempotency key allow it.

## Completion Wakeup

The main-process supervisor polls durable wake events independently of the
renderer. A successful worker job with continuation enabled creates one wake
event transactionally. The host submits one hidden, bounded continuation message
to the original conversation through durable turn admission. Unique keys make
restart and repeated polling harmless. Busy conversations queue the wake behind
their active turn; other conversations continue concurrently.

The continuation contains only job ID, terminal state, progress summary and
declared output paths. The new turn must inspect and verify outputs before
claiming completion.

## Resource Protection

- Per-job and global log quotas with rotation.
- Bounded registry retention and terminal-job pruning.
- Maximum output path count and metadata sizes.
- Disk-pressure checks before launch and during reconciliation.
- Health checks with timeouts and consecutive-failure thresholds.
- Explicit cancellation and terminal state immutability.

## Failure Semantics

- Store unavailable: process-job start fails closed; ordinary foreground tools
  remain available.
- Invalid/expired scope: fail closed without revealing whether a job exists.
- Supervisor unavailable: workers continue; startup reconciliation catches up.
- Wake admission unavailable: wake remains pending and retries later.
- Progress parser failure: raw logs remain available; no false progress renewal.
- Unknown side-effect outcome: require inspection or user decision, never replay.

## Verification

Automated tests must cover:

- virtual 48-hour progressing turn without forced termination;
- true no-progress and orphaned-tool termination;
- concurrent SQLite writers and fencing;
- owner/session/project isolation and forged/expired capabilities;
- parent/child process-tree stop;
- PID reuse rejection;
- log rotation and quota enforcement;
- worker survival/reconciliation across supervisor restart;
- exactly-once completion wake admission;
- busy-session queueing and multi-session concurrency;
- sleep/resume reconciliation;
- legacy registry migration;
- full capability gate and full unit suite.

## Shipping Gate

The feature is complete only when the durable worker path is the production
default, existing process-job callers use scoped tokens, the one-hour default
cap is removed, restart continuation is wired into application startup, and all
tests above are green. Environment-variable workarounds do not satisfy this
design.
