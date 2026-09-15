# Session database safety verification — 2026-09-12

## Scope and result

The customer's screenshot alone does not establish the original cause of their
database error. This repair addresses independently reproduced code defects:
WAL-only commits lost on first migration, failed merges incorrectly archived,
interrupted compaction creating an empty store, and all open errors called corruption.

The changes preserve source data and recovery evidence. Initial migration now uses
a validated SQLite snapshot; the existing destination is never replaced. Failed
migration leaves the source discoverable for retry. Sources with a WAL retain
their original path so a still-running legacy client can continue safely.

Recovery of a missing primary runs before legacy merging and before store creation.
A backup must have a valid SQLite structure and expected message columns. Empty,
unrelated and damaged backups or orphan sidecars cannot silently become an empty
store. An existing damaged primary is not automatically replaced with a guessed
older backup. That requires customer-specific recovery evidence.

Diagnostics read sqlite_schema with a short lock timeout, classify extended SQLite
codes, distinguish file access failures from JSON syntax errors, expose missing
primaries with recovery evidence, and describe successful checks as basic reads.
They no longer recommend deleting files.

## Test evidence

- `scripts/test-session-db-safety.mjs`: initial seven regressions failed against
  the old code. Three independent-review recovery cases also failed before their
  fixes. The orphan-journal regression failed before its fix.
- All 15 final safety cases pass on macOS system Node 22.19.0 and the installed
  Electron runtime in Node mode. Cases use actual SQLite databases, process
  termination, active WAL writers, real exclusive locks, and injected publication
  failure; extended error-code checks use an injected diagnostic reader.
- Existing migration, compaction, message store (98 checks), session-load recovery,
  diagnostic, diagnostic UI and diagnostic i18n checks pass.
- Architecture boundaries pass after extracting message migration into its own
  module. The line budgets were not increased.
- Independent review reproduced and caught three recovery-order/schema issues;
  they were fixed and reviewed again. Its 13-case run preceded the two final
  orphan-journal/live-writer additions, which were verified locally.
- `npm run test:unit` in the restricted environment: 840/930 passed in 306s.
  Failures: 51 Electron SIGABRT, 36 EPERM, one Electron profile-host early exit,
  one LibreOffice startup failure and one architecture limit subsequently fixed.
  Native-permission rerun completed: **932/932 passed in 517s**, exit code 0.
  The discovery count differs because other tasks added tests in this shared tree.
- Final separate capability-registry recheck is **not green**: the concurrently
  edited `task-completion-integrity` documentation row is missing
  `test-task-continuity-integration.mjs`. Earlier checks also observed an unrelated
  `conversation-render-order` anchor without registration. These other tasks'
  changes were preserved. The successful full run is not a claim that the later
  shared-tree state is release-ready.
- Run logs: `/tmp/lily-db-safety-full-suite.log` (restricted environment),
  `/tmp/lily-db-safety-full-suite-native.log` (native-permission rerun), and
  `/tmp/lily-db-safety-focused.log` (final Node safety cases).

## Acceptance limits

No installer has been built or published. Native Windows filesystem behavior,
physical power loss, and the customer's actual database have not been validated.
The snapshot file is flushed, and its destination directory is flushed on POSIX;
Windows directory durability is not claimed. An unsupported filesystem's atomic
publication failure retains the source rather than falling back to unsafe copying.

The full suite runs in a shared working tree with other unrelated edits; results
are repository-wide evidence, not an isolated release-branch acceptance claim.

References: [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html) and
[SQLite corruption causes](https://www.sqlite.org/howtocorrupt.html).
