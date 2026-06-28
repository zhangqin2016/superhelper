# Top-Tier Agent Intelligence Design

## Goal

Make Lily Workbench smarter at the platform layer without drifting away from its original product stance: users operate through natural language, and the app supplies reliable runtime, memory, evidence, and document substrates behind the agent.

## Product Principles

- Natural language remains the primary operation path. New intelligence must be agent-invocable through contracts, evidence, skills, and scripts, not through new panels.
- Memory is retrieval, not proof. Strong conclusions still need fresh evidence from files, tools, commands, documents, or web sources.
- Failure degrades to today's behavior. A failed classifier, evidence check, or document index must not make the answer worse than the current baseline.
- Ordinary turns stay cheap. Deep grounding and document indexing are paid only when the request or attachments justify it.

## Architecture

### 1. Task Contract Router

The existing `task-contract.js` remains the entry point. It is extended with explicit top-level intent categories for architecture audits and system-quality reviews, instead of relying on broad keyword heuristics in `turn-policy.js`.

The router must classify requests like "分析我们系统有哪些比较笨的地方" as an active architecture audit, not a casual chat. The resulting contract requires workspace grounding, source coverage, and evidence-backed final claims.

### 2. Evidence-First Final Answer

`evidence-gate.js` keeps regex checks as a last line of defense, but policy moves toward structured requirements. Each active task type can declare required evidence kinds, such as file search, file reads, verification output, fresh web evidence, or document evidence.

The final gate evaluates the ledger summary against those requirements before accepting strong claims. Missing evidence downgrades the answer with a visible notice and stores the evidence gap in session memory through the existing turn finalization path.

### 3. Document Query Substrate

`document-translator.js` continues using bundled Python extraction for actual Office/PDF parsing. After extraction, the JS side builds a lightweight query index: document ids, chunk ids, headings where detectable, source labels, character ranges, and compact excerpts.

The prompt receives a compact "document query index" plus selected excerpts. This avoids dumping only a flat truncated blob. If indexing fails, Lily falls back to the current extracted text path.

Future work can expose a true document-query tool, but this slice creates the stable data shape and prompt substrate first.

## Data Flow

1. User sends text and optional files.
2. Vision and document preflight enrich attachments.
3. Document preflight returns extracted text plus optional index metadata.
4. `TurnOrchestrator` builds a task contract from the enriched request.
5. `buildTurnPolicy` derives rigor and budgets from the contract.
6. The evidence ledger records search/read/write/verification/document events.
7. Finalization runs `assessFinalAnswerEvidence` against policy and ledger summary.
8. Unsupported strong claims are downgraded, never silently accepted.

## Error Handling

- Task classification failure: return inactive/general contract and use the current fast path.
- Document index failure: include existing extracted text; do not fail the turn unless extraction itself already fails for document-only messages.
- Evidence-gate mismatch: append a visible evidence notice and persist the gap; do not discard partial work.
- Missing runtime pack or heavy parser: use the base extractor and surface diagnostics through existing document notices.

## Testing

- Add task-contract tests for architecture audit classification and evidence policy.
- Add turn-policy tests proving architecture audits are grounded or coverage-level, while casual chat remains fast.
- Add evidence-gate tests for required evidence kinds.
- Add document-translator/send-preflight tests for index metadata and fallback behavior.

## Scope Boundary

This design does not add a new UI workflow, replace OpenCode history, or build a full document search service. It upgrades the platform contracts and prompt substrate first, preserving today's behavior as the fallback.
