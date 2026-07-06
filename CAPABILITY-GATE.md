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
| Native compaction 500 → long-session memory lost | `test-opencode-config-builder.mjs` — compaction/title pinned to the resolvable main model; `test-context-budget-manager.mjs`; `test-opencode-sdk-session.mjs` — SDK summarize uses top-level `sessionID`, not generated-client route placeholders |
| Subagent infinite nesting (套娃) | `test-subagent-telemetry.mjs` — `nestedTaskBreaches` detector; isolation prompt aligned to depth-1 cap |
| Subagents fall back to a generic coding baseline and skip Lily's evidence discipline | `test-opencode-config-builder.mjs` + `test-skill-catalog.mjs` — shared subagent config injects Lily Subagent Rules; subagents must return evidence-backed summaries and must not spawn nested Task subagents |
| Runaway / doom loops | `test-loop-detector.mjs` — RESULT-AWARE (only byte-identical no-progress), graceful nudge, fail-open; loop hints must not tell the model to downgrade just because work is slow |
| Cross-session memory dropped on compaction | `test-compaction-memory-export.mjs` / `test-compaction-memory-plugin.mjs` — inject memory, fail open |
| Improvisation fallthrough (parse/learned-flow fails → model writes a script) | scheduled-task: recognized intent shows the card / interval floored, never improvises; web-system: no learned flow → "needs re-learn", not ad-hoc |
| Shallow learning → hollow, unusable capabilities | `test-web-system-har-contracts.mjs` — query-POST classified read + request fields → params; SPA render-wait before snapshot |
| Web learning depends on the model remembering every professional step | `test-web-system-learning-orchestrator.mjs` + `test-web-system-learning-skill.mjs` — one default `learn_web_system.cjs` orchestrator plans contract discovery, bootstrap HAR, JS intelligence, source-seeded expanded scan, HAR merge, auth recipe, and finalizer; normal learning forbids ad-hoc here-doc/browser scripts |
| Learned web skills still pop browser pages during normal use | `test-web-system-api-execution.mjs` + `test-web-system-learning-skill.mjs` — all-API execution stays HTTP/browser-free; API fallback is skipped unless `--allow-browser-fallback` is explicit; browser primary plans return `BROWSER_EXECUTION_DISABLED` unless `--allow-browser` is explicit |
| SPA learning misses APIs hidden in page JavaScript bundles | `test-web-system-frontend-source-intelligence.mjs` — analyzes large same-domain JS asset sets, fetches missing protected JS bodies with storageState, extracts endpoint+method hints, persists them as non-executable `apiHints`, and auto-generates frontend source from `scan.harPath` in the finalizer |
| Web automation breaks on session expiry / pagination / CSRF / writes | `test-web-system-{auth-refresh,pagination,csrf-rotation,idempotency,param-binding}.mjs` — all opt-in, capped, fail-safe |
| Optional runtime installation corrupts or weakens the base execution environment | `test-runtime-pack-installer.mjs` + `test-runtime-packs.mjs` + `test-runtime-pack-settings-ui.mjs` + `test-runtime-pack-main-progress-ui.mjs` + `test-runtime-release-policy.mjs` — failed installs leave no target dir; missing artifact dirs are not treated as installed; bundled read-only packs work without userData install state; Python packs enter PYTHONPATH only when marked `pythonPath`; native/browser packs enter PATH/env through catalog metadata; settings UI cannot uninstall bundled packs; main chat stays background-silent for normal install progress while failures remain visible; release scripts require platform runtime + LibreOffice instead of shipping a package that downloads runtime on first use |
| UI-first workflow makes natural-language tasks feel blocked or less intelligent | `test-capability-broker.mjs` + `test-chat-native-dependency-flow.mjs` + `test-skill-catalog.mjs` — capability context is chat-native, fail-open, bounded, and only injected for operational turns; the composer must not import runtime-pack preflight/install code; main/subagent guides prefer capability contracts over telling the user to click UI first |
| Capability context bloats ordinary chat and slows or weakens model reasoning | `test-capability-broker.mjs` — ordinary casual text does not inject capability context; files, dependency advisories, grounded/coverage turns, or explicit operational requests do inject bounded context |
| First-party skills decay into one-off prompt hacks that bypass platform capability contracts | `test-skill-capability-contracts.mjs` + `test-long-task-supervisor-migration.mjs` — operational skills must start from natural language, fail open, route long work through `lily_process_jobs`, expose `job_status`/`job_logs`, avoid UI-first operation, and forbid ad-hoc runtime installs when a Lily pack exists |
| User-imported workspace skills overwrite platform skills or leak into unrelated workspaces | `test-workspace-skill-import.mjs` + `test-skill-catalog.mjs` — standalone workspace skill imports normalize non-learned ids into `learned-*`, reject protected bundled skills and dependency folders, mark imports as workspace-only, bind them to the active project, and fail without mutating existing skills |
| Lily platform skills are mistaken for OpenCode native `skill` commands, so `lily-*` capabilities appear "not found" | `test-opencode-config-builder.mjs` + `test-opencode-runtime-reducer.mjs` + `test-turn-orchestrator-steer.mjs` + `test-skill-catalog.mjs` + `test-capability-broker.mjs` + `test-runtime-pack-preflight.mjs` + `test-web-system-learning-intent.mjs` — OpenCode native `skill` is denied in runner permissions; AGENT.md/index/subagent prompts say `lily-*` are platform capability guides, not native skills; dependency/web-learning prompts route through Lily MCP/tools/scripts instead of `skill lily-*`; reducer-level fallback annotates native `skill lily-*` failures with the Lily guide path and emits a bounded steer recovery so the task does not stop at "not found" |
| Non-high-risk first-party skills exist in the catalog but are not installed/enabled by default | `test-skill-catalog.mjs` — non-high-risk Lily skills such as stock research, skill quality, and intent eval must be `defaultEligible`; only high-risk/on-demand skills such as mail and web-system learning may stay default-off |
| Long-running primary work is mistaken for failure, causing the agent to switch to a weaker/secondary path | `test-opencode-agent-session.mjs` + `test-loop-detector.mjs` + `test-skill-catalog.mjs` — active foreground tools extend the no-progress lease and emit observable progress instead of force-ending; loop hints require progress evidence before route changes; AGENT.md states "slow is not failure" and forbids secondary/degraded approaches until explicit failure, user stop, or proven no-progress |
| Steer ("插话") drops/abort-restarts a message, or hides/merges a visible follow-up after restart, instead of injecting into the running turn | `test-turn-orchestrator-steer.mjs` + `test-session-runtime-store.mjs` + `test-message-store.mjs` + `test-opencode-conversation-source.mjs` + `test-message-render-keys.mjs` — on by default, kill-switch `LILY_ENABLE_STEER=0`; engine-reject / kill-switch both degrade to the queue (today's behavior); accepted steers persist as same-turn user messages with `meta.steer`, survive busy sync, projection recovery, official-history merge, and render-key de-dupe |
| Conversation minimap navigator breaks the chat / desyncs from the transcript | `test-conversation-minimap.mjs` (model) + `conversation-minimap-regression` in `test-renderer-import.cjs` (DOM); DOM-derived + try/catch teardown → any failure removes the rail, chat scrolls as today |
| **DATA LOSS:** session index wiped — root cause was (a) non-atomic write → interrupted write leaves a corrupt file, (b) corrupt read silently treated as "empty", (c) `load()` then auto-creates + `saveImmediate()` overwrites it, (d) `reconcile` prunes all sessions when projects fail to load | `test-session-load-recovery.mjs` + `test-session-save-guard.mjs` — ATOMIC write (tmp→rename) + rolling `.bak`; corrupt read is quarantined & recovered from `.bak` (not emptied); failed load bails (no auto-create/save); empty project set never prunes; `_guardSessionCollapse` refuses overwriting a healthy/corrupt index with a collapsed one |
| Reopened conversations look empty because the UI waits for OpenCode official history before showing the local latest page | `test-opencode-conversation-source.mjs` + `test-renderer-import.cjs` — initial conversation loads use a local-first latest page and request official OpenCode history in the background; older pagination and official refresh remain available |
| Switching conversations blocks the UI while preparing OpenCode runner/session guides on slower Windows filesystems | `test-session-switch-fast.mjs` + `test-turn-orchestrator.mjs` — session switch changes visible state immediately and only warms the runner in the background; sends, rewinds, skill changes, and other execution paths still call the strong `ensureSessionRunner` path before acting |
| **DATA LOSS:** streamed assistant text disappears if the app crashes before `assistant.final` / terminal archive | `test-message-store.mjs` + `test-opencode-conversation-source.mjs` + `test-session-runtime-store.mjs` — `assistant.delta` is projected durably into SQLite; open projected turns are recovered as visible `turn.stalled` assistant messages across reopen; OpenCode official history merges local projections even while the runner is busy, so partial answers are not hidden by an incomplete official page |
| Non-essential renderer module statically imported into the bootstrap chain (app.js→message.js→…) can blank the whole app on load failure | message.js loads the minimap via guarded `import().catch()` (not a static import) → a broken optional module degrades to "no minimap", never "no chat/sessions" |
| Media-gen (image/video/speech) distribution must not break old clients/servers or leave a device with no media | `test-client-config-service.mjs` (resolveMediaSelection): no `config.media` → all key-backed providers + server default (today); selection gated by available keys; default falls back; old clients ignore the additive `effectiveConfig.media`; client `serviceSelection` null on old servers → today's behavior. `test-agent-env-media.mjs`: server-delivered media gateway env (`LILY_IMAGE_PROVIDER`, `LILY_VIDEO_PROVIDER`, `LILY_SPEECH_PROVIDER`, DashScope/Ark/Kling/MiniMax/Zhipu proxy URLs and short tokens) survives spawn env conversion so generation skills can actually call the gateway. `test-admin-media-provider-surface.mjs`: admin config surfaces built-in Lily image/video/speech services and profile rules can select Lily + speech without leaking upstream endpoints. `test-media-provider-settings.mjs`: client settings keep configured first-party Lily media visible even when a stale media allow-list only named DashScope. `test-media-provider-contracts.mjs`: server-delivered media request contracts are additive, scoped to actually available providers, and injected into client runtime env. `test-agent-guide-i18n.mjs`: AGENT.md exposes current media/search providers and selected provider contract parameters instead of hardcoded vendor guesses. `test-media-gateway-providers.mjs` + `test-media-generation-skills.mjs`: Lily GPU private/relative asset URLs are rewritten through the gateway, downloaded with the short Lily token, and speech generation can execute from the server-delivered contract defaults without leaking 127.0.0.1 result URLs to clients. |
| User-selected media providers are bypassed after an error, causing the agent to silently switch to another vendor | `test-agent-guide-i18n.mjs` — AGENT.md exposes image/video/speech/search provider selections, dynamically describes media skills using the selected provider, and explicitly forbids automatic provider fallback after a configured provider error; the agent must report the error and ask the user whether to retry, switch provider, or provide a key. |
| Native-vision model toggles are saved but stale config profiles still route images through the weaker bridge path | `test-client-config-service.mjs` — provider metadata `nativeVision:true` and profile `capabilities.vision:true` both expand to preset `capabilities.vision:true`; stale generated `vision:false` cannot suppress the provider's current native-vision capability |
| Background service startup must not weaken OpenCode foreground Bash or leave invisible detached processes | `test-process-jobs-core.mjs` + `test-process-jobs-mcp.mjs` + `test-process-job-protocol.mjs` + `test-mcp-config.mjs` — adds an optional `lily_process_jobs` MCP with PID/log/health/stop; MCP unavailable guidance falls back to normal foreground shell; OpenCode `bash` lifecycle is untouched |
| Long tasks look stuck because the platform cannot show liveness, phase, or output hints | `test-process-job-observability.mjs` + `test-process-jobs-core.mjs` — process jobs expose compatible `status` plus normalized `state`, progress-derived `phase`, `heartbeatAt`, `outputFiles`, `recoverable`, logs, and existing PID/log paths without changing foreground tool behavior |
| Foreground upload/download commands look dead or require feature-specific UI | `test-work-progress-protocol.mjs` + `test-opencode-runtime-reducer.mjs` + `work-progress-notice-regression` in `test-renderer-import.cjs` — generic progress inference emits optional `workProgress` notices for recognizable transfer output/commands; parse failure returns null, keeps foreground Bash execution unchanged, and the chat falls back to today's text/tool row |
| Model traffic may silently bypass Lily Gateway or be impossible to audit | `test-model-route-audit.mjs` + `test-opencode-model-config.mjs` — final resolved `LILY_*` env is classified as gateway/direct/invalid with redacted URL/key-kind diagnostics; route audit is attached to OpenCode config diagnostics and runner diagnostics without changing routing |
| OpenCode protocol selection falls back to URL guessing and loses tool calls on OpenAI-compatible providers | `test-opencode-model-config.mjs` + `test-client-config-service.mjs` + `test-model-settings-secret-storage.mjs` + `test-scheduled-tasks.mjs` — service presets explicitly deliver OpenCode provider id/npm/base/protocol; customer custom models/gateways persist protocol; legacy URL heuristics are migration fallback only |
| Edge service DNS/routing failure silently makes remote config fail and leaves the model on direct fallback | `test-service-client-edge-fallback.mjs` — UAE edge network failure falls back to the canonical domestic service for bootstrap and signed service calls, pins the runtime service base to the reachable host, and keeps the agent route auditable |
| OpenCode resume id crosses Lily conversations, causing one chat to inherit another chat's history, tools, or skills | `test-resume-binding.mjs` + `test-resume-continuity-guard.mjs` + `test-ensure-session-runner-resume-reset.mjs` — every new resume id is bound to the Lily session/project/workspace/skill-set/version/first-user fingerprint; mismatches clear the resume and start fresh with local-history rehydration, while legacy unbound resumes fail open to a recent-history continuity guard instead of silently trusting the engine cache |
| Malformed or empty OpenCode completions are treated as completed answers and then poison summaries or compaction memory | `test-turn-error-classify.mjs` + `test-turn-orchestrator.mjs` + `test-session-memory.mjs` + `test-compaction-memory-export.mjs` + `test-remote-config-gateway-token-expiry.mjs` — leaked `<tool_call>/<function>/<parameter>` fragments and empty assistant completions become retryable protocol failures, are never stored as assistant memory, are never injected back into compaction memory, and expired Lily gateway tokens invalidate remote config so sends refresh instead of running on stale credentials |

## Enforcement

- **AGENTS.md Rule 13** makes this gate binding for every task.
- Each vector above has an automated guard; the full suite (`npm run test:unit`
  + `test:renderer`/`test:runtime`/`test:service`/`test:skills`) must be green.
- Any new capability-affecting feature adds its own (1) failure-mode test proving
  it degrades to baseline and (2) closed-loop guard, and registers it here.
- "Closed-loop verified" means tested. "Looks fine" / "should work" does not pass —
  state honestly what is automated vs what still needs a live/build verification.
