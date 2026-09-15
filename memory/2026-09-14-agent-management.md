# 智能体管理 (Agent Management)

An agent is a HOST-OWNED bundle over dimensions Lily already had: role card,
skills, knowledge packs, autonomy, model, tool policy, automations. It is
configuration, never prompt text: the role stays a lower-authority suffix and
the role activation contract ("a role never changes tools") is untouched.
Code: `src/main/agents/`; design + status: `docs/agent-management-design.md`.

Activation calls the EXISTING setters (character set-binding, session skills,
permission mode, model selection, paused automation import). Every dimension
fails open independently with a named receipt reason; deactivation restores
the pre-activation snapshot. Hot dimensions (role/skills/knowledge/autonomy)
ride AGENT.md + host policy on the next prompt; cold ones (model,
tools.disallow) fork the shared serve and degrade beyond
`LILY_AGENT_SERVE_FORK_LIMIT` (3). `tools.mcpAllow`/`connectors` are advisory.

Storage mirrors character-worlds: owner-scoped entities, immutable revisions,
CAS session binding, append-only events (`MessageStore.agents()`). The legal
counsel's hard-coded knowledge-pack coupling is now data
(`knowledge.packs: ["legal-cn-enterprise"]`); `legal-kb/turn-preparation.js`
prepares "legacy role rule ∪ bound agent packs" and still blocks by pack id.

Natural-language creation: "做一个…智能体" routes to the inert platform tool
`lily_agent_draft` (never binds). Distribution: `GET /api/agents/registry`
(Bearer when logged in) + signed `config.agents.{available,default}`; installed
as `distributed` revisions; a targeted default binds on `session:create`.
Portability: `.lilyspace/agents.json` (definitions only, local role cards
embedded on opt-in). Kill switch `LILY_AGENTS=0`. Character Worlds server
default flipped to enabled (2026-09-14) because agents need the role layer.

Gate: `agent-management` (10 deterministic tests). Not claimed: installed
client acceptance, real-model drafting quality, `@智能体` in chat.
