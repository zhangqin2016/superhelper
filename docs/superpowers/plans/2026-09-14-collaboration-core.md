# Lily collaboration core implementation plan

> **For agentic workers:** Use superpowers:executing-plans, inline execution with checkpoint commits. Resume from the first unchecked item; do not restart completed work. User explicitly authorized implementation without another design approval.

**Goal:** Persistent shared workspaces and conversation tasks, task-owned Git deliveries, automatic validated integration and safe local application for code, Office and large directories.

**Architecture:** Preserve existing collaboration ACL, encrypted SQLite records, command receipts, multipart transport and task orchestration. Separate shared published Git history from the private version vault and from local uncommitted files. Every network/filesystem boundary has a recoverable durable identity; no claim of a global transaction.

**Tech Stack:** Electron/CommonJS main process, ES module renderer, SQLite, Fastify/PostgreSQL, system/bundled Git, bundled Python and LibreOffice.

## Baseline and authorization

- Original worktree was clean detached `06eb1d95` (0.1.12), missing all named collaboration modules, CAPABILITY-GATE.md and memory/MEMORY.md.
- Current branch `codex/collaboration-core` starts at committed `dab5cecb` from `feat/opencode-engine`. Switching required sandbox approval for shared Git worktree metadata; no original working files were changed.
- Original dirty workspace contains database recovery, message rendering and upstream auth work. None of those uncommitted edits were imported. Committed task continuity and collaboration foundations are available; later safety changes need integration review when this branch is eventually merged.
- Research copied verbatim from the explicitly supplied file into `docs/research/2026-09-14-collaboration-git-ai-research.md`. Prototype is interaction reference only.
- No production deployment, install package, original-workspace merge, or external messaging is authorized.

## A — Persistent identity, bindings and cards

- [x] A1. In `task-workflow.js`, persist preparation intent before asynchronous freeze and emit a change after each durable state. Keep failures visible and retry under the same identity after restart. Dedicated `test-remote-task-preparation.mjs` covers deferred freeze, pre-ready send refusal, concurrent retry and SQLite reopen; existing workflow covers upload/receipt recovery. This step does not implement cards or an automatic startup retry worker.
- [ ] A2. Add shared workspace identity to `server/src/services/collaboration/task-contract.cjs`, task service/routes and additive PostgreSQL migration; validate participant ACL and immutable workspace ownership. Extend task views and client command schemas; legacy tasks omit identity. Test wrong-account/history/object access and duplicate creation receipts.
- [ ] A3. Add encrypted device-local binding records using `task-records.js`; accept only main-resolved project/session IDs, persist canonical directory identity. Extend `task-session.js`, workflow receive/open and main task options so existing projects can own isolated task worktrees without retargeting an active engine. Test close/reopen, multiple tasks in one workspace, deleted project, symlink and account changes.
- [ ] A4. Project local pending and authoritative tasks into stable conversation references in collaboration timeline and owning workspace session. Reuse remote-task actions, update a single keyed node by monotonic revision, keep initial order and local materialization distinct. Test actual Electron DOM, navigation/account fences, offline pending and restart duplication.

## B — Git baseline and immutable task contribution

- [ ] B1. Add `src/main/collaboration/task-git.js` using existing `workspace-git.js` executable resolution, an isolated collaboration repository and explicit task refs. Capture only authorized frozen baseline paths; never copy `.git` or the private vault. Real Git tests assert private history and unrelated working edits are absent.
- [ ] B2. Make task execution use its isolated worktree and known materialization inventory. Build a changeset from explicit path records; absence is deletion only for known downloaded readable baseline files. Rename is represented with source/target identities. Test add/change/delete/rename, mixed local edits, ignored/missing/unreadable input and immutable retries.
- [ ] B3. Negotiate Git objects through mature Git plumbing/transport; add ACL-scoped content descriptors and missing-object queries to the existing object service. Reuse encrypted multipart for large file objects, retaining legacy ZIP input/delivery readers. Reject completion until all required objects verify. Test object reuse, lost responses, revoked access and real Git ancestor reconstruction.

## C — Automatic integration and local materialization

- [ ] C1. Persist integration intents in SQLite keyed by workspace/delivery/target; add generation/lease fencing and a workspace-wide writer coordinator. Wire task events to the bound session through `turn-orchestrator.js` and existing turn queue/TaskCore. Foreground turns continue; no focus or engine cwd changes. Test duplicate events, reopen, lease expiry, stale workers and background admission.
- [ ] C2. Build shared candidate M exclusively from published H and immutable D. Deterministic Git/type merge first; unresolved intent goes to the existing AI turn with baseline/goal/evidence. Run candidate validation, CAS publish H→M and persist publication outbox. Recover ref/database acknowledgement gaps by reading actual refs; test simultaneous publishers and target advancement.
- [ ] C3. Build local candidate from A/W/M separately. Extend `task-application.js` journal with immediate hash rechecks, writer fencing, retryable external Office locks and contribution-specific inverse changes. Keep private W out of shared commits. Inject crashes before/after every write and receipt; retain subsequent edits on apply/undo conflicts.

## D — Office and large-directory acceptance

- [ ] D1. Add Python document merge adapter under `resources/runtime-scripts/`, invoked with resolved bundled runtime. Use python-docx/openpyxl/python-pptx for typed structure; preserve untouched package parts and refuse unsupported destructive round trips. Model sees bounded semantic conflicts. Verify Word paragraphs/tables, Excel formulas/row identity, PPT objects and macro/unknown-part preservation. Render/recalculate with existing document verification tools; PDF prefers source.
- [ ] D2. Replace ZIP materialization on the new protocol with streamed manifest/object enumeration, bounded concurrent hashing/upload, quotas, resumable verified cache and lazy materialization inventory. Show online-only entries in Lily tree only. Test missing objects never become empty filesystem placeholders and do not become deletions.
- [ ] D3. Run measured scale/fault cases and two full Electron clients with isolated test profiles/service. Record actual bytes/RSS/timing and runtime versions. Separate fixtures, Git/SQLite/filesystem integration, PostgreSQL HTTP integration and real clients; unavailable environments remain unchecked acceptance items.

## Verification and checkpoints

Each implementation slice: first run a failing intent regression, implement minimally, rerun its suite and affected companions, review diff, commit explicit paths only, update this file with evidence and next action. Never use global `git add .`.

Existing companion baseline: `test-remote-task-{bundle,workflow,session,application,records,recovery,transfer}.mjs`; UI: `test-remote-task-dual-client-ui.cjs`; server scripts under `server/scripts/collaboration-*integration.mjs`.

Self-review: A covers requests 1/3 and ACL; B covers 2/4/5 and private-history boundaries; C covers 6 plus concurrency/recovery; D covers 2/7 and fidelity/scale. Realtime CRDT and block dedupe are explicitly outside this core plan. No stage may be declared complete from helper tests alone. Detailed API/test additions are refined against immediate callers before each slice rather than inventing unverified signatures.

## Execution log

2026-09-14 checkpoint 1:

- A1 implemented. Preparing records now exist before bundle I/O; failed preparation remains encrypted and can resume via `prepare {draftId}`. Ready material is required for send. Live preparation IDs fence duplicate retries within the singleton workflow. Read-only drafts/recoveries bypass mutation locks and do not emit change events. State writes emit immediate lightweight hints. Renderer supports re-preparing a restored draft.
- New red test first failed because draft reads were blocked by preparation's `new` mutation key. After implementation it passes with real SQLite, real successful freeze and intentionally deferred/failing I/O. No child process was killed in this test: reopen is controlled recovery evidence, not power-loss evidence.
- PASS with Node 22.19.0 and `NODE_PATH=/Users/zhangqin/aicode/ceshitermianl/node_modules`: `test-remote-task-preparation.mjs`, `test-remote-task-project-source.mjs`, `test-remote-task-workflow.mjs`, `test-remote-task-bundle.mjs`, `test-remote-task-session.mjs`, `test-remote-task-application.mjs`. SQLite experimental warning only. Dependencies are read-only references; no install or original-workspace mutation.
- PASS actual Electron `test-remote-task-workflow-ui.cjs`, including added failed-preparation/same-draft retry assertions. Invocation: `NODE_PATH=/Users/zhangqin/aicode/ceshitermianl/node_modules /Users/zhangqin/aicode/ceshitermianl/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/test-remote-task-workflow-ui.cjs`. Sandbox launch exited 134; approved unsandboxed launch passed against temporary test profile. API responses are fixtures, not live service acceptance.
- Review: existing revoked-source test now expects the encrypted pending intent to remain after authority is lost during freeze; prepared material must never be published by that callback. No remote message, package or model turn is dispatched during preparation. Known remaining scope: one workflow's in-memory retry fence is not the cross-process durable lease required by C1.
- Budget breach: oversized rule-file outputs exceeded the user's session token budget (goal tool reported 90,976 at first check). Surfaced to user. Subsequent reads must use narrow ranges and bounded output; checkpoint now for a fresh continuation.
- NEXT: A2 read `server/src/services/collaboration/task-contract.cjs`, task service/route/migrations, `task-view.js`, `client.js` task API and existing server integration tests. Add stable sharedWorkspace identity with immutable ACL scope and compatibility before device binding/card projection. A2–D3 remain unimplemented; no full-core completion claim.
