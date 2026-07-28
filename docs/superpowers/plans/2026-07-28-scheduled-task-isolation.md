# Scheduled Task Isolation Implementation Plan

1. Add regression tests for trusted scope, principal isolation, hidden execution
   sessions, duplicate prevention, concurrency limits, permission propagation,
   lease recovery, and corrupt legacy persistence.
2. Add a SQLite scheduled-task store with transactional task/run operations and
   one-time legacy JSON migration.
3. Refactor `ScheduledTaskManager` to use immutable ownership, validate
   session/project relationships, claim occurrences, enforce concurrency, and
   complete runs by run ID.
4. Add hidden automation-session creation and exclude those sessions from normal
   conversation lists and active-session fallback.
5. Publish terminal results to the origin session and preserve unattended
   permission mode through the turn queue.
6. Harden scheduled-task IPC scope checks and remove unscoped scheduled-task
   tools from the shared platform MCP bridge.
7. Add the behavior to `CAPABILITY-GATE.md`, run focused tests, the complete test
   suite, and a final source review.
