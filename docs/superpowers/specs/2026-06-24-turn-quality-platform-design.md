# Turn Quality Platform Design

Date: 2026-06-24

## Purpose

Lily Workbench should provide reliable answers for ordinary users without making every turn slow or asking users to choose expert modes. The platform should learn from Claude Code's lifecycle control points, but keep the policy decisions inside Lily by default.

The goal is not to make the model "try harder." The goal is to make the host platform know when the agent has enough evidence to make a claim, when it should continue collecting evidence, and when it must downgrade the final answer.

## Current Shape

The existing flow already has useful pieces:

- `src/main/task-contract.js` classifies the task and injects execution guidance.
- `src/main/workspace-grounding-gate.js` prevents ungrounded writes into new workspace locations.
- `src/main/evidence-gate.js` checks a narrow class of unsupported strong final claims.
- `src/main/turn-orchestrator.js` owns turn lifecycle, finalization, and archive commit.
- `src/main/turn-archive.js` records assistant text, tools, file changes, artifacts, timeline, and metadata.

The gap is that these pieces are still mostly prompt-driven or coarse. `sourceCoveragePolicy` tells the agent what to do, but the platform does not yet verify coverage. `evidence-gate` counts tools and scans text, but it does not understand evidence types, candidate scope, or claim strength. Tool events are archived, but not normalized into a durable evidence ledger.

## Design Principles

1. Ordinary users should not choose modes. The platform infers the needed rigor.
2. Fast turns must stay fast. Full coverage is only for tasks that ask for full coverage.
3. Evidence must be recorded by code, not by trusting the model to summarize itself.
4. The agent runtime should remain replaceable. OpenCode, Claude CLI, or a future runtime should feed the same platform evidence protocol.
5. Final answers should be honest by default: verified when verified, bounded when partial, and explicit when unknown.
6. UI should stay simple. Show a short evidence summary by default, with details collapsible.

## Target Architecture

```text
User Request
  -> Intent & Contract Compiler
  -> Context Planner
  -> Agent Runtime
  -> Tool Event Normalizer
  -> Evidence Ledger
  -> Coverage / Claim Gate
  -> Final Answer Renderer
```

## Core Components

### 1. TurnPolicy

`TurnPolicy` is the platform-owned execution contract. It should replace the scattered policy responsibilities currently split between task contract, evidence policy, workspace grounding, and source coverage.

It should still be injected into the agent prompt, but prompt injection is only one consumer. The host process must also enforce it.

Proposed fields:

```js
{
  schemaVersion: 1,
  taskType: "chat" | "code_analysis" | "bugfix" | "implementation" | "research" | "document" | "release",
  rigor: "fast" | "grounded" | "coverage",
  requiresFreshness: false,
  requiresWorkspaceGrounding: true,
  requiresSourceCoverage: false,
  allowedClaimStrength: "casual" | "bounded" | "verified",
  evidenceBudget: {
    maxPlanningMs: 1500,
    maxSearchMs: 3000,
    maxFilesToRead: 20,
    maxToolCallsBeforeAsk: 30
  },
  finalAnswer: {
    requireEvidenceSummary: true,
    allowDowngrade: true,
    allowAutoContinue: true
  }
}
```

Default inference:

- Fast: ordinary conversation, localized follow-up, explicit small question.
- Grounded: code, files, bugs, architecture, external facts, document interpretation.
- Coverage: "all", "full", "彻底", "所有", "不要漏", "审计", "整个项目", "为什么会出现这个问题" when the answer requires broad scope.

### 2. Lifecycle Hooks

Lily should expose Claude-style lifecycle points internally first:

```text
beforeTurnStart
afterTurnPolicyBuilt
beforeToolUse
afterToolUse
beforeFinalAnswer
afterTurnComplete
```

Initial hooks should be internal modules, not user-configurable UI. Later, enterprise or advanced users can configure policies on the same hook surface.

Important initial hook owners:

- `afterTurnPolicyBuilt`: attach context plan and budgets.
- `beforeToolUse`: enforce permissions and workspace grounding.
- `afterToolUse`: normalize evidence and update the ledger.
- `beforeFinalAnswer`: run claim and coverage gates.
- `afterTurnComplete`: persist ledger metadata into the turn archive.

### 3. Tool Event Normalizer

Every runtime-specific event should be mapped into platform evidence facts.

Examples:

```js
{
  kind: "file_search",
  tool: "grep",
  query: "TurnPolicy",
  candidates: ["src/main/task-contract.js"],
  success: true,
  timestamp: 1782260000000
}
```

```js
{
  kind: "file_read",
  path: "src/main/turn-orchestrator.js",
  lines: [740, 1095],
  contentHash: "sha256:...",
  success: true
}
```

```js
{
  kind: "verification",
  command: "node scripts/test-evidence-gate.mjs",
  exitCode: 0,
  success: true
}
```

The normalizer should be conservative. If it cannot understand a tool event, it can store a generic `tool_observation`, but gates should not treat that as strong proof.

### 4. EvidenceLedger

The ledger is turn-local and persisted into the archived record metadata.

It should track:

- Requested scope: what the user asked to analyze.
- Candidate scope: files, paths, URLs, APIs, or records found by search/index.
- Inspected scope: files/URLs/records actually read.
- Changes: files edited or artifacts produced.
- Verification: tests, commands, browser observations, API responses.
- Gaps: known uninspected candidates or skipped checks.
- Claim support: which evidence kinds can support which final claim strength.

The ledger should be small. Store summaries and hashes in the turn record; avoid archiving large file contents again.

### 5. Context Planner

This is the performance guardrail. It decides how much context to gather before and during a turn.

Rules:

- Do not scan by default.
- Use explicit user file paths first.
- Use current session context and recent tool results for follow-ups.
- Use a lightweight workspace index for file/path/symbol lookup.
- Use `rg` or index search only when the task is grounded or coverage-oriented.
- Only coverage-oriented tasks require candidate set accounting.

The workspace index should be incremental and cheap:

- Path list, mtimes, sizes.
- Common source extensions.
- Optional symbol summaries later.
- Ignore generated/heavy folders from `AGENTS.md`.

This avoids turning every user request into a full repository scan.

### 6. Coverage And Claim Gate

The final gate should classify the final answer's claims and compare them against the ledger and policy.

Gate outcomes:

```text
pass       -> emit final answer
downgrade  -> emit final answer with bounded wording and evidence summary
continue   -> ask the agent to gather specific missing evidence
ask        -> ask user only when cost/scope is materially high or ambiguous
block      -> fail loud for unsafe or impossible claims
```

Examples:

- If the answer says "root cause is X", require code/log/runtime evidence.
- If it says "fixed", require file changes.
- If it says "verified", require command, test, browser, API, or comparable output.
- If it says "all occurrences", require a candidate search record.
- If it gives current external facts, require fresh web/API evidence.
- If evidence is partial, rewrite the platform summary as bounded instead of pretending certainty.

### 7. Final Answer Renderer

The user should see a concise answer, not a policy report.

Default footer shape:

```text
已检查：src/main/task-contract.js、src/main/turn-orchestrator.js
验证：未运行测试
范围：这是架构分析，不是全仓审计
```

Detailed evidence can be collapsible in the UI. This matches the product rule that natural language drives the workflow and avoids piling on panels.

## Runtime Relationship

OpenCode or Claude CLI should be treated as agent runtimes, not as the source of platform truth.

```text
Agent runtime:
  - reads files
  - runs commands
  - edits files
  - searches
  - streams assistant output

Lily platform:
  - classifies task policy
  - enforces lifecycle gates
  - records evidence
  - checks claim support
  - renders final answer boundaries
```

This keeps Lily portable across runtimes.

## Performance Strategy

The default must stay fast.

Suggested distribution:

- 80% fast path: no workspace scan, no coverage accounting, answer from current context or explicit evidence.
- 15% grounded path: search/read directly relevant sources, then answer with bounded evidence.
- 5% coverage path: build candidate set, track inspected coverage, and ask only when scope is expensive.

The gate should prefer downgrade over extra work unless the user requested completeness.

## Implementation Phases

### Phase 1: Unify Policy

Add `TurnPolicy` as a normalized wrapper around existing `TaskContract` outputs.

Keep current behavior mostly unchanged, but persist the normalized policy into turn metadata. This phase should not add broad scans.

### Phase 2: Evidence Ledger MVP

Add a turn-local ledger and update it from existing tool lifecycle points. Start with:

- file search
- file read
- shell command
- file write/edit
- web search/fetch when available

Persist compact ledger summaries in `turn-archive`.

### Phase 3: Final Gate Upgrade

Replace the current regex-only evidence gate with a policy-aware gate:

- strong claim detection
- evidence type matching
- coverage requirement checks
- bounded downgrade text

Keep the initial gate conservative and explain residual risk instead of forcing expensive continuation.

### Phase 4: Workspace Index

Add an incremental index for cheap path and symbol lookup. Use it only for grounded and coverage turns.

This phase is what prevents "严谨" from becoming "每次都慢".

### Phase 5: Optional Extensibility

Expose hook configuration later for advanced users, teams, or enterprise policies. Do not expose this in the ordinary user flow at first.

## Non-Goals

- Do not require users to choose quick/strict/exhaustive modes.
- Do not scan the whole workspace on every turn.
- Do not build a large UI policy dashboard.
- Do not rely on prompt text as the only enforcement mechanism.
- Do not make OpenCode-specific assumptions in the platform ledger.
- Do not store large tool output blobs twice.

## Acceptance Criteria

1. Ordinary chat and localized code questions do not become slower because of coverage scanning.
2. Tasks that ask for full coverage cannot produce "all/全部/彻底" claims without a candidate set record.
3. "Fixed/completed/verified/root cause" claims require matching evidence types or are downgraded.
4. Turn archives include enough compact evidence metadata to explain why the platform allowed or downgraded the answer.
5. The same platform policy can work with OpenCode today and another agent runtime later.

