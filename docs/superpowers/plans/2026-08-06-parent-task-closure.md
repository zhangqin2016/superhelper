# Parent Task Closure Recovery Plan

> **For implementation:** execute this plan in order and keep the existing
> fail-open behavior for unrelated turns.

**Goal:** automatically continue execution tasks when Lily has tool results but
the parent agent stops before delivering a final answer, without duplicate or
unbounded side effects.

**Architecture:** add a pure eligibility/prompt module and a focused durable
recovery runtime, then compose it into the existing recovery runtime. The
orchestrator records an eligible source before terminal projection and invokes
the recovery after the original terminal record is finalized. The recovery is
an internal resend of the same OpenCode conversation with `recordUser:false`,
`sourceTurnId`, a deterministic continuation turn ID, and the original task
core rehydrated from `turn_inputs`. SQLite CAS state is authoritative across
duplicate engine events and restarts; a per-source-turn in-memory latch is
only the compatibility fallback.

## Step 1: Lock the contract with tests

Files:
- Create `scripts/test-parent-task-closure-recovery.mjs`.
- Create `src/main/parent-task-closure.js` with the exported pure API used by
  the test.

Tests first:
1. An active code/release task with completed tools and stalled parent is
   eligible.
2. Chat, external-fact-only, user interruption, pending permission/question,
   and no execution evidence are ineligible.
3. A previously consumed recovery key is ineligible.
4. The prompt preserves the original objective and instructs execution and
   verification rather than another plan.
5. A ledger accepts one key and rejects duplicate claims.

Run the focused test before implementation and confirm it fails for the
missing module/behavior.

## Step 2: Implement the bounded recovery primitive

Files:
- `src/main/parent-task-closure.js`

Implement:
- execution-task classification based on the existing task contract and
  semantic operation, not a second keyword router;
- compact tool evidence snapshot;
- eligibility decision with explicit exclusion reasons;
- bounded continuation prompt builder;
- process-local key ledger with claim/clear helpers and no unbounded payload
  retention.

Keep this module independent of Electron and network state so it is fully
unit-testable.

## Step 3: Integrate into the existing recovery runtime

Files:
- `src/main/turn-recovery-runtime.js`
- `src/main/turn-orchestrator.js`
- `src/main/turn-event-types.js`

Add a `maybeParentClosureRecovery` method that:
- accepts a captured source-turn snapshot;
- claims the recovery key before any send;
- emits progress notices;
- invokes the existing `sendUserMessage` adapter with the same files/task core,
  `recordUser:false`, `spawnEngine:true`, `sourceTurnId`, and a typed recovery
  descriptor;
- releases the claim only when dispatch was not admitted, so a later normal
  terminal path can explain the unavailable recovery;
- never throws into the terminal handler.

Add the durable state boundary:

- `src/main/store/parent-closure-schema-migration.js`
- `src/main/store/parent-closure-recovery-store.js`
- `src/main/session-parent-closure-recovery.js`
- `src/main/parent-closure-recovery-runtime.js`

Persist a bounded source snapshot and evidence summary before finalization,
claim it with a lease/CAS, reuse the deterministic continuation turn ID, and
scan prepared or expired claims after application restart. Keep the immutable
task core in `turn_inputs`; do not duplicate large context envelopes in the
recovery table.

In `_handleDone`, capture the source turn before finalization. For stalled or
failed outcomes, finalize the original turn as today, then invoke the recovery
method from the finalization promise. Do not invoke it for interruptions,
pending user input, or a second recovery turn.

Add `turn.parent_closure_recovery` to optional event types so progress survives
the terminal boundary and is not dropped as an orphan.

## Step 4: Preserve task-run visibility

Files:
- `src/main/task-run-runtime.js`
- `src/main/task-run-state.js`
- `src/main/turn-orchestrator.js`

Record the recovery phase and source turn in the task run when the internal
turn is admitted. Keep the existing UI contract and compact payload shape;
the renderer should receive a progress notice without a new panel or a new
user-visible message.

## Step 5: Verify and review

Run:
- `node scripts/test-parent-task-closure-recovery.mjs`
- `node --check` on all changed JavaScript files.
- `git diff --check`.
- `node scripts/run-all-tests.mjs`.

Manually inspect the final diff for: no recursive retry path, no duplicate
transcript user message, no permission bypass, no cross-session state reuse,
and no claim that a recovery succeeded before its dispatch result is known.
