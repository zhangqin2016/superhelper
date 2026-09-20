# Windows Large-History Responsiveness

## Customer Evidence

The supplied watchdog JSONL contains 87,384 valid rows across many launches.
In the last focused window (2026-09-19 21:00-21:54 UTC), 39 main-loop lag events
include 30 over 10 seconds and nine over 30 seconds. The maximum is 66,057ms.
Repeated startup samples show about 596MiB JS heap plus 635MiB external memory;
later RSS reaches about 2.6GiB. This points to heavy main-process work, not proof
that model inference or GPU capacity is responsible. Renderer-heartbeat staleness
alone cannot distinguish renderer blockage from a main process unable to receive
heartbeats. The log has no stacks or SQL spans, so exact customer causality remains
unproven.

## Reproduction

`create-large-history-fixture.mjs` creates a new temporary profile, 1,600 synthetic
messages with random 512KiB binary-to-base64 tool diagnostics each, and one message
with 128MiB raw diagnostics. SQLite size: 846,606,336 bytes. There is also a small
control session. It does not edit the existing customer/local database.

Native source Electron instance PID 39732 opened the large session and switched
to/from the small control while background enrichment progressed. Sending a short
test prompt triggered `micro_completion_retry`. Main watchdog then recorded
9,130ms lag, RSS 3,005,317,120 bytes, heap 1,286,498,544, external 1,116,156,714.

Code inspection found `TranscriptStore.supersedeAssistantTurn` decoding the WHOLE
conversation to find the assistant belonging to one turn. The recovery path calls
this after dispatching a retry. A read-only benchmark using the same database and
the production selection implementation reproduced the behavior:

| Path | Elapsed | Main heartbeat gap | RSS at result | Selected reply |
| --- | ---: | ---: | ---: | --- |
| Full-history recovery baseline | 5,538ms | 5,538ms | 2,336MiB | same |
| Indexed worker recovery | 74ms | 20ms | 79MiB | same |

The benchmark forces GC between variants, so RSS values describe observed working
sets, not a controlled peak-allocation measurement or a promise for all machines.
The native 9s stall and the customer 66s stall are not asserted to be identical.

## Changes

- A persistent queued read worker owns SQLite read snapshots, envelope decoding,
  artifact derivation and the existing display projection. Only one read is in
  flight. Complete answers/tools remain intact; archived diagnostics are untouched.
- Session-page, turn-preflight and resume-continuity reads await that worker.
  Stale turn-start guards remain in place.
- Recovery queries the existing session/turn/role index and returns only the
  selected message id, instead of decoding unrelated messages. Both recovery
  callers await selection; a previously superseded message is not overwritten.
- Artifact backfill runs in its own worker, one record at a time. Expensive decode,
  derivation and compression happen on a READ-ONLY connection. Compressed commits
  are acknowledged by the existing main-process database owner; no background
  connection writes. A compare
  against the original envelope prevents overwriting a live edit or resurrecting
  a deletion. Durable cursors preserve restart progress; corrupt records do not
  prevent the rest of a session being processed.

## Verification

Synthetic read tests (10ms heartbeat):

| Workload | Sync gap | Worker gap |
| --- | ---: | ---: |
| One 128MiB record | 238ms | 17ms |
| 48 records, 384MiB total | 644ms | 18ms |
| Background enrichment, one 128MiB record | not benchmarked | 23ms |

Passing targeted tests: large-message-reader, message-enrichment-worker,
tool-call-rescue, task-continuity-integration, resumable-enrichment,
conversation-read-budget, artifact-freshness, opencode-conversation-source,
opencode-session-policies, task-request-continuity, turn-start-guard,
session-manager and architecture-boundaries. These are not the full suite.

After normal UI exit/restart, native PID 24148 used the indexed-recovery source.
The same large session accepted another prompt and the accessibility tree contained
the returned answer. No new >2s watchdog lag appeared during that send. A 90s
main-process CPU sample was mostly idle (88.6s); no full-history inflate dominated
the sample. That second model response did NOT trigger another recovery, so exact
recovery-path validation is the read-only benchmark and regression tests, not a
claimed second native recovery trace.

## 2GiB Follow-Up

`LILY_STRESS_DB_GIB=2` produced 2,168,016,896 bytes with 4,101 large-session
messages (including one 128MiB raw diagnostic record) plus a control session.
The final fixture nests `profile` under a unique temporary parent and redirects
APPDATA/LOCALAPPDATA. This avoids migration importing neighboring fixtures.

| Read-only benchmark | Elapsed | Main heartbeat gap | Observed RSS |
| --- | ---: | ---: | ---: |
| Full-history recovery | 13,335ms | 13,336ms | 5,406MiB |
| Indexed worker recovery | 293ms | 20ms | 473MiB |
| Worker page 50 | 393ms | 18ms | 316MiB |
| Worker page 120 | 614ms | 18ms | 303MiB |

Both recovery variants selected the same giant-record id. RSS is not a controlled
peak. These are local measurements, not hardware-independent guarantees.

The first native run (PID 20960) FAILED: sending during enrichment raised
`database is locked` in turn input admission. Independent worker writes could
invalidate the foreground deferred read/write transaction snapshot. Raising the
busy timeout would not fix that ownership race. Production maintenance now uses
the single existing writer, with worker-side derivation/compression and a
conditional compressed commit/ack protocol.

Native re-run PID 43564 used the same database after resetting only 1,000
synthetic artifact versions and the synthetic completion cursor while offline.
Sending during progress (~1,400/4,101) returned a real model answer. Read-only DB
inspection confirmed both new messages and `terminal=turn.completed`,
`failed=false`. Switching to the small control and back remained responsive.
Backfill completed with 4,103 scanned (two live additions), 1,000 enriched, zero
failed/skipped. No locked error or >2s watchdog lag occurred during the send;
startup DID log 5,288ms lag and is not accepted as fully fixed.

The visible tail after switching back still showed synthetic history although
the accessibility tree and database contained the new answer. This run proves
admission/persistence, not final visual-order acceptance for the synthetic mix.
The concurrency regression additionally forces foreground read/write snapshot
windows while actual background row commits occur; it passes without lock errors.
Read-worker, enrichment-worker, tool-call-rescue and architecture tests were rerun.

Evidence profile:
`C:/Users/49229/AppData/Local/Temp/lily-native-large-history-YOybl1/profile`.
Keep `native-single-writer-*` logs separate from the failed run. The profile
contains copied local configuration: do not upload it wholesale.

## Remaining Gaps

- Startup still logged 2,840ms main-loop lag on the second native run. Initial-run
  switch/startup had 2.7s/5.1s/7.7s stalls. These paths are not proven fixed.
  A later `--inspect-brk` startup sample did not reach a populated workspace;
  inherited debugger startup behavior can pause child processes. That sample is
  excluded from performance acceptance, not counted as a successful fast launch.
- First native run unexpectedly imported 224 local legacy rows into the TEMP test
  profile through existing automatic migration. The original running profile was
  retained; its database was not modified by this test. For subsequent launch,
  APPDATA/LOCALAPPDATA were redirected inside the test profile to prevent another
  legacy-source scan. Explicit-profile migration isolation deserves a separate fix.
- Native short-answer validation triggered an unnecessary micro-completion retry
  and left failed-turn UI state on the first run. This task does not certify that
  separate answer-quality/terminal-display behavior.
- Other synchronous legacy import/export, first-message and large-write paths
  remain. Worker isolation does not bound the size of essential answer/tool data
  transferred to the renderer. OpenCode's own large database was not simulated.
- No installer was built/published, no ASAR acceptance, and no claim that the exact
  customer 66-second freeze is fully eliminated.

## Reproduce Commands

```powershell
node scripts/test-large-message-reader.mjs
$env:LILY_STRESS_MB='384'
$env:LILY_STRESS_RECORDS='48'
node scripts/test-large-message-reader.mjs
node scripts/test-message-enrichment-worker.mjs
node scripts/create-large-history-fixture.mjs
node --expose-gc --max-old-space-size=6144 scripts/benchmark-history-recovery.mjs <fixture-messages.db> <fixture-session-id>
```

Native evidence and CPU profile are retained in the local temporary directory
`C:/Users/49229/AppData/Local/Temp/lily-native-large-history-kgm3o0`.
Do not upload that whole directory: copied local configuration can include secrets.
