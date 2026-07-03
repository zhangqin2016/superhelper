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
| Legacy engine guide mirror reappears and splits the source of truth, or guide migration drops user-authored content | `test-skill-catalog.mjs` + `test-data-migration.mjs` — AGENT.md is canonical; guide generation must not create `CLAUDE.md`; startup migrates/removes stale legacy files while preserving distinct content; later guide refreshes only replace the Lily-managed block |
| Per-turn system prompt bloat | `test-context-budget-manager.mjs` — token-budget estimation + compaction trigger. **GAP:** no dedicated static prompt-size assertion yet — add one |
| Native compaction 500 → long-session memory lost | `test-opencode-config-builder.mjs` — compaction/title pinned to the resolvable main model; `test-context-budget-manager.mjs` |
| Subagent infinite nesting (套娃) | `test-subagent-telemetry.mjs` — `nestedTaskBreaches` detector; isolation prompt aligned to depth-1 cap |
| Subagents fall back to a generic coding baseline and skip Lily's evidence discipline | `test-opencode-config-builder.mjs` + `test-skill-catalog.mjs` — shared subagent config injects Lily Subagent Rules; subagents must return evidence-backed summaries and must not spawn nested Task subagents |
| Runaway / doom loops | `test-loop-detector.mjs` — RESULT-AWARE (only byte-identical no-progress), graceful nudge, fail-open |
| Cross-session memory dropped on compaction | `test-compaction-memory-export.mjs` / `test-compaction-memory-plugin.mjs` — inject memory, fail open |
| Improvisation fallthrough (parse/learned-flow fails → model writes a script) | scheduled-task: recognized intent shows the card / interval floored, never improvises; web-system: no learned flow → "needs re-learn", not ad-hoc |
| Shallow learning → hollow, unusable capabilities | `test-web-system-har-contracts.mjs` — query-POST classified read + request fields → params; SPA render-wait before snapshot |
| Web learning depends on the model remembering every professional step | `test-web-system-learning-orchestrator.mjs` + `test-web-system-learning-skill.mjs` — one default `learn_web_system.cjs` orchestrator plans contract discovery, bootstrap HAR, JS intelligence, source-seeded expanded scan, HAR merge, auth recipe, and finalizer; normal learning forbids ad-hoc here-doc/browser scripts |
| Learned web skills still pop browser pages during normal use | `test-web-system-api-execution.mjs` + `test-web-system-learning-skill.mjs` — all-API execution stays HTTP/browser-free; API fallback is skipped unless `--allow-browser-fallback` is explicit; browser primary plans return `BROWSER_EXECUTION_DISABLED` unless `--allow-browser` is explicit |
| SPA learning misses APIs hidden in page JavaScript bundles | `test-web-system-frontend-source-intelligence.mjs` — analyzes large same-domain JS asset sets, fetches missing protected JS bodies with storageState, extracts endpoint+method hints, persists them as non-executable `apiHints`, and auto-generates frontend source from `scan.harPath` in the finalizer |
| Web automation breaks on session expiry / pagination / CSRF / writes | `test-web-system-{auth-refresh,pagination,csrf-rotation,idempotency,param-binding}.mjs` — all opt-in, capped, fail-safe |
| Optional runtime installation corrupts or weakens the base execution environment | `test-runtime-pack-installer.mjs` + `test-runtime-packs.mjs` + `test-runtime-pack-settings-ui.mjs` + `test-runtime-release-policy.mjs` — failed installs leave no target dir; missing artifact dirs are not treated as installed; bundled read-only packs work without userData install state; Python packs enter PYTHONPATH only when marked `pythonPath`; native/browser packs enter PATH/env through catalog metadata; settings UI cannot uninstall bundled packs; release scripts require platform runtime + LibreOffice instead of shipping a package that downloads runtime on first use |
| Steer ("插话") drops/abort-restarts a message instead of injecting into the running turn | `test-turn-orchestrator-steer.mjs` — on by default, kill-switch `LILY_ENABLE_STEER=0`; engine-reject / kill-switch both degrade to the queue (today's behavior) |
| Conversation minimap navigator breaks the chat / desyncs from the transcript | `test-conversation-minimap.mjs` (model) + `conversation-minimap-regression` in `test-renderer-import.cjs` (DOM); DOM-derived + try/catch teardown → any failure removes the rail, chat scrolls as today |
| **DATA LOSS:** session index wiped — root cause was (a) non-atomic write → interrupted write leaves a corrupt file, (b) corrupt read silently treated as "empty", (c) `load()` then auto-creates + `saveImmediate()` overwrites it, (d) `reconcile` prunes all sessions when projects fail to load | `test-session-load-recovery.mjs` + `test-session-save-guard.mjs` — ATOMIC write (tmp→rename) + rolling `.bak`; corrupt read is quarantined & recovered from `.bak` (not emptied); failed load bails (no auto-create/save); empty project set never prunes; `_guardSessionCollapse` refuses overwriting a healthy/corrupt index with a collapsed one |
| Non-essential renderer module statically imported into the bootstrap chain (app.js→message.js→…) can blank the whole app on load failure | message.js loads the minimap via guarded `import().catch()` (not a static import) → a broken optional module degrades to "no minimap", never "no chat/sessions" |
| Media-gen (image/video) distribution must not break old clients/servers or leave a device with no media | `test-client-config-service.mjs` (resolveMediaSelection): no `config.media` → all key-backed providers + server default (today); selection gated by available keys; default falls back; old clients ignore the additive `effectiveConfig.media`; client `serviceSelection` null on old servers → today's behavior |
| Background service startup must not weaken OpenCode foreground Bash or leave invisible detached processes | `test-process-jobs-core.mjs` + `test-process-jobs-mcp.mjs` + `test-process-job-protocol.mjs` + `test-mcp-config.mjs` — adds an optional `lily_process_jobs` MCP with PID/log/health/stop; MCP unavailable guidance falls back to normal foreground shell; OpenCode `bash` lifecycle is untouched |

## Enforcement

- **AGENTS.md Rule 13** makes this gate binding for every task.
- Each vector above has an automated guard; the full suite (`npm run test:unit`
  + `test:renderer`/`test:runtime`/`test:service`/`test:skills`) must be green.
- Any new capability-affecting feature adds its own (1) failure-mode test proving
  it degrades to baseline and (2) closed-loop guard, and registers it here.
- "Closed-loop verified" means tested. "Looks fine" / "should work" does not pass —
  state honestly what is automated vs what still needs a live/build verification.
