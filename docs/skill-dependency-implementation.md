# Skill discovery and dependency implementation

Date: 2026-09-05. Implements `skill-dependency-top-tier-plan.md` with the review corrections approved by the user's request to implement the full loop.

## Contract

Keep the single Lily guide + Read discovery path. Existing platform skills and baseline execution survive malformed declarations, discovery failures and disabled features. Mere recommendation or enabling a skill never requires downloading its heavy optional packages. Only a dollar-prefixed skill invocation or an available skill ID in the model-authored intent contract contributes declared requirements to readiness; mere textual mentions do not. the existing task readiness remains authoritative otherwise.

Workspace skills are read-only, constrained by real paths, scoped to the workspace and filtered by explicit conversation selection. A customized conversation opts into only the local IDs it selects; default conversations discover local skills. Installed IDs shadow local IDs, including disabled installed skills. Local declarations use the same validation as installed declarations. Discovery and guide generation share a content fingerprint. Additional index text must never evict existing platform skills.

Dependency hints recognize actual missing executables/modules, preserve the original output, and explain background install → terminal status/health → correct runtime → retry the failed operation. They do not replay user tasks, install automatically or treat input-file errors as missing executables. Pack mappings remain checked against the managed catalog.

Audits distinguish candidate matching from successful guide reads and unknown legacy tool outcomes. Metrics remain advisory; stable fixture evals cover discovery, isolation, preparation and recovery. Live model evals separately require real guide-read tool evidence, not answers containing paths.

## Execution checklist

- [x] Dependency declarations: failing tests for additive legacy fallback, invalid entries, fresh manifests and explicit task readiness; implement resolver, installer/converter metadata preservation and catalog migration; run targeted tests and mutation checks.
- [x] Frontmatter and workspace discovery: failing block scalar, symlink, duplicate, disabled-selection, cache-refresh and budget tests; implement constrained parser and session integration; verify real guide output in three locales.
- [x] Runtime rescue: failing positive/negative output, deduplication/lifecycle and kill-switch tests; implement/register plugin; verify executable and Python retry after managed environment preparation.
- [x] Index quality: repair verbose first-party descriptions; bounded negative clauses with baseline-preserving budget fallback; three-language headroom and quality tests.
- [x] Observability: successful/failed/unknown reads and workspace candidates; pure aggregate and read-only SQLite report with fixture CLI coverage; capture local aggregate without message contents; add evidence-aware guide eval scoring.
- [x] Isolation: test native skill source disabled and same-workspace conversation guide differences without source-keyword assertions.
- [x] Review, mutation guards, gate registration, full capability suite and unit suite; update this checklist and record skipped environmental acceptance explicitly.

## Validation

Each new test first fails on a named behavioral assertion, then passes with implementation. Mutations run in subprocesses or restore source in `finally` and may never overlap a full suite. Run `node scripts/run-capability-gate.mjs`, `npm run test:unit`, and `git diff --check`. Do not rebaseline lost skills. Record true fallback semantics in gates.json and mutation evidence in this report. No publishing or deployment is part of this task.

## Implemented interfaces and operational behavior

- `skill-runtime-declarations.js`: fresh ordered union of installed/supplied manifest and bundled registry declarations. The preflight legacy map remains additive. Unknown IDs, malformed arrays, contradictory IDs and unsupported schema versions cannot authorize new requirements. `runtime-packs: ffmpeg, git` is the supported scalar frontmatter field.
- `workspace-local-skills.js`: deterministic convention precedence `.agents`, `.claude`, `.opencode`, `.lily`; installed IDs always shadow local IDs. Maximum 40 indexed skills and 160 inspected candidate files; files over 256 KiB and realpath escapes are skipped. Local opt-outs persist through the existing session skill IPC; a standalone session workspace is supported. Guide fingerprints include content and selected IDs.
- `skill-frontmatter.js`: one shared parser for top-level scalar metadata and folded/literal multiline descriptions. Nested keys cannot overwrite top-level metadata. This is a constrained scalar reader, not a general YAML object deserializer.
- `runtime-dependency-hint.js`: actual nonzero bash exit metadata plus precise POSIX, cmd.exe, PowerShell, Python traceback or Node Playwright diagnostics. Generic ImportError, Python Playwright (not supplied by the Node pack), input-file errors and ambiguous spawn ENOENT do not produce false install advice. Inherited object keys cannot become pack IDs.
- `runtime_pack_list({packId, verify:true})`: target status and health, then safe explicit managed environment values for the current shell. Broad broker listing retains every formerly listed pack including Git; ordinary installer/UI listings keep their existing internal-pack visibility. Starting a background job does not imply ready. Terminal failure is retained. Bundled packs cannot currently be repaired by this installer and return an explicit limitation instead of looping.
- `skill-usage-report.mjs --db <messages.db> --json`: read-only gzip-envelope support with legacy record-column compatibility. It never opens the application's mutable store. New version-2 audits record successful, failed and unknown Read outcomes; actual tool.done provenance is carried through archiving so terminal cleanup cannot fabricate success or failure; old compatibility fields remain advisory attempts. Aggregate does not infer model selection, execution or task success.
- Live guide evals now invoke the engine JSON event mode and require successful Read of the actual indexed guide. Answer-only naming, failed reads, wrong paths, engine errors and mixed sessions cannot pass that evidence check. Existing answer checks remain in addition to tool evidence.

## Measured baseline

Read-only local snapshot on 2026-09-05: 306 audited turns, 27 with candidates, 134 candidate matches, 857 message records without audits, zero invalid records. All 134 historical candidate outcomes are **unknown**, because version-1 audits did not record trustworthy read outcomes. The current-turn matched-unread rate is therefore **null**, not 0% or 100%. No message text, user paths or credentials are included in this report.

Platform guide bytes before and after implementation (unchanged; no baseline rewrite):

| Locale | Installed | All catalog skills |
|---|---:|---:|
| zh-CN | 25,760 | 37,145 |
| en | 29,591 | 40,194 |
| ar | 29,857 | 41,976 |

All six keep the same indexed skill counts and remain below the 48 KiB hard budget and 95% watermark. Workspace additions reserve learned-context bytes and never remove existing platform entries. The repository already has short web-system-learning descriptions; the original plan's 2,000-character observation referred to the local installed copy. The new quality guard verifies 97 first-party localized descriptions without rewriting clean source.

## Verification evidence

The new behavior tests were first run red and then green. Eleven root mutation regressions were caught (the eleventh uses in-memory module replacement to avoid editing source): nested metadata overwrites, realpath bypass, lost content hashing, stale selection cache, disabled workspace kill switch, index eviction, removal of learned-context reservation, failed reads reported successful, unknown outcomes counted in the rate denominator, bypassed guide-read eval evidence, and dropped actual-completion provenance during archiving. Removing just one of the two independent reservation checks remains harmless; removing the reservation entirely fails the guard.

Dependency mutations also caught known-ID validation removal, legacy-union removal, dropped selected-skill forwarding and kill-switch bypass. Review regression tests additionally covered legacy selection under the kill switch and malformed manifest identity/schema.

Rescue mutations caught lost deduplication, corrupted Python/Node mappings, absent exit evidence, premature readiness, lost terminal progress, inherited catalog properties, ambiguous ENOENT, removed Windows detection and bypassed bundled-repair refusal. A real local Python process failed to import a fixture, then succeeded when retried with the newly resolved managed environment; real deferred installer failure remained observable after job cleanup. No external runtime pack was installed for these new fixtures.

Independent review findings were reproduced and fixed: selection cache invalidation, learned-context reservation, standalone-workspace IPC forwarding, malformed manifest identity, full kill-switch rollback, ambiguous ENOENT, inherited map keys and bundled repair loops. The final reviewer additionally identified synthetic terminal tool status contaminating read outcomes; the real router → finalizer → archive test now covers no completion on successful/failed turns, absent status and actual successful/failed tool completion. Final review approved with no remaining findings.

Final validation after all code fixes: **828/828 full-suite tests passed**, **244 capability tests passed**, and `git diff --check` passed. All 68 capability registrations have valid anchors, including eight new gates. Architecture boundaries passed with 940 source files and 52 ratchets. These are local validation results, with the environmental exceptions below.

## Environmental acceptance

- The first full capability run was sandbox-restricted: Electron startup, localhost listening and one existing out-of-repository fixture failed with permission errors. A normal local-permission rerun passed all 244 capability tests.
- Live model discovery evaluation is implemented but not executed: `LILY_EVAL_BASE_URL`, `LILY_EVAL_MODEL` and `LILY_EVAL_API_KEY` are not configured in this environment. Deterministic event-evidence fixtures pass; this does not assert live model quality.
- Windows diagnostic strings are fixture-tested on macOS; native Windows shell and packaged Windows runtime acceptance are separate.
- The idle development application was quit normally and restarted with `npm start`. Startup logs confirmed engine/runtime resolution; the repository's renderer window restored its conversation and idle state. This is startup acceptance, not a live model evaluation. No deployed server or published release has been changed.

The first complete unit run passed 827/828 tests in 372 seconds. The only failure was the existing message-store test expecting all four runtime events after a completed turn; the already-shipped retention rule removes assistant.delta. The production store was unchanged; with its retention kill switch disabled the old 98 checks passed, confirming the stale expectation. The test now checks exact durable IDs (started, final, completed) and duplicate immutability under default retention; all 98 checks pass. The final full rerun after this correction and the completion-provenance fix passed **828/828 in 372 seconds**.
