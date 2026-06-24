# Memory Index

- [Office Runtime Delegation](office-runtime-delegation.md) — never hand-roll document parsing/generation; use the bundled Python top-tier libs
- [No UI, Natural Language](no-ui-natural-language.md) — drive operations through the agent via natural language, don't pile up UI panels
- [Server Deploy Flow](server-deploy-flow.md) — prod is source-build-on-server via push-via-qiniu.sh; runtime-pack release path; SSH deploy key
- [Vision Pipeline](vision-pipeline.md) — main LLM is text-only; Qwen vision-to-text bridges images; the timeout/silent-drop bug + fix
- [Config Delivery Scopes](config-delivery-scopes.md) — per-target model/config delivery: scopes global/group/license/device, priority merge, tier groups
- [OpenCode Session Demux Idle Boundary](2026-06-24-opencode-session-demux-idle.md) — unowned shared-serve `session.idle` events must not broadcast across same-directory sessions
