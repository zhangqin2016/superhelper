# Session database safety repair

Goal: preserve committed local history during migration and interrupted compaction,
and report storage errors without recommending destructive recovery.

Architecture: a synchronous SQLite snapshot helper reads the source with WAL,
validates the resulting standalone database, flushes it, and publishes without
overwriting an existing destination. Failed migrations retain the legacy root.
Interrupted compaction restores only a validated backup when the primary is absent;
ambiguous sidecars or invalid backups stop opening rather than create an empty DB.
Diagnostics use bounded schema reads and SQLite error categories, not SELECT 1
or an unqualified claim of whole-database integrity.

Tech stack: existing Node/Electron node:sqlite and filesystem APIs; no dependency.

- [x] Add real SQLite regressions for WAL-only commits, failed copy/retry,
  destination collision, corrupt source, interrupted compaction and lock diagnosis.
- [x] Implement snapshot helper and use it for the first messages.db migration;
  propagate merge failures to prevent archiving evidence. Preserve source data.
- [x] Restore interrupted compaction before MessageStore can create an empty file;
  leave ambiguous/invalid recovery files intact. Retain existing WAL swap guards.
- [x] Classify corruption, locks, access, space and I/O failures; remove delete advice.
- [x] Run focused storage/migration/diagnostic tests, then repository suites;
  record failures and platform limitations without claiming customer recovery.

No automatic replacement of an existing damaged database: without the customer's
data and backup provenance, selecting a recovery source could discard newer work.
No release or installer publication is included in this code repair.

Verification: all 15 focused SQLite safety cases pass in Node and Electron Node
mode; the native full discovery run passed 932/932. A subsequent registry check
found unrelated concurrent gate-document edits inconsistent with their test list.
See `docs/session-database-safety-verification.md` for full results and limits.

References: https://www.sqlite.org/lang_vacuum.html and
https://www.sqlite.org/howtocorrupt.html (consistent snapshots and journal pairing).
