# Scheduled Task Isolation and Reliability

## Goal

Scheduled tasks must execute for the account, workspace, and conversation that
created them, regardless of which conversation is active later. Concurrent
tasks must not share agent history, exceed bounded capacity, or execute the same
occurrence twice.

## Trust model

- Identity and scope come from the Electron main process, never model arguments.
- A task has immutable `ownerPrincipal`, `projectId`, and `originSessionId`.
- Shared platform MCP processes have no conversation identity. They may not
  create or list scheduled tasks.
- IPC resolves a real session and derives its project. A caller-provided project
  must match that relationship.
- Every list, mutation, and execution is filtered by the current principal.

Logged-in principals use `user:<user-id>`. Offline work uses the stable
`device:<device-id>` principal. Account switching does not transfer ownership.

## Execution model

Each task owns a hidden automation session. Scheduled turns run only in that
session, so task history cannot enter the user's conversation or another task.
The final result is published to the immutable origin session with task/run
metadata.

The host creates one run occurrence per `(task, scheduledFor)` key. Claims are
transactional and carry a lease. A bounded scheduler admits at most three runs
at once. The default overlap policy is `queue`: a second occurrence for the same
task remains pending while one is queued or running.

Manual runs use a unique manual occurrence and may use the interactive session
permission mode. Unattended runs always use `plan`. Queued turns must preserve
that permission mode.

## Persistence and recovery

Tasks and runs live in SQLite with WAL enabled. Status changes, occurrence
creation, and leases are transactional. On startup, expired queued/running
leases become interrupted and can no longer block later occurrences.

Legacy `scheduled-tasks.json` is imported once. It is renamed only after a
successful transaction. Invalid JSON is retained and reported; it is never
overwritten with an empty schedule.

## State model

Task states are derived from enabled state plus active runs:

- `scheduled`: enabled and no active run
- `queued`: occurrence exists but has not started
- `running`: agent turn started
- `paused`: disabled

Pausing does not rewrite an active run. Re-enabling cannot create a duplicate
for an existing occurrence. Removing a task with an active run is rejected.

Run terminal states are `succeeded`, `failed`, `interrupted`, `cancelled`, and
`skipped`.

## Acceptance criteria

- Switching conversations between request and execution cannot change scope.
- A mismatched session/project pair is rejected.
- Different account principals cannot see, mutate, or execute each other's tasks.
- Two tasks execute in separate hidden sessions and publish to their own origins.
- One hundred due tasks respect the global concurrency limit.
- Pause/resume and repeated ticks cannot duplicate an occurrence.
- Queued unattended work remains in `plan` mode.
- Restart recovery handles expired leases without corrupting task state.
- Corrupt legacy JSON remains recoverable.
