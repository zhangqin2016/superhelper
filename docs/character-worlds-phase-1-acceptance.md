# Character Worlds Phase 1 — Release Acceptance Runbook

This runbook is the release-acceptance record for Character Worlds Phase 1
(plan: `docs/superpowers/plans/2026-07-30-character-worlds-phase-1.md`,
capability vector: `character-worlds-isolation` in `CAPABILITY-GATE.md` and
`src/shared/capability-gates.json`).

**Phase 1 is not complete until (a) all automated gates pass and (b) the manual
cross-platform checks below are executed on every release platform and recorded
with evidence using the template at the end of this document.** A check without
recorded evidence counts as not done. "Looks fine" does not pass — attach the
artifact that proves it.

## Automated Gates (must be green before any manual sign-off)

Run from the repo root on the release branch:

```bash
node scripts/test-character-worlds-store.mjs
node scripts/test-character-card-parser.mjs
node scripts/test-character-card-png.mjs
node scripts/test-character-macros.mjs
node scripts/test-character-worlds-import.mjs
node scripts/test-character-binding-isolation.mjs
node scripts/test-character-context-compiler.mjs
node scripts/test-character-context-injection.mjs
node scripts/test-character-worlds-ipc.mjs
node scripts/test-character-session-control.mjs
npx electron scripts/test-character-session-control.cjs
node scripts/test-character-worlds-policy.mjs
node scripts/test-character-world-book-store.mjs
node scripts/test-character-world-book-import.mjs
node scripts/test-character-world-book-activation.mjs
node scripts/test-character-world-book-compile.mjs
node scripts/test-character-world-book-decorators.mjs
node scripts/test-character-world-book-ipc.mjs
node scripts/test-character-worlds-capability-gate.mjs
node scripts/test-character-worlds-concurrency-stress.mjs
node scripts/test-capability-gate-registry.mjs
npm run test:capability-gate
npm run test:unit
```

Record each result individually (pass / skip / fail + reason). Environment
skips (e.g. a missing optional runtime in the full suite) must be named; no
release claim is allowed while a product-relevant failure remains. Known
environment-only failures (see `HANDOFF.md` §7, e.g. `PLAYWRIGHT_NODE_MISSING`
in worktrees without the generated web bundle) are documented as environment
issues and must not be hidden by production-code changes.

## Manual Cross-Platform Checks

Execute every check below on each release platform:

- macOS arm64 (Apple Silicon)
- macOS x64 (Intel, native or Rosetta)
- Windows x64

Each check lists its steps and the expected result. If any step deviates, the
check FAILS — stop and file it; do not patch around it in the release branch.

### 1. Native conversation unchanged

1. Fresh install (or cleared app-data). Do NOT import any character.
2. Hold a normal multi-turn conversation: a casual question, a coding ask,
   a document task.
3. Capture the main-process log for the whole session and grep it. The logger
   writes to the main-process stdout/stderr (there is no log file), so launch
   the packaged app from a terminal:
   - macOS: `"/Applications/Lily Workbench.app/Contents/MacOS/lily-workbench" 2>&1 | tee /tmp/lily-native.log`
     (in dev: `npm start 2>&1 | tee /tmp/lily-native.log`)
   - Windows (PowerShell): `& "C:\Program Files\LilyWorkbench\lily-workbench.exe" 2>&1 | Tee-Object C:\Temp\lily-native.log`
4. `grep -i "character" /tmp/lily-native.log` — expect ZERO matches for the
   strings `character context compile`, `CHARACTER WORLDS CONTEXT`, and
   `characterWorlds` (any match means character work ran on a native turn).

Expected: behavior, speed, tools, model, permissions, and answers are exactly
today's Lily. No character UI state affects the conversation. No card parsing
runs and no extra model request is made (the grep in step 4 finds nothing;
a turn-start trace contains no `characterContext` key).

### 2. V1/V2/V3 JSON import

1. Import a V1 JSON card, a V2 JSON card, and a V3 JSON card (fixtures under
   `fixtures/character-worlds/` or known-good samples).
2. Check the preview shown before committing each import.

Expected: each card previews with name/description fields mapped per its spec
version; unknown fields are preserved inertly (visible as data, never acted
on); oversized or out-of-bounds cards are rejected with a clear message, not a
crash; commit succeeds and the character becomes selectable.

### 3. V2/V3 PNG/APNG import

1. Import a V2 PNG card (embedded `chara` chunk), a V3 PNG card, and an APNG
   card.
2. Import an ordinary non-card PNG image as an attachment in a conversation.

Expected: card images import and preview like the JSON path; the ordinary
image flows through Lily's existing attachment/image path with no character
side effects; a malformed PNG card is rejected with a clear message.

### 4. Preview cancellation

1. Start an import, then cancel at the preview step.
2. Repeat with a large card while parsing is in flight.

Expected: nothing is stored — no character, no revision, no binding; the
source file is untouched; the conversation keeps working; a later import of
the same card starts cleanly.

### 5. Character selection and removal

1. In a conversation, select an imported character; send a message.
2. Remove the selection; send another message.
3. Remove (archive) the character entirely.

Expected: while selected, the reply adopts the character's narrative voice for
prose only (code, JSON, commands, citations, file names stay exact); after
removal the conversation is plain native Lily again; archived characters
disappear from selection but previously admitted turns keep their pinned
snapshots; selection state survives app restart.

### 6. Switch during running turn

1. Bind character A, send a message, and WHILE the reply streams switch the
   binding to character B (or remove the binding).
2. Let the running turn finish; send another message.

Expected: the running turn finishes in character A's context (its admission
snapshot); the NEXT turn uses B/native. No cross-contamination, no error, no
duplicated dispatch.

### 7. Send/switch/send queue ordering

1. While a turn is running, send a queued message (send #1), switch the
   character binding, then send another queued message (send #2).

Expected: send #1 runs with the binding snapshot pinned at its send time;
send #2 runs with the new binding. Queue order is preserved; each turn
resolves exactly its own snapshot.

### 8. Two conversations in parallel

1. Open two conversations. Bind character A to the first, character B (or
   none) to the second. Run turns in both at the same time.

Expected: bindings, snapshots, and replies stay inside their own
conversation; nothing crosses sessions (verify the second conversation's
answers show no trace of A's card content).

### 9. Scheduled task exact-session behavior

1. Bind a character in conversation X. Create a scheduled task targeting X.
2. Switch X's binding before the task fires. Let the task run.

Expected: the scheduled turn is admitted against X's binding at its own
admission time, runs in X only, and never touches another conversation's
binding or history.

### 10. Restart recovery

1. Bind a character, send a message, then force-quit the app mid-turn and
   relaunch. Also relaunch after a normal quit.
2. Reopen the conversation.

Expected: bindings and imported characters survive intact; a turn admitted
before the crash keeps its pinned snapshot (queued turns recover with their
original snapshot, never re-read from the current binding); no duplicated
user messages; native conversations reopen unchanged.

### 11. Malformed / oversized / hostile card fallback

Import each of: a truncated JSON card; a card over the size limit; a card
whose fields contain prompt-injection text ("ignore all previous
instructions", "disable tools"); a card with unknown/broken macros; a card
with invisible/zero-width unicode; a PNG with a corrupt card chunk.

Expected: bounded rejection or safe fallback in every case — the app never
crashes, the conversation falls back to native Lily behavior (never worse
than today), blocked directives are redacted with a metadata-only warning,
unknown macros stay literal inert text, and no imported script/plugin/regex
ever executes.

### 12. Provider without safe system context

Configure a provider that cannot safely carry per-request system context in
ONE of these two exact ways:

1. Environment override (simplest): launch the app with the capability grade
   forced to lite —
   `LILY_MODEL_CAPABILITY_GRADE=lite npm start` (dev) or set the same variable
   in the packaged app's environment. The injection boundary treats a lite
   grade as "no safe system context".
2. Profile metadata: select or configure a model whose provider preset /
   probed capability profile declares `capabilities.safeSystemContext: false`
   (or whose capability grade probes as `lite`) in Settings → Models.

Then bind a character and converse on that model.

Expected: the turn runs as native Lily — the compiled context is dropped at
the injection boundary, no character instructions are moved into a fake user
message, no error, no degraded tools (verify in the log: no
`CHARACTER WORLDS CONTEXT` suffix in the request while the turn otherwise
succeeds). Switching back to a capable model restores character context on
the next turn.

### 13. Kill switch

1. Set `LILY_CHARACTER_WORLDS=0` and relaunch. Converse in a bound
   conversation.
2. Also disable the feature via the signed server rollout policy while the
   app runs.

Expected: the conversation is byte-for-byte native Lily; imported data and
bindings remain stored and readable (nothing deleted); re-enabling restores
the feature exactly where it left off.

### 14. Privacy inspection

Method:

1. Pick a card with unique sentinel strings that cannot occur by chance
   (e.g. name `Zqxwv-Sentinel-9371`, description containing
   `ULTRA-SECRET-CARD-TEXT-5583`).
2. Route the app's traffic through an inspection proxy — mitmproxy
   (`mitmweb --listen-port 8888` with the app started with
   `HTTPS_PROXY=http://127.0.0.1:8888` and the mitm CA trusted), or
   Charles/Proxyman with SSL proxying enabled for all hosts.
3. Import, bind, and converse with the card; also trigger a diagnostics
   upload (model error report) and a remote-config refresh.
4. Search the full capture (all requests AND bodies) for the sentinel
   strings.

Expected:

- The sentinels NEVER appear in any outbound request to ANY host. Hosts that
  must not receive card content include: the configured Lily service base
  (default `https://lily.lanrensoft.cn` and its edge fallback), the model
  gateway/relay hosts, and the update/release hosts. The only place card text
  may leave the device is INSIDE the model request itself (the compiled,
  redacted context suffix on capable providers) — verify that payload contains
  only the compiled envelope, never raw unknown card fields.
- Card content at rest lives only in the local message-store SQLite under the
  app-data directory (`<appData>/lily-workbench`, e.g.
  `~/Library/Application Support/lily-workbench` on macOS,
  `%APPDATA%\lily-workbench` on Windows).
- Diagnostics/telemetry payloads contain only metadata (revision ids,
  fingerprints, warning codes, token estimates) — never card text; a bound
  conversation exposes no other owner's or conversation's card data.

### 15. CJK / RTL / zoom / keyboard / screen-reader layout

1. Exercise the character picker and import preview with: a CJK-named
   character and CJK card text; an RTL-named character; UI zoom at 150%+;
   keyboard-only navigation (tab order, focus visible, enter/escape);
   a screen reader (VoiceOver on macOS, NVDA on Windows).

Expected: no clipped or overlapping controls, wrapping is correct for CJK and
RTL text, every control is reachable and operable by keyboard, and the picker
/ preview / selection state are announced meaningfully by the screen reader.

## Spec §19.5/§19.7 Items — Recorded Phase-1 Deferrals

The following spec release-gate items are **explicitly deferred beyond
Phase 1**. They are recorded here (not silently dropped); each names what
exists today and what must happen before the feature graduates from the
rollout flag to always-on.

1. **Binary rollback/rollforward compatibility.** Deferred: Phase 1 ships
   behind the signed rollout policy + `LILY_CHARACTER_WORLDS=0` kill switch,
   and all character data is additive in the existing message-store schema
   (new tables/columns, native rows byte-unchanged), so a rollback build
   simply ignores the feature. Not yet evidenced: an automated downgrade →
   upgrade cycle on real installs (old binary opens a database written by the
   new binary, then the new binary reopens it). Required before graduation:
   a scripted rollback/rollforward check per platform using release
   installers.
2. **≥100,000 hostile-input fuzzing evidence (§19.7).** Deferred: today the
   parser/PNG/macro/import tests cover bounded hostile classes (malformed,
   oversized, cyclic, unicode-hostile, injection) and the concurrency stress
   runs 10,000 seeded schedules — but no 100k-case generated fuzz corpus has
   been executed. Required before graduation: a seeded fuzz runner over
   card JSON/PNG/macro inputs with the §19.7 invariants (no crash, hang,
   network access, path escape, or partial committed import) and its run
   recorded as evidence.
3. **Performance targets on the slowest hardware profile.** Deferred: Phase 1
   bounds all new work (parse budgets, worker timeouts, 16k-token context
   ceiling, admission in the existing transaction) and the native path is
   pinned to zero added policy/remote-config work, but no measured latency/
   memory budget on the reference low-end laptop exists yet. Required before
   graduation: named targets (import preview p95, per-turn admission overhead,
   context-compile p95, idle memory delta) measured on the slowest supported
   hardware profile and attached to this runbook.
4. **Model eval-matrix / non-inferiority evidence (§19.7 native-versus-role
   parity).** Deferred: the capability-gate test proves byte-equal prompt
   bodies and single dispatch for every failure mode at the HOST layer, but
   no model-level task parity matrix (required tools, permissions, evidence,
   artifacts, machine-readable output, native vs role) has been run across
   the supported model grid. Required before graduation: the deterministic
   native-versus-role Agent task matrix with 100% parity on the required
   dimensions, per §19.7.

Phase 1 may ship behind the rollout flag with these four items open; the
flag must not be removed (feature made always-on) until each deferral above
is closed with recorded evidence.

## Phase 2A — World Book Acceptance (extends the Phase 1 checklist)

Phase 2A (plan: `docs/superpowers/plans/2026-07-31-character-worlds-phase-2.md`)
adds world-book lore activation on top of the Phase 1 surface. **Every Phase 1
check above still applies unchanged** — Phase 2A extends the same
`character-worlds-isolation` capability vector; it does not relax any Phase 1
gate. The manual checks below are the Phase 2A additions: run them on every
release platform together with the Phase 1 checks and record them in the same
evidence template (rows 16-20).

### 16. Embedded world book import

1. Import a V2 and a V3 card that embed a `character_book` (lorebook) with
   several entries; check the import preview.
2. Import the same card twice.

Expected: the preview shows the book summary (entry count, supported vs inert
field counts); unknown entry fields and unsupported behavior (regex keys,
vectorized entries, unknown V3 decorators) are preserved inertly and reported,
never executed; an oversized or hostile book rejects the whole import with a
clear message (never a partial import); the duplicate import dedups the
identical book revision instead of piling up copies; the book is inspectable
through the read-only surface (summary, entry counts, compatibility report) —
and there is NO create/edit/delete UI path for books in Phase 2A.

### 17. Activation visible in trace and diagnostics

1. Bind a character whose embedded book has a constant entry and a keyed
   entry; send a message that hits the key and one that does not.
2. Capture the main-process log (same method as check 1).

Expected: the keyed entry activates only on the matching turn; the turn trace
records only metadata (revision ids, entry ids, reasons, content hashes) —
never raw book text; activated lore appears ONLY inside the
`CHARACTER WORLDS CONTEXT` lower-authority system suffix in §10.3.1 envelope
order, never in user text, visible history, or file parts; Lily guidance,
tools, permissions, and output format are unaffected.

### 18. Timed effects (sticky) across turns and restart

1. Use a book with a sticky entry (sticky N messages); activate it, then send
   follow-up turns without the key.
2. Quit and relaunch the app mid-sequence; continue the conversation.

Expected: the sticky entry keeps activating for exactly its sticky window
measured in canonical messages, then stops; a failed or interrupted turn never
advances the window; the effect resumes exactly at the committed turn boundary
after restart — never one turn early, never duplicated.

### 19. Rewind invalidation

1. Activate a sticky entry, then rewind the conversation past the activating
   turn; send a new message.

Expected: the sticky effect from the rewound turn does NOT activate (its
checkpoint was purged with the rewind); the conversation otherwise behaves
exactly like a fresh bind; no error surfaces.

### 20. Kill switch covers books

1. With a book-bound character active, set `LILY_CHARACTER_WORLDS=0` and
   relaunch; converse. Also disable the signed rollout policy while running.
2. Re-enable.

Expected: the conversation is byte-for-byte native Lily — no world content,
no activation work (verify via the log: no `CHARACTER WORLDS CONTEXT`); the
stored books and checkpoints remain intact and READABLE through the
inspection surface (the policy gates selection/import only); a missing,
corrupt, or over-budget book never breaks a bound character turn — the
character simply compiles without world entries; re-enabling restores
activation exactly where it left off.

## Evidence Template

Copy this block once per platform and fill it in. Attach artifacts
(screenshots, screen recordings, log excerpts, database dumps) next to the
report and reference their paths.

```text
Platform:            macOS arm64 | macOS x64 | Windows x64
Build:               <version + channel + commit>
Tester:              <name>            Date: <YYYY-MM-DD>
Automated gates:     <pass/fail counts + link to full run output>
Environment skips:   <list, with reason; "none" if none>

| # | Check                                   | Result | Evidence (path/link) | Notes |
|---|-----------------------------------------|--------|----------------------|-------|
| 1 | Native conversation unchanged           |        |                      |       |
| 2 | V1/V2/V3 JSON import                    |        |                      |       |
| 3 | V2/V3 PNG/APNG import                   |        |                      |       |
| 4 | Preview cancellation                    |        |                      |       |
| 5 | Character selection and removal         |        |                      |       |
| 6 | Switch during running turn              |        |                      |       |
| 7 | Send/switch/send queue ordering         |        |                      |       |
| 8 | Two conversations in parallel           |        |                      |       |
| 9 | Scheduled task exact-session behavior   |        |                      |       |
| 10| Restart recovery                        |        |                      |       |
| 11| Malformed/oversized/hostile fallback    |        |                      |       |
| 12| Provider without safe system context    |        |                      |       |
| 13| Kill switch                             |        |                      |       |
| 14| Privacy inspection                      |        |                      |       |
| 15| CJK/RTL/zoom/keyboard/screen-reader     |        |                      |       |
| 16| Embedded world book import (2A)         |        |                      |       |
| 17| Activation in trace/diagnostics (2A)    |        |                      |       |
| 18| Timed sticky across turns/restart (2A)  |        |                      |       |
| 19| Rewind invalidation (2A)                |        |                      |       |
| 20| Kill switch covers books (2A)           |        |                      |       |

Sign-off:            <name + date, only when every row is PASS with evidence>
```

## Completion Statement

Phase 1 is **not** complete until:

1. every automated gate in "Automated Gates" above is green on the release
   branch (environment-only skips individually recorded), and
2. a filled evidence template exists for all three platforms — macOS arm64,
   macOS x64, Windows x64 — with every check PASS and evidence attached.

Known gap to close before sign-off: real Windows filesystem race testing for
the file broker (see `HANDOFF.md` §7) — check 10 and the import checks on
Windows x64 must be performed on real Windows hardware/VM, not assumed.

## Evidence Records

### Record 1 — macOS arm64 (partial: automated gates + launch smoke)

```text
Platform:            macOS arm64 (macOS 26.4.1)
Build:               0.1.145 dev, feat/opencode-engine @ cdfea08
Tester:              automated (agent)  Date: 2026-07-31
Automated gates:     PASS — full suite 524/524 (scripts/run-all-tests.mjs,
                     372s, exit 0); capability gate 60/60
                     (scripts/run-capability-gate.mjs, exit 0); all 15
                     Character Worlds focused tests + registry green
Environment skips:   none product-relevant (offline sandbox produced expected
                     network noise only: SSL handshake errors to remote hosts;
                     dock.setIcon returned false — unrelated pre-existing)
Launch smoke:        PASS — fresh LILY_USER_DATA_DIR, `npx electron .` alive
                     after 28s, watchdog started, engine + bundled runtime
                     resolved, no `[character-worlds] disabled` warning
                     (service constructed), default policy disabled
                     (no signed remote config). Log: /tmp/lily-smoke.log
                     (session-local artifact; reproduce with the same command)

| # | Check                                   | Result | Evidence (path/link) | Notes |
|---|-----------------------------------------|--------|----------------------|-------|
| 1 | Native conversation unchanged           | PASS (automated) | test-character-worlds-capability-gate.mjs: 8 failure modes byte-equal native + zero policy calls + real OpencodeAgentSession path | manual UI confirmation still open |
| 2-15 | (manual UI checks)                   | OPEN   |                      | require human execution per template |

Sign-off:            NOT SIGNED — manual rows 2-15 open; macOS x64 and
                     Windows x64 records missing.
```

