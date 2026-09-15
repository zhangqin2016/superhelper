# Database self-recovery verification — 2026-09-13

## Implemented

Worker startup preflight, native journal recovery with retained evidence,
verified four-point rolling backups with six-hour throttling, explicit snapshot
confirmation, interrupted replacement resumption, original/journal retention,
durable restored-task fencing, independent recovery UI, local diagnostic export
and truthful version fallback. Existing uncommitted migration/compaction safety
work is a dependency, not a separately shipped release.

## Evidence

- TDD failures were observed before the worker service, flow, native UI, startup
  integration and restored-task fence implementations. Review regressions also
  failed before fixes: retained receipt suppressing new work; historical snapshot
  date/ranking; corrupt backups consuming retention slots; partial publication
  blocking every retry; torn header hiding a valid hot journal; persistent
  permission errors losing their category.
- `test-database-recovery.mjs`: **25 real SQLite cases pass** in system Node
  22.19.0 and Electron's Node 24.15.0 runtime. Faults use temporary files, actual exclusive locks, SIGKILL-generated
  journals, WAL commits, and injected filesystem boundaries, not customer files.
- Service, flow, actual-source startup fault injection, and restored-task-fence
  tests pass. The latter reopens SQLite and checks that receipt acknowledgement
  failure cannot quarantine newly admitted work again.
- Real Electron UI/preload/IPC test passes: cancel, confirmed restore, explicit
  continue, three-language text, RTL, 480px layout, local diagnostic export and
  rejection of calls from a different renderer window.
- Real `src/main.js` startup and worker test passes with a synthetic damaged
  temporary profile: normal startup is gated, version remains available,
  cancellation leaves bytes unchanged, confirmed restore recovers the expected
  record and retains original bytes. Native confirmation response is scripted;
  this test stops before entering the full workbench after recovery.
- Existing session DB safety (15 cases), compaction, legacy migration, message
  store (98 checks), session-load recovery, support diagnostics and turn
  orchestrator tests pass. Architecture boundaries and i18n leak checks pass.
- Full discovery run: **937/940 passed in 449 seconds**, exit 1. Its storage and
  i18n failures occurred while this task was still adding regression fixes; both
  were fixed and rerun successfully afterward. Do not describe that run as
  940/940. Log: `/tmp/lily-database-self-recovery-suite.log`.
- Remaining global registry failure: concurrently added **`upstream-model-auth-failure`**
  documentation anchor has no registry entry. This task's own gate is registered.
  Unrelated authentication, renderer ordering and version edits were preserved.
- Independent specification review approved after two findings were fixed;
  independent code-quality review approved after three further recovery boundary
  findings were fixed and its 23-case rerun passed. The persistent permission
  case and actual Electron fixture compatibility were verified afterward. A final
  scoped review independently reran all 25 cases and approved the authoritative
  restore-time refusal of healthy/locked/inaccessible databases.

## Not claimed

No commit, push, installer build or release was performed. Native Windows file
locking/durability, physical power loss, the customer's actual database and a
signed updated installation remain unverified. Without a valid snapshot or
recoverable journal, severely damaged data may still require specialist recovery.
Only verified automatic snapshots are rotated, never damaged customer evidence.
