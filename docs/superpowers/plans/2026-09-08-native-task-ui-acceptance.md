# Native Mac UI acceptance supplement — 2026-09-08

## Original verdict before correction: NOT PASSED

The real UI reproduces repeated completion responses after one user request.
The previous passing host-mechanism tests do not constitute end-to-end acceptance.
No product fix, commit, push, packaging, or release was performed in this supplement.

The statement above describes the original test. The subsequent authorized repair and fresh native UI recheck are recorded below; original failure evidence is retained.

## Environment and method

- Repository HEAD: `e0f30fcc8b86fd4703ae0a61fe8b3d4563a8f123`.
- Real macOS Electron app at `/Users/zhangqin/aicode/ceshitermianl/node_modules/electron/dist/Electron.app`.
- Observed renderer URL: `file:///Users/zhangqin/aicode/ceshitermianl/src/renderer/index.html`.
- Process metadata showed this repository's Electron processes started at 19:10–19:15, after the 18:47 HEAD commit. Runtime build hash was not independently exposed or verified; this is a source-client test, not installed-release acceptance.
- Native accessibility actions and screenshots; actual configured model execution, no fake renderer state, IPC injection, or mocked model responses.
- Created a new workspace through the actual folder picker: `/private/tmp/lily-ui-acceptance-pmGpcw`.
- Created two test conversations in that workspace. Existing business tasks were not sent messages, interrupted, or deleted.
- Native automated Chinese typing dropped characters. The unsent draft was replaced with an English instruction and checked before submission. This is an automation limitation, not established as an application input bug.

## A: Multi-step task, artifacts, and session switching

Submitted exactly one user message in the new conversation:

> UI acceptance A. Work only in /private/tmp/lily-ui-acceptance-pmGpcw. Do not access other directories or the network or install dependencies. Using Node standard libraries, create sum.cjs exporting sumCents(rows) that sums decimal amount strings as integer cents. Create test-sum.cjs using node:assert covering 0.10 plus 0.20 equals 30, empty array equals 0, and negative amounts throw. Actually run the tests and create REPORT.md with the command and result. Complete and verify the work, not just a plan.

Observed real tool cards: directory inspection, file writes, `node test-sum.cjs`, report write, and another test run. Files were independently read. An independent run of `node /private/tmp/lily-ui-acceptance-pmGpcw/test-sum.cjs` returned `All tests passed.` with exit code 0. This is a small synthetic task, not proof of arbitrary complex-task completion or production-quality financial arithmetic.

Created `UI acceptance B` using the top New conversation control and name dialog while A was still reported active. B showed an empty conversation, with A's global running indicator still visible. Switching back showed A's own task. No cross-conversation message leakage was observed in these switches. No latency benchmark was performed.

### P1 — Repeated completion replies after one user request

After returning to A, the native accessibility tree contained the original completion response and at least six additional completion responses, each with its own Lily section. Representative consecutive text:

- `任务已完成并验证通过。当前工作区文件状态与测试结果如下…`
- `任务已完成并通过最终验证。`
- `任务已完成并通过最终验证，无剩余工作。`
- `任务已全部完成并通过验证，无需再重复执行…`
- `任务已完成，无需再执行任何操作。`

Several additional sections had their own one-step tool summaries and differing token usage. The original user instruction was not re-submitted by this test. Therefore this is not simply a duplicated single text node. Whether each section corresponds to a recovery admission, replayed durable event, or another host action requires correlated runtime/store investigation; the root cause is not asserted here.

### P2 — Orphaned startup display

A showed global `空闲` and an intermediate Lily `正在启动…` node between completed replies. A full accessibility read confirmed the startup node remained after the final reply was present. A screenshot was captured in the conversation tool record; no screenshot file was exported.

## B: Stop and explicitly continue

Submitted a bounded synthetic task to run one foreground Node command printing START, waiting 45 seconds, and printing FINISHED, without files or network.

1. Native UI showed the 45-second Node command running.
2. Clicked the top Stop button. UI returned to `空闲`, showed `已中断`, removed the active Stop control, and marked the command `失败 · 17.7s`.
3. Switched to A and then back to B. B still showed interrupted, without an additional user instruction or spontaneous continuation at that observation.
4. Explicitly submitted: `Continue the interrupted acceptance task. Keep the same directory and no-network/no-files constraints. Change the wait from 45 seconds to 2 seconds. Execute the Node command once and report its actual output and exit code. Do not repeat it after successful completion.`
5. UI showed a new Node tool with a 2000ms timer, duration 2.1s, then an answer reporting START/FINISHED and exit code 0.
6. A further thinking round appeared after this completion. Before a subsequent Stop could be applied, it ended by itself. Final fresh UI state was `空闲` with disabled Send and an additional answer: `任务已完成，无需重复执行（该命令已成功运行过一次…）`.

### P2 — Interrupted task gains inconsistent additional history

On explicit continuation, the old interrupted 45-second task was followed by a separate `处理失败` Lily section containing the same 45-second command marked `终端已运行`. Both remained alongside the new successful 2-second turn. This is a confusing terminal-history display and needs diagnosis. The test does NOT establish whether the original OS child process was killed or ran to completion: no process-level termination evidence was collected.

Stop feedback and explicit continuation were reachable; overall stop/resume acceptance is not marked passed because of the extra history and unsolicited extra completion round.

## Fresh supplementary script checks

All returned exit code 0 in this supplement:

- `node scripts/test-turn-view-renderer.mjs`
- `node scripts/test-turn-process-layout.mjs`
- `node scripts/test-session-runtime-store.mjs`
- `node scripts/test-process-summary.mjs`

Their passing result does not override the live UI failures above.

## Remaining verification / follow-up

- Correlate only these synthetic test sessions with durable admissions, source-turn lineage, recovery reason, tool verification evidence, and renderer event IDs.
- Add regressions reproducing one request producing multiple terminal replies, stale startup rows, and interrupted-turn history on subsequent send; fix the proven cause, not by hiding all recovery or disabling capability checks.
- Re-run the same real UI sequence after a full source-client restart with a verified runtime version.
- App restart/crash recovery, lease expiration, cross-account behavior, installed Mac release, long original objective retention, and exhaustive complex tasks were not UI-tested here.
- Test workspace and conversations are retained for diagnosis. Final observed B state was idle; no existing business process was terminated.

## Authorized correction and fresh native UI recheck

### Root causes confirmed, not inferred from screenshots alone

Scoped read-only SQLite inspection of the synthetic sessions found six completed admissions and five parent-closure receipts for A. Receipt recovery IDs did not match the actual dispatched turn IDs. `_startTurn` discarded the stable recovery ID; document/vision preflight also replaced `currentPayload`, erasing the parent recovery marker. The recovery guard therefore failed to recognize its own follow-up. Generic unverified template criteria (including a renderer check for this Node-only task) supplied unnecessary follow-up work when the objective judge returned unknown.

The interrupted B turn had one committed host interruption, not a committed failure. Native history could append an abort-tail message and coalesce it under a different engine message ID. Metadata matching missed the earlier ID and allowed engine error state to supersede host interruption. Separately, renderer `turn.started` ran before the existing terminal fence and could resurrect an already terminated turn.

### Changes and regression coverage

- Preserve stable `opts.turnId` and `parentClosureRecovery` through normal preflight. A real orchestrator regression failed on each omission before the fixes.
- Unknown template audit evidence stays unverified and does not manufacture a new task. Confirmed missing original requirements, declared missing/empty outputs, and productive native handoffs still recover. No tools, models, context, or legitimate long-running work were disabled.
- Match coalesced native history against all constituent assistant IDs and retain committed host interruption. Regressions reproduce both terminal overwrite and the separate abort-tail row.
- Ignore late starts for already terminated turns, including while a newer turn is active. The new regression failed with `starting` instead of `idle` before the fix.

### Fresh real Mac UI observations: PASSED for the reproduced defects

The source client (`npm start`, package 0.1.169) was fully restarted after the main-process changes. All task submissions, Stop, conversation switches and normal app quits used native accessibility controls; no model mocks, IPC injection, or database writes were used. New synthetic conversations retained the same temporary workspace and existing files.

| Recheck | Native UI and independent evidence |
|---|---|
| A: multi-step task | One new user request created `sum-recheck.cjs`, `test-sum-recheck.cjs`, `REPORT-recheck.md`, ran the test and produced one final answer. After reading the generated scripts, an independent `node /private/tmp/lily-ui-acceptance-pmGpcw/test-sum-recheck.cjs` returned `All tests passed.` and exit 0. |
| A: no recursive completion | Session `199f8a65-cbf6-417b-bda4-9a247caeb657` retained exactly one completed admission, one user message, one completed assistant message and zero parent-closure recoveries after B testing and another app restart. |
| B: Stop | Once the 45-second foreground Node command was visibly running, Stop returned the UI to idle with one `已中断` task. Its tool still reports failed execution (the aborted command did not complete); this is distinct from an extra failed task. |
| B: explicit continue | One explicit request changed the wait to 2 seconds. The native tool ran for 2.1 seconds and the final answer reported START, FINISHED, exit 0. No unsolicited extra completion or separate `处理失败` assistant appeared. |
| B: durable lineage | Session `236ea4e9-152e-4c6a-8ed7-d071ef8bbc43` retained exactly two admissions: one interrupted and one completed; two user messages, one interrupted assistant, one completed assistant, zero parent-closure recoveries. |
| Session switching | B was created while A still ran. The blank new conversation did not inherit A's transcript. Later switching A/B retained each task's own history and idle state without orphan startup rows. |
| Normal restart | With all tasks idle, quit normally and ran `npm start` again. B still contained one interrupted and one completed task; A still contained one completed answer. No `正在启动…`, active Stop, extra failure task or automatic re-entry was observed. Scoped SQLite counts remained unchanged. |

Screenshots of the fresh A and B completion surfaces were captured inline in the native tool record; no screenshot files were exported. Test conversations and artifacts remain available for inspection.

### Fresh automated verification

All 31 scripts below returned exit 0 after the repair (including the two longer-running orchestrator/agent-session processes polled to completion):

```
test-turn-orchestrator.mjs
test-task-acceptance-recovery.mjs
test-opencode-conversation-source.mjs
test-session-runtime-store.mjs
test-parent-task-closure-persistence.mjs
test-parent-task-closure-recovery.mjs
test-parent-closure-lease-resume.mjs
test-parent-closure-live-failure.mjs
test-task-completion-integrity.mjs
test-task-completion-multistage.mjs
test-task-verification-shell.mjs
test-task-original-acceptance.mjs
test-task-request-continuity.mjs
test-task-source-resolution.mjs
test-task-execution-classification.mjs
test-task-execution-progress.mjs
test-turn-queue-recovery-task-core.mjs
test-turn-orchestrator-steer.mjs
test-opencode-agent-session.mjs
test-opencode-session-policies.mjs
test-turn-view-renderer.mjs
test-turn-process-layout.mjs
test-process-summary.mjs
test-task-objective-coverage.mjs
test-task-lifecycle-runtime.mjs
test-task-run-kernel.mjs
test-capability-gate-registry.mjs
test-message-render-keys.mjs
test-task-continuation-handoff.mjs
test-turn-loop-guard.mjs
test-message-store.mjs
```

Architecture module-size gate and `git diff --check` also passed. Full repository unit suite was not run.

### Limits of the new verdict

This closes the reproduced repeat-recovery and terminal-history defects in the real source client; it does not establish arbitrary complex-task success or installed Mac release acceptance. Generic task-verification metadata still remains conservatively unverified when template/judge evidence is insufficient (A: `missing_manual_or_test_evidence`, B completion: `missing_test_or_build_evidence`), rather than being relabeled passed. Improving template relevance and real-model objective-judge availability is separate from suppressing unjustified recovery. The independent artifact test above is actual evidence, not a synthetic verification upgrade.

Normal idle restart was tested; crashes during work, OS child termination, cross-account behavior, physical two-machine operation, exhaustive long tasks and signed packaging were not independently verified in this repair. No commit, push or release was performed.
