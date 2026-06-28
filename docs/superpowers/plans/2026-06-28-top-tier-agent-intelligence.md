# Top-Tier Agent Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first complete platform slice for smarter natural-language execution: architecture-audit routing, structured evidence requirements, and document query indexing.

**Architecture:** Extend existing task contracts, evidence gate, and document preflight rather than creating parallel systems. Each change has tests and degrades to today's behavior if unavailable.

**Tech Stack:** Electron main process CommonJS modules, Node test scripts under `scripts/test-*.mjs`, bundled Python document extraction already invoked by `document-translator.js`.

---

### Task 1: Architecture Audit Contract

**Files:**
- Modify: `src/main/task-type-schema.js`
- Modify: `src/main/task-contract.js`
- Modify: `src/main/turn-policy.js`
- Test: `scripts/test-task-contract.mjs`
- Test: `scripts/test-turn-policy.mjs`

- [ ] Add `architecture_audit` to the task type schema with verification steps for impact surface, weak-point inventory, evidence-backed diagnosis, and improvement plan.
- [ ] Add an `architecture_audit` category with Chinese and English terms such as "笨的地方", "系统审视", "架构审视", "weakness", and "architecture audit".
- [ ] Ensure architecture audit is an activating category and has checklist guidance that preserves natural-language product stance.
- [ ] Add tests proving "分析我们系统有哪些比较笨的地方" creates an active architecture audit contract.
- [ ] Add turn-policy tests proving architecture audit uses grounded evidence budgets and requires an evidence summary.

### Task 2: Structured Evidence Requirements

**Files:**
- Modify: `src/main/task-contract.js`
- Modify: `src/main/evidence-gate.js`
- Test: `scripts/test-evidence-gate.mjs`

- [ ] Extend evidence policies with `requiredEvidenceKinds`.
- [ ] Map architecture audits to `file_search`, `file_read`, and `workspace_grounding` evidence.
- [ ] Teach `assessFinalAnswerEvidence` to fail strong architecture/coverage claims when required evidence kinds are missing.
- [ ] Keep regex evidence markers as fallback only; structured ledger evidence is preferred.
- [ ] Add tests for missing file search, missing file read, and supported architecture audit evidence.

### Task 3: Document Query Index

**Files:**
- Create: `src/main/document-query-index.js`
- Modify: `src/main/document-translator.js`
- Modify: `src/main/send-preflight.js`
- Test: `scripts/test-document-query-index.mjs`
- Test: `scripts/test-send-preflight.mjs`

- [ ] Build a deterministic index from extracted document text: document id, chunk id, source label, char range, heading hint, and excerpt.
- [ ] Format a compact prompt block that says the index is for locating evidence and excerpts are not proof beyond the shown source.
- [ ] Return `documentIndex` from `extractDocuments` when indexing succeeds.
- [ ] Include the compact index in preflight-enriched text while preserving current extracted text fallback.
- [ ] Add tests proving document success includes the index and document failure behavior stays unchanged.

### Task 4: Verification

**Files:**
- Run existing focused tests.

- [ ] Run `node scripts/test-task-contract.mjs`.
- [ ] Run `node scripts/test-turn-policy.mjs`.
- [ ] Run `node scripts/test-evidence-gate.mjs`.
- [ ] Run `node scripts/test-document-query-index.mjs`.
- [ ] Run `node scripts/test-send-preflight.mjs`.
- [ ] Report the pre-existing dirty file `scripts/test-opencode-agent-session.mjs` without modifying it.
