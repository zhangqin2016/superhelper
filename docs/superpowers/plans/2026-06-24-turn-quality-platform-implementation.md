# Turn Quality Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Lily's default turn-quality platform: normalized policy, evidence ledger, lightweight workspace indexing, and final-answer gating without slowing ordinary turns.

**Architecture:** Keep agent runtimes replaceable by adding platform-owned modules under `src/main/`. `TurnPolicy` normalizes the existing task contract, `EvidenceLedger` records compact tool-derived evidence, `workspace-index` provides cheap candidate lookup only when needed, and `evidence-gate` uses the ledger before finalization.

**Tech Stack:** Electron main process, CommonJS modules, existing Node test scripts in `scripts/test-*.mjs`.

---

### Task 1: Turn Policy

**Files:**
- Create: `src/main/turn-policy.js`
- Test: `scripts/test-turn-policy.mjs`

- [ ] Write tests for fast, grounded, coverage, and freshness policies.
- [ ] Implement `buildTurnPolicy({ text, taskContract })`.
- [ ] Run `node scripts/test-turn-policy.mjs`.

### Task 2: Workspace Index

**Files:**
- Create: `src/main/workspace-index.js`
- Test: `scripts/test-workspace-index.mjs`

- [ ] Write tests that generated/heavy directories are ignored and explicit terms produce candidate files.
- [ ] Implement bounded recursive path indexing with mtime cache.
- [ ] Run `node scripts/test-workspace-index.mjs`.

### Task 3: Evidence Ledger

**Files:**
- Create: `src/main/evidence-ledger.js`
- Test: `scripts/test-evidence-ledger.mjs`

- [ ] Write tests for file search, file read, verification command, write/edit, generic tool, and final summary.
- [ ] Implement compact tool event normalization and ledger summary.
- [ ] Run `node scripts/test-evidence-ledger.mjs`.

### Task 4: Final Gate Upgrade

**Files:**
- Modify: `src/main/evidence-gate.js`
- Test: `scripts/test-evidence-gate.mjs`

- [ ] Add tests for root-cause, fixed, verified, all-occurrences, and fresh-current claims against ledger summaries.
- [ ] Keep old API compatibility while using `turnPolicy` and `evidenceSummary` when provided.
- [ ] Run `node scripts/test-evidence-gate.mjs`.

### Task 5: Orchestrator Integration

**Files:**
- Modify: `src/main/turn-orchestrator.js`
- Modify: `src/main/turn-archive.js`
- Test: `scripts/test-turn-quality-platform.mjs`

- [ ] Add tests that a turn creates policy metadata, records tool evidence, and downgrades unsupported final claims.
- [ ] Build policy after task contract creation.
- [ ] Attach workspace candidates for coverage turns using the index.
- [ ] Record tool input/result evidence on tool lifecycle events.
- [ ] Persist compact evidence summary and policy metadata in archived turn records.
- [ ] Run `node scripts/test-turn-quality-platform.mjs`.

### Task 6: Verification

**Files:**
- Existing targeted test scripts.

- [ ] Run all new tests.
- [ ] Run existing task/evidence/orchestrator-adjacent tests.
- [ ] Report any suite-wide failures separately from targeted verification.

