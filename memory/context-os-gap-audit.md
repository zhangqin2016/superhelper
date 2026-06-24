# Context OS Gap Audit

Date: 2026-06-25

Goal: make Lily's long-running agent runtime at least not worse than Claude Code / Claude CLI patterns, while using OpenCode as the native runtime instead of rebuilding what OpenCode already owns.

Reference points checked:

- Claude Code official memory model: project/user/org `CLAUDE.md` plus auto memory, both treated as context rather than hard enforcement.
- Claude Code official context-window model: startup context, file reads, rules/hooks, subagents, and `/compact` behavior.
- Local OpenCode source: native `AGENTS.md` / `CLAUDE.md` instruction loading, session compaction, summarize schema, `session.compacted`, hidden compaction agent, compaction prompt, and plugin hooks.

Already covered:

- OpenCode-native raw history, resume, tools, permissions, MCP/plugin path are not duplicated by Lily.
- OpenCode native compaction is enabled and exposed through Lily background scheduling.
- Lily records compaction lifecycle: decision, boundary, completion, epoch, engine session id, and summary message id.
- Memory injection is budgeted, prioritized, fingerprinted, deduplicated, provenance-tagged, and trace-visible.
- Evidence gaps survive across turns and outrank ordinary memory.
- Project memory is bounded and cached; ordinary fast turns do not scan.
- Strong claims are gated by evidence ledger / final answer gate.
- Auto memory proposals can be inspected, approved, dismissed, and promoted into official learned memory only after user confirmation.
- New auto memory proposals publish a lightweight runtime event, so the renderer can prompt without polling or rescanning history.
- Background compaction can trigger from estimated assembled-prompt token pressure before the turn-count threshold, while still respecting idle/rate-limit guards.
- Memory selection now has a deterministic lightweight retrieval ranker: current user text can boost relevant memory items before budget selection.
- Memory items carry basic lossless source pointers such as turn ids, engine message ids, compaction summary ids, learned-memory project ids, and project-memory file paths.
- Memory management has app-level surfaces: list learned memory, remove one, clear learned memory, approve/dismiss pending proposals, and refresh the active session guide.
- Memory can be exported as a structured workspace/session snapshot from the Settings memory page.
- Long-session regression coverage now simulates 100+ turns, evidence gaps, memory fingerprinting, compaction pressure, and compaction epoch reset.
- Bounded workspace digest is now available as a MemoryRegistry item for grounded/coverage/cold-start turns, not only as a session-guide section.
- Token pressure uses real runtime `input_tokens` when available, falling back to a provider/model-aware local token estimate for assembled prompts.
- Memory categories can be disabled per workspace from Settings, and disabled categories are filtered before budget selection.
- Memory injection now persists plain-language explanations for selected/skipped items into session summary diagnostics.
- Memory fingerprints include source versions, so source changes can invalidate stale injected memory even when visible text is unchanged.
- Turn records now include a lightweight evidence graph linking turns, tools, file changes, artifacts, and evidence gaps.
- Memory retrieval is now hybrid: deterministic keyword/CJK matching plus local hashed-vector semantic relevance, with per-item `semanticRelevance` trace diagnostics.
- Semantic memory vectors are now persisted per workspace in userData when available, keyed by source version and text hash. Tests/CLI without userData fall back to local per-turn vectors.
- Broad coverage/research turns now inject a Subagent Context Isolation execution constraint that tells OpenCode-native subagents/task agents to keep large reads out of the main context and return compact evidence handoffs.
- Sealed assistant answers with an evidence graph expose a renderer Evidence Graph viewer with copyable replay text.
- Turn archives now include a Context OS scorecard. It separates parity checks from beat-Claude stretch checks, so a turn can pass required anti-drift rules without pretending the platform has already surpassed Claude Code.
- Turn archives now include an evidence replay bundle with tool inputs, file checkpoint/diff previews, artifact paths, and evidence-gap reasons. The Evidence Graph viewer can show/copy this bundle on demand.
- Runtime-visible Task tools and child tools with `parentToolUseId` now become `subagent_handoff` evidence graph nodes and replay bundle entries, so subagent isolation is no longer only a prompt-level contract when the runtime exposes tool telemetry.
- Exact token accounting now uses runtime `input_tokens` as the top-priority source in turn archives and scorecards. When runtime usage is unavailable, Lily keeps the provider-aware fallback instead of adding a heavy tokenizer dependency.
- End-to-end beat maturity is now tested: a fast turn must remain cheap and `beat=incomplete`, while a fully evidenced coverage turn can reach `beat=pass` only with all four stretch signals present.

Partially covered:

- Explicit user learned conventions exist in `learned-context` and are now first-class Context OS memory items with budget/trace/provenance.
- Project memory currently reads `memory/MEMORY.md`; it does not yet index multiple curated memory layers.
- Retrieval is local-vector based by default and now has a durable candidate-memory vector cache; it is not yet backed by external embedding models or a workspace-wide multi-file semantic store.
- Evidence replay can inspect/copy the archived graph plus replay bundle; it does not yet re-run original tools or open a full time-travel file snapshot.
- Token pressure has exact runtime usage when OpenCode/provider reports it and provider/model-aware fallback otherwise; it still cannot see hidden upstream runtime history before the provider reports usage.
- OpenCode compaction hooks are respected by not inventing unsupported payload fields, but Lily does not yet provide a plugin-side compaction prompt customizer.

Still missing for a top-tier platform:

- Workspace-wide semantic memory index: extend beyond current candidate memory items into larger curated memory/project notes, with pruning and migration.
- Evidence replay export/time-travel: add open/export flows over the replay bundle and optional full file snapshots for richer forensic replay.
- Richer OpenCode subagent telemetry: capture more detailed subagent lifecycle metadata if OpenCode exposes agent names, summaries, or handoff completion payloads beyond Task/parent tool ids.
- Optional provider tokenizer integration: only add official tokenizer libraries if they are lightweight or already bundled; runtime usage remains the preferred exact source.

Architecture guardrail:

- "Beat Claude Code" means superior long-task reliability and observability, not more panels or prompt text.
- Default turns must remain cheap: no workspace scan, no ordinary memory injection, no semantic index rebuild.
- Broad/coverage turns must pay for rigor with evidence ledger + isolation diagnostics.
- Runtime-owned history/tools/permissions/compaction stay in OpenCode; Lily owns cross-runtime memory, evidence, budgets, and product-facing explanation.
- Scorecard `maturity.parity=pass` means the turn respected the current architecture contract. `maturity.beat=pass` is reserved for exact tokenizers, durable semantic index, real subagent telemetry, and replayable evidence bundles.
