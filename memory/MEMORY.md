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
- [Clipboard Document Paste](2026-06-29-clipboard-document-paste.md) — native clipboard file formats need main-process fallback; document extraction failure must fail loud instead of answering blind
- [Read-Only Tool Transient Replay](2026-06-29-readonly-tool-transient-replay.md) — file/directory inspection turns may replay once after a transient model disconnect if only read-only tools ran
- [Conversation Minimap Click Jump](2026-06-29-minimap-click-jump.md) — data-sourced minimap ribs must scroll the owning panel directly when the target prompt is already rendered
- [Generated Media Placeholder Path](2026-06-29-generated-media-placeholder-path.md) — renderer generated-media cards must reject placeholder paths like `/absolute/path/to/generated-assets/name.svg`
- [Conversation Minimap Session Isolation](2026-06-29-minimap-session-isolation.md) — shared minimap rails must be cleared and async minimap updates must re-check the active session
- [Web Learning Special Browser Context](2026-06-29-web-learning-special-browser-context.md) — special enterprise systems must stop with a recoverable state instead of stealth/headless retry loops
- [Web Learning Persistent Profile](2026-06-29-web-learning-persistent-profile.md) — manual web login capture uses per-system persistent Lily browser profiles while automation still reuses filtered storageState
