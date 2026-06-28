# Memory Index

- [Office Runtime Delegation](office-runtime-delegation.md) — never hand-roll document parsing/generation; use the bundled Python top-tier libs
- [No UI, Natural Language](no-ui-natural-language.md) — drive operations through the agent via natural language, don't pile up UI panels
- [Server Deploy Flow](server-deploy-flow.md) — prod is source-build-on-server via push-via-qiniu.sh; runtime-pack release path; SSH deploy key
- [Vision Pipeline](vision-pipeline.md) — main LLM is text-only; Qwen vision-to-text bridges images; the timeout/silent-drop bug + fix
- [Config Delivery Scopes](config-delivery-scopes.md) — per-target model/config delivery: scopes global/group/license/device, priority merge, tier groups
- [OpenCode Session Demux Idle Boundary](2026-06-24-opencode-session-demux-idle.md) — unowned shared-serve `session.idle` events must not broadcast across same-directory sessions
- [Context OS And Memory Compaction](context-os-memory-compaction.md) — do not duplicate runtime raw history; build Lily's cross-runtime memory, compaction, budget, and evidence layer above OpenCode
- [Context OS Gap Audit](context-os-gap-audit.md) — remaining work to reach/beat Claude Code-style context and memory management
- [Workspace Pack Compatibility](2026-06-28-workspace-pack-compat.md) — new root-layout `.lilyspace.zip` exports must retain a legacy mirror so older clients can import shared apps
- [OpenCode Prompt Acceptance Watchdog](2026-06-28-opencode-prompt-acceptance-watchdog.md) — `promptAsync` success does not prove a turn started; verify owned activity or recover/fail without hanging
- [OpenCode Prompt Acceptance Watchdog](2026-06-28-opencode-prompt-acceptance-watchdog.md) — `promptAsync` success is not enough; verify the turn actually starts, and anchor history recovery to the current user prompt
