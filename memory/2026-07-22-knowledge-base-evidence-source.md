# Knowledge Base As First-Class Evidence (2026-07-22)

The local knowledge base (file-intelligence MCP `query_index`, backed by
`workspace-knowledge-store.js`) was only *incidentally* evidence: its result
text landed in `evidenceText` so number/entity grounding could coincidentally
match, but its `evidenceKind` fell through to `tool_observation` — no
structured counting, no `has*Evidence` flag, no way for a policy to require
it. Local/private facts ("我们上季度的报销总额") had the same evidence
standing as an arbitrary tool's chatter.

Fix (minimal, model-first):

- `tool-semantics.js`: `query_index` registered `readOnly` with
  `evidenceKind: "knowledge_base"` (suffix matching covers MCP-namespaced
  names like `lily-file-intelligence_query_index`).
- `evidence-ledger.js`: `normalizeToolEvidence` emits `kind: "knowledge_base"`
  with the query; `summary()` counts `knowledgeBaseQueries` and exposes
  `hasKnowledgeBaseEvidence` (success-gated — a failed KB query is not
  evidence, attempts are still counted).
- `evidence-gate.js`: `hasEvidenceKind` handles `"knowledge_base"`, so
  policies/judges can require it like any other kind.
- `task-evidence-policy.js`: `local_knowledge_base` added to the common
  `allowedSources` so the judge knows KB retrieval is an allowed source for
  every task type.

Deliberately NOT done:

- KB does NOT satisfy `external`/`fresh` kinds and cannot ground URL-required
  external facts — local knowledge is not a substitute for source links.
- `turn-recovery-context.js` `EXTERNAL_EVIDENCE_KINDS` untouched: on retry
  the model re-queries the KB; no cross-turn inheritance needed.

Tests: `test-evidence-ledger.mjs` (kind/query/success-gate/counts) and
`test-evidence-gate.mjs` (`hasEvidenceKind` true/false/count-fallback).
