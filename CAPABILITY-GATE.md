# Capability Gate — 防止"变笨"硬门槛

This is a HARD GATE for every change in this platform. A change that cannot pass it
does not ship. Its purpose: never let the product get *dumber* than it is today.

## The one rule

> **No change ships if it can make the product worse than today. Every feature's
> FAILURE MODE must degrade to today's behavior — fail open / fall back to the
> strong default — never to a worse state.**

Why this is the right test: a feature can only make the product dumber if, *when it
goes wrong*, the result is worse than not having the feature. If its failure mode
equals today's behavior, the worst case is "no improvement," which is acceptable.
So for every change, ask: **when this breaks, is it worse than today, or the same?**
Only "the same (or better)" passes.

## Gate checklist (every capability-affecting change must pass — a "no" blocks merge)

Applies to anything that changes how the agent answers, routes, executes, learns, or
remembers.

1. **Failure degrades to baseline.** When this errors / its input is missing /
   malformed / oversized / forged → does it fall back to today's behavior? Ship a
   test that proves the fallback. No silent break, no worse-than-today.
2. **No silent capability downgrade.** If it routes to a weaker model, fewer tools,
   or less context, there must be a guaranteed fallback to the strong default, and
   reasoning / critical work must never be downgraded.
3. **Bound non-progress, not effort.** Any stop / limit / timeout fires only on
   CONFIRMED no-progress (byte-identical repeat, unchanged output) — never on
   legitimate long or evolving work.
4. **Graceful, never silent-kill.** On a limit or error: recover partial output,
   nudge the model, or ask the user. Never silently abort or hand off to ad-hoc
   improvisation.
5. **No improvisation fallthrough.** When a structured path (learned flow, parsed
   intent, learned API contract) fails, surface it or ask — never silently let the
   model wing it with ad-hoc scripts/plans.
6. **Persona / context / memory invariants hold.** The workbench persona is not
   overridden by the engine's coding-CLI baseline; the per-turn system prompt stays
   within budget; long-session compaction still works.
7. **Closed-loop guard.** Add an automated test that FAILS if this capability
   regresses, and register it below.

## Known 变笨 vectors → their guard (the registry)

Every recurring "got dumber" cause must stay guarded. When you touch one of these,
the guard test must still pass; when you add a new capability, add a row.

| Vector (how it got dumber) | Guard (test / mechanism) |
|---|---|
| Coding-CLI persona overrides the workbench persona (default.txt) | `test-opencode-config-builder.mjs` — basePrompt suppresses the coding baseline for build/plan |
| Per-turn system prompt bloat | `test-context-budget-manager.mjs` — token-budget estimation + compaction trigger. **GAP:** no dedicated static prompt-size assertion yet — add one |
| Native compaction 500 → long-session memory lost | `test-opencode-config-builder.mjs` — compaction/title pinned to the resolvable main model; `test-context-budget-manager.mjs` |
| Subagent infinite nesting (套娃) | `test-subagent-telemetry.mjs` — `nestedTaskBreaches` detector; isolation prompt aligned to depth-1 cap |
| Runaway / doom loops | `test-loop-detector.mjs` — RESULT-AWARE (only byte-identical no-progress), graceful nudge, fail-open |
| Cross-session memory dropped on compaction | `test-compaction-memory-export.mjs` / `test-compaction-memory-plugin.mjs` — inject memory, fail open |
| Improvisation fallthrough (parse/learned-flow fails → model writes a script) | scheduled-task: recognized intent shows the card / interval floored, never improvises; web-system: no learned flow → "needs re-learn", not ad-hoc |
| Shallow learning → hollow, unusable capabilities | `test-web-system-har-contracts.mjs` — query-POST classified read + request fields → params; SPA render-wait before snapshot |
| Web automation breaks on session expiry / pagination / CSRF / writes | `test-web-system-{auth-refresh,pagination,csrf-rotation,idempotency,param-binding}.mjs` — all opt-in, capped, fail-safe |

## Enforcement

- **CLAUDE.md Rule 13** makes this gate binding for every task.
- Each vector above has an automated guard; the full suite (`npm run test:unit`
  + `test:renderer`/`test:runtime`/`test:service`/`test:skills`) must be green.
- Any new capability-affecting feature adds its own (1) failure-mode test proving
  it degrades to baseline and (2) closed-loop guard, and registers it here.
- "Closed-loop verified" means tested. "Looks fine" / "should work" does not pass —
  state honestly what is automated vs what still needs a live/build verification.
