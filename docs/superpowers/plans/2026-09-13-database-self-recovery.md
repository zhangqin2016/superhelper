# Database self-recovery implementation

Implementation and scoped verification completed 2026-09-13. Final storage
suite: 25/25 in system Node and Electron Node mode; real Electron UI and native
main-process repair tests pass. Global full-suite first run was 937/940; the two
in-scope failures were fixed and rerun. One unrelated concurrent auth gate still
has no registry entry. No commit/release or native Windows/customer-file
acceptance is claimed. See `docs/database-self-recovery-verification.md`.

> Use test-driven development and subagent-driven implementation/review. Work in the existing checkout because this feature builds on the user's uncommitted database safety fixes; preserve unrelated renderer and release edits. Do not commit or publish in this task.

## Accepted contract

SQLite crash recovery and verified interrupted-compaction recovery may run automatically. Existing corrupt history must never be silently reset or rolled back. Verify recoverable copies, preserve original database/journals before an explicitly confirmed replacement, and retain evidence through interruptions. No unbounded retry or automatic task replay after restoring older history. An independent recovery surface must work before normal DB-dependent initialization, display the real app version, and distinguish lock/access/I/O/corruption/unknown errors. A failed recovery remains visible; it is not an empty successful history.

## Architecture

Startup preflight runs in a worker before migrations/session loading. A worker-backed recovery service owns fixed paths (no renderer-supplied paths), bounded operations and verified rolling snapshots. A separate local Electron recovery window has a tiny restricted preload, localized status, retry, diagnostics export, verified candidate metadata, explicit restore confirmation and exit. Normal startup starts only after preflight passes. Older restored data suppresses automatic task/scheduler recovery on the first successful boot. Healthy sessions receive asynchronous periodic snapshots. Existing legacy migration and compaction safety work is retained.

### Task 1 — Safe storage operations

- [x] Add `src/main/store/database-recovery.js` and real SQLite tests `scripts/test-database-recovery.mjs` (observe failures first).
- [x] Preflight validates existing message schema/integrity without creating a missing/empty replacement; normal new installs remain supported. Distinguish SQLite extended lock/corrupt/access/I/O errors. Bounded busy handling.
- [x] Create timestamped verified standalone snapshots, retain a bounded number of verified backups, and never rotate originals/recovery evidence. Preserve WAL commits using SQLite snapshot APIs.
- [x] Prepare recovery only on isolated copies; list verified candidates with message/session counts and snapshot time. No claim of full recovery merely from partial readable data. Unrecoverable files remain preserved.
- [x] Explicit confirmed restore only while startup is quiescent: retain original DB plus sidecars, use a crash-resumable intent, publish a verified candidate without overlaying old journals, preserve all evidence on failure, mark restored startup to disable automatic task replay.
- [x] Verify existing damaged primary, truncated DB, WAL, backup corruption/collision, missing primary with journals, locked DB, cancelled/failed restore and interrupted replacement with temp fixtures only.

### Task 2 — Startup isolation and user flow

- [x] Add worker runner (`src/main/database-recovery-service.js`, `src/main/database-recovery-worker.js`) and independent recovery window/preload/assets. Bound worker lifetime; prevent overlapping actions; scope IPC to recovery window.
- [x] Integrate preflight before migrations and session load in `src/main.js`; catch initialization failure into recovery rather than leave a half-initialized app. Register essential version IPC independently. No destructive recovery after live services have started.
- [x] Add real-version fallback correction in `src/renderer/app.js`; failed IPC displays unavailable, not 0.1.0.
- [x] Add explicit confirmation describing potential missing recent history. Recovery never automatically restarts itself. Retry runs one bounded attempt. Diagnostics stay local unless user exports them.
- [x] Schedule worker snapshots after healthy startup and periodically, stop at shutdown. Disable automatic recovered turns / job wakes / scheduled tasks after confirmed restore until deliberate later restart.

### Task 3 — Verification and review

- [x] Add fault-injection startup/worker tests and Electron DOM UI checks for progress, failure, cancellation, candidate selection, version and no overlap. Re-run existing SQLite safety/migration/compaction/store/session/diagnostics tests.
- [x] Independent specification then code-quality review; address findings and rerun tests.
- [x] Update capability registry/gate and recovery documentation with actual evidence. Report native Windows, physical power-loss and customer-data recovery as unverified unless actually exercised. Never label source tests as release acceptance.
