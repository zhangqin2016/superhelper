# Context OS And Memory Compaction

Date: 2026-06-25

The target architecture is not "add a summary file." Lily should become a Context OS above the agent runtime.

Important product rule:

- Do not duplicate runtime-owned raw session history or native compaction when the underlying runtime already provides it.
- Use OpenCode for raw session history, tools, MCP, plugins, permissions, and any native session compaction capability it exposes.
- Add Lily-owned memory only where the product needs a stable cross-runtime layer: user preferences, project memory, session summary, evidence memory, failure memory, context budgets, and final-answer gates.

Design principle:

```text
Memory is retrieval.
Evidence is proof.
```

Memory can guide the agent toward likely relevant context, but strong claims still need fresh evidence through tool results and `EvidenceLedger`.

Top-level architecture:

```text
Runtime Adapter Layer
  -> capability probe: raw history, resume, native compaction, plugins, hooks

Lily Context OS
  -> MemoryRegistry
  -> ContextBudgetManager
  -> MemoryRetriever
  -> MemoryInjector
  -> BackgroundCompactionScheduler
  -> InvalidationEngine
  -> EvidenceLedger / FinalAnswerGate integration
```

Performance requirement:

- Ordinary turns must not scan or compact by default.
- Compression should run after turn completion or during idle time.
- Every injected memory item must have a budget cost and relevance reason.
- Long sessions should remain responsive through bounded injection and background compaction.

Use Claude Code / Codex-style session compaction as a reference pattern, but keep Lily's implementation runtime-agnostic.

Implemented first bridge slice:

- OpenCode shared config explicitly enables native `compaction.auto`, `compaction.prune`, `reserved`, and `tail_turns`.
- Lily's OpenCode SDK adapter exposes `session.summarize` using the generated SDK's `{ path, query, body }` shape.
- `OpencodeAgentSession.compactContext()` passes through to OpenCode summarize only while idle, and records successful compaction in session memory.
- `ContextBudgetManager` decides background compaction with constant-time checks: runtime capability, runner alive/busy, session turn count, and recent compaction interval.
- `TurnOrchestrator` schedules background compaction after completed turns without blocking final answer rendering.
- `session.compacted` runtime events become visible `compactComplete` notices and update session memory.

Implemented second bridge slice:

- Runtime capabilities now live in `src/main/runtime/runtime-capabilities.js`, not inside the event reducer. This gives Lily a stable adapter contract for OpenCode and future runtimes.
- `MemoryRegistry` (`src/main/memory-registry.js`) turns existing session/project/compaction memory into budgeted context items with reasons. Ordinary fast turns avoid memory injection; grounded/coverage turns and compacted sessions get bounded memory hints.
- `TurnOrchestrator` injects MemoryRegistry output through Lily's layered engine text and records injected item metadata in the turn trace.
- Memory text explicitly says it is continuity/retrieval context, not proof; strong claims still require EvidenceLedger/tool evidence.

Implemented third bridge slice:

- `session-memory` now persists final-answer evidence gaps when `EvidenceGate` downgrades an unsupported answer. This keeps the failure mode as memory, not just the answer text.
- `MemoryRegistry` injects recent evidence gaps with higher priority than ordinary session summary or compaction state. The injected instruction is explicit: do not repeat unsupported claims without gathering the missing evidence first.
- `TurnOrchestrator` carries this evidence-gap memory into short follow-up turns, so a user saying "continue" after a downgraded answer does not let the agent forget why the previous answer was not rigorous enough.
- This is deliberately stronger than plain context compaction: compaction preserves continuity; evidence-gap memory preserves epistemic obligations.

Implemented fourth bridge slice:

- `project-memory` reads only `memory/MEMORY.md`, with a character cap and mtime/size cache. It does not scan the workspace on ordinary turns.
- `MemoryRegistry` can inject the curated project memory index as a budgeted `project_memory` item for grounded/coverage/cold-start turns.
- `TurnOrchestrator` loads project memory only when the current policy actually benefits from continuity context: grounded work, coverage work, cold starts, rehydration, or short follow-ups.

Implemented fifth bridge slice:

- `TurnPolicy` now owns explicit memory budgets: fast turns default to zero ordinary memory, grounded turns get a bounded workspace-memory budget, and coverage turns get a larger budget.
- Fast turns still have a small `criticalMaxChars` channel for high-priority continuity such as evidence gaps and compaction state. This avoids both extremes: no stale bulk memory on casual turns, but no amnesia after a failed evidence gate.
- `MemoryRegistry` returns budget diagnostics: raw item count, selected count, skipped count, used chars, and skipped item reasons. The legacy `selectMemoryItems` API remains compatible.
- `TurnOrchestrator` includes memory diagnostics in turn trace without embedding skipped memory text, so platform debugging stays observable and cheap.

Implemented sixth bridge slice:

- Background compaction decisions now emit a session-level `context.compactionDecision` runtime event.
- The event is protocol-validated in `runtime-event-schema` and allowed by `RuntimeEventBus` after terminal turns.
- Payloads stay lightweight: action, reason, mode, turn count, and last compaction timestamp. Skipped decisions are observable without blocking the user-facing final answer.

Implemented seventh bridge slice:

- Project memory reads are bounded prefix reads. A huge `memory/MEMORY.md` no longer has to be fully loaded just to build a small context hint.
- Project memory results include `bytesRead`, `bytes`, and `truncated`, giving the platform a cheap way to debug memory load cost.
- Memory items carry provenance metadata: `trust` and `proof`. Session summaries, project memory, compaction state, and evidence-gap memory are all explicitly `proof: false`.
- `TurnOrchestrator` exposes memory provenance in trace summaries without embedding full skipped or selected memory text.

Implemented eighth bridge slice:

- `MemoryRegistry` computes a stable SHA-256 fingerprint for the selected memory context.
- `session-memory` records the last successfully injected memory fingerprint and injection stats.
- `TurnOrchestrator` suppresses duplicate memory injection when the same memory fingerprint was already sent to the runtime history, while still reporting `deduped: true` in trace.
- Cold starts and local rehydration do not use this suppression; they can re-inject memory to rebuild lost context.

Implemented ninth bridge slice:

- Session compaction advances a Lily `contextEpoch` and clears stale memory-injection fingerprints. Deduplication is therefore scoped to the current effective runtime context.
- Context-memory traces include `contextEpoch`, so debugging can distinguish pre-compaction and post-compaction injections.
- The OpenCode SDK adapter filters `session.summarize` payloads to the upstream schema (`providerID`, `modelID`, `auto`). Lily-only fields such as local decision reasons stay in Lily events/traces and are not sent to OpenCode.

Implemented tenth bridge slice:

- Lily emits a visible `compactBoundary` engine notice immediately before a Lily-triggered native OpenCode compaction call. This gives the UI a real lifecycle boundary, not just a completion event.
- The OpenCode reducer now preserves `sessionID` and `messageID` from `session.compacted` effects.
- `session-memory` stores the OpenCode engine session id and summary message id on `lastCompaction`, making compaction epochs auditable back to the upstream runtime anchor.

Implemented eleventh bridge slice:

- A dedicated gap audit now tracks what is done, partially done, and still missing against Claude Code / OpenCode-style context management.
- Explicit learned conventions from `learned-context` are now first-class `MemoryRegistry` items with budget, fingerprinting, provenance, and trace metadata.
- `TurnOrchestrator` loads learned conventions only for turns that already need context memory: grounded work, coverage work, cold starts, rehydration, or short follow-ups.

Implemented twelfth bridge slice:

- Auto memory promotion now has a proposal layer. Explicit "remember this" messages and clear user corrections can create app-side memory proposals.
- Proposals are deduped by normalized key and scoped per project.
- Turn archive creates proposals after committing records, but does not automatically promote them into official learned conventions. This avoids silently learning wrong rules.

Implemented thirteenth bridge slice:

- Proposed memories now have explicit list, approve, and dismiss IPC handlers.
- Approving a proposal promotes it through `learned-context` and refreshes the session guide, so future turns can receive it through the normal MemoryRegistry path.
- Dismissing a proposal keeps it out of default proposal lists and prevents repeated prompts for the same candidate.
- Turn archive emits a `memory.proposal` runtime event when it creates a new proposal. The renderer reacts to that event with a lightweight confirmation dialog instead of polling proposal files or scanning conversation history.

Implemented fourteenth bridge slice:

- Turn archive records assembled engine prompt size as `promptChars` and a conservative estimated token count.
- Session summaries persist the last and max prompt-pressure values, so background compaction decisions remain O(1).
- `ContextBudgetManager` can trigger native OpenCode compaction from token pressure before the turn-count threshold, while still respecting runner idle state and recent-compaction rate limits.
- `context.compactionDecision` events include prompt-pressure diagnostics for debugging without exposing full prompt text.

Implemented fifteenth bridge slice:

- `MemoryRegistry` now ranks candidate memory items against the current user text before budget selection.
- The first retrieval layer is deterministic and cheap: ASCII terms plus Chinese bigram matching, with high-priority safety/continuity memory preserved.
- Context-memory traces expose per-item relevance scores, so memory inclusion can be debugged without logging full skipped memory content.

Implemented sixteenth bridge slice:

- Session summaries now retain recent turn pointers and engine message ids.
- Memory items expose structured `sourcePointers` for session summaries, evidence gaps, compaction state, learned conventions, and project memory files.
- Turn traces include these source pointers, making injected memory auditable back to archived turns or source files without expanding the prompt text.

Implemented seventeenth bridge slice:

- Learned memory is now structurally manageable: list, remove one, and clear all while keeping the existing markdown storage format compatible.
- The Assistant IPC/preload layer exposes memory management methods and refreshes the session guide after learned-memory mutations.
- Settings now has a Memory page for the current workspace: confirmed memory, pending proposals, approve, dismiss, delete, and clear.
- Memory export returns a structured snapshot and the Settings page can copy it to the clipboard for debugging/support.

Implemented eighteenth bridge slice:

- `scripts/test-context-os-long-session.mjs` simulates 120 turns with prompt pressure, evidence gaps, learned conventions, source pointers, memory fingerprinting, and compaction epoch reset.
- This gives Context OS a focused long-session regression gate instead of relying only on isolated unit tests.

Implemented nineteenth bridge slice:

- The bounded workspace digest used by session guides is now also available to `MemoryRegistry`.
- Grounded, coverage, cold-start, and rehydrated turns can receive a budgeted `workspace_digest` memory item with provenance and source pointer metadata.
- Ordinary fast turns still do not scan or inject the workspace digest.

Implemented twentieth bridge slice:

- Session summaries now prefer real runtime `input_tokens` / prompt-token usage when available, falling back to assembled-prompt character estimates.
- Background compaction decisions expose the token source, so token-pressure behavior can be debugged as `runtime_usage` versus `estimated_chars`.

Implemented twenty-first bridge slice:

- Project-level memory preferences can disable specific memory categories.
- `MemoryRegistry` filters disabled categories before retrieval ranking and budget selection.
- Assistant IPC/preload and the Settings Memory page expose category toggles, with guide refresh after preference changes.

Implemented twenty-second bridge slice:

- `memory-explain` converts selected/skipped memory trace metadata into plain diagnostic explanations.
- `TurnOrchestrator` stores those explanations on the last context-memory injection summary.
- Memory exports can now include not only what was remembered, but why the last injected memory was selected.

Implemented twenty-third bridge slice:

- Memory items now carry `sourceVersion` metadata.
- `MemoryRegistry` includes source versions in the memory fingerprint, so changed source files/rules can invalidate dedupe even when the visible clipped text remains the same.
- Turn traces expose source versions for selected and skipped memory items.

Implemented twenty-fourth bridge slice:

- Turn archive now attaches a lightweight evidence graph to each record.
- The graph links the turn to tools, file changes, produced artifacts, and evidence gaps.
- This creates a stable substrate for future UI replay/inspection without re-parsing assistant text.

Implemented twenty-fifth bridge slice:

- `ContextBudgetManager` now has a provider/model-aware token fallback for assembled prompts when runtime usage is unavailable.
- Turn archive stores the fallback source as `estimated_provider_fallback`; session summaries still prefer real runtime usage when present.
- This reduces Chinese-heavy prompt undercounting without adding a tokenizer dependency to the default runtime.

Implemented twenty-sixth bridge slice:

- `MemoryRegistry` now fuses deterministic keyword/CJK relevance with local hashed-vector semantic relevance.
- The semantic layer is local and bounded to current candidate memory items, so it avoids per-turn workspace scans or network embedding calls.
- Turn traces expose `semanticRelevance` for selected memory items.

Implemented twenty-seventh bridge slice:

- Broad investigation and source-coverage turns now add a Subagent Context Isolation execution constraint.
- The constraint tells OpenCode-native subagents/task agents to shard large research work and return compact evidence handoffs instead of flooding the main context.
- Turn traces record whether isolation was enabled and why.

Implemented twenty-eighth bridge slice:

- Sealed assistant answers with archived evidence graphs now show an Evidence Graph action.
- The viewer displays graph nodes/edges and can copy a replay summary for support/debugging.
- The UI reads the graph from the committed message record, avoiding extra IPC and keeping replay inspection O(1).

Implemented twenty-ninth bridge slice:

- Turn archive now attaches a `contextOsScorecard` diagnostic to each record.
- The scorecard encodes the anti-drift rules for the Claude Code catch-up/beat goal: runtime boundary, token observability, fast-path boundedness, memory retrieval diagnostics, coverage evidence, coverage isolation, and evidence graph availability.
- This turns the architecture target into a testable contract instead of a vague "add more Context OS features" direction.

Implemented thirtieth bridge slice:

- `contextOsScorecard` now separates required parity checks from beat-Claude stretch checks.
- Stretch maturity only passes when the turn has exact token accounting, durable semantic retrieval, runtime-visible subagent handoff telemetry, and replayable evidence bundles.
- Current local-vector retrieval and prompt-level subagent isolation can pass parity, but remain visibly `maturity.beat=incomplete` until those stronger signals exist.

Implemented thirty-first bridge slice:

- The semantic memory layer now persists candidate-memory vectors in userData under `memory-vector-index/`.
- Index entries are invalidated by memory item id, kind, source version, and text hash, so source changes rebuild only affected vectors.
- This advances the beat-Claude stretch path from per-turn local vectors to durable semantic retrieval for the bounded memory candidate set, while preserving local fallback when userData is unavailable.

Implemented thirty-second bridge slice:

- Turn archive now attaches an `evidenceReplayBundle` beside the evidence graph.
- The bundle records replayable evidence handles: tool input summaries, file checkpoint/diff previews, artifact paths, and evidence-gap reasons.
- The Evidence Graph viewer now displays/copies replay bundle items on demand, keeping the default answer UI clean while making support/debug replay more concrete.

Implemented thirty-third bridge slice:

- Runtime-visible subagent telemetry is now represented as first-class evidence.
- `Task` tools create `subagent_handoff` nodes in the evidence graph, and child tools with `parentToolUseId` link back to the subagent handoff.
- Replay bundles include both subagent handoff inputs and child-tool evidence, so `beat_subagent_runtime_telemetry` is based on real tool events instead of prompt-only isolation guidance.

Implemented thirty-fourth bridge slice:

- Turn archive now prefers runtime-reported `input_tokens` as exact token accounting.
- When runtime usage is present, `estimatedPromptTokenSource` is `runtime_usage`, which satisfies the scorecard exact-token stretch without adding a tokenizer dependency.
- Provider/model-aware local estimates remain the fallback for providers or turns that do not report usage.

Implemented thirty-fifth bridge slice:

- Added an end-to-end Context OS beat maturity test.
- The test proves ordinary fast turns keep `maturity.beat=incomplete` while staying cheap, and a coverage turn can reach `maturity.beat=pass` only when all four stretch signals are real: runtime token usage, durable semantic diagnostics, subagent handoff telemetry, and replay bundle evidence.
- `scripts/test-context-os-beat-e2e.mjs` is now part of `npm run test:runtime`, so the acceptance gate runs with the normal runtime regression chain.
- This is the acceptance gate for "beat Claude Code" work: future changes should move real archived turns through this scorecard, not add standalone features without telemetry.
