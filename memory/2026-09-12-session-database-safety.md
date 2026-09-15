# Session database safety

Customer screenshot: messages.db could not open, English error truncated after
"database disk...". Exact customer cause remains unconfirmed without full error,
client version and preserved data. Repository investigation found concrete bugs:

- First legacy migration copied only messages.db; the subsequent WAL branch
  skipped after the main file existed. Real crash fixture: 2 committed rows became 1.
- Failed merges were swallowed and the source root still archived.
- Compaction's two-renames window could leave only .precompact; subsequent store
  construction silently created an empty database. Migration ran before recovery.
- Every SQLite open failure was labelled corruption and advised deletion/rebuild.

Repair uses store/sqlite-snapshot.js (SQLite VACUUM INTO, standalone quick_check,
file fsync, atomic no-clobber publication; directory fsync on POSIX). It rejects
destination journals. Interrupted compaction recovery validates the message-store
schema, retains its backup, and runs before both migration and store opening.
Empty/unrelated backups and orphan journals cannot become an empty message store.
store/legacy-message-migration.js retains the existing message merge behavior;
source connections are read-only and failures propagate so the caller keeps the
legacy root for retry. A source with WAL is not renamed while it may be live.

Diagnostics perform a bounded sqlite_schema read, not SELECT 1 or a synchronous
full scan of potentially multi-GB customer data. Success means basic readability,
not complete integrity. Busy/access errors are warnings; corruption/full/I/O errors
remain actionable. Missing primary with recovery files is visible, not a fresh install.

Do not auto-replace an existing damaged primary using a guessed backup: this can
discard newer history. Preserve the complete userData directory, including sidecars.
0.1.167's WAL compaction guard is prevention, not recovery of previously damaged files.

Tests: scripts/test-session-db-safety.mjs and companion storage/diagnostic tests.
Native Windows, real power loss and this customer's actual file are not validated.
