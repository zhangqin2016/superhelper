# Session Tool Broker Design

## Goal

Make Lily extension tools truly session-scoped while keeping the OpenCode shared
serve topology. A tool from mail, browser, runtime packs, or a learned web
system must be invisible to the model unless the current Lily session has the
corresponding skill/capability enabled.

This is a tool-discovery boundary, not just a prompt rule. Disabled capabilities
must not appear in the MCP tool list for that session.

## Non-Goals

- Do not broker OpenCode native code tools such as read, edit, bash, grep, glob,
  or LSP in this phase.
- Do not replace OpenCode's shared serve or official SDK usage.
- Do not add a generic `lily_tool_call` escape hatch.
- Do not keep per-session MCP config generation as the long-term control plane.

## Current Problem

The app now runs one shared `opencode serve` for all sessions. That is the right
runtime topology, but MCP registration is still serve-level. When an MCP server
is included in the shared config, every session attached to that serve can see
it unless the serve is rebuilt with a different config.

The current short-term fix passes `activeSkillIds` into MCP assembly, which
prevents obvious learned web-system leakage. It is still not the final design:
the serve config remains a shared artifact, so session-specific tool visibility
is coupled to serve rebuilds.

## Decision

Use one stable Lily MCP server named `lily_tool_broker`. OpenCode sees only this
broker server. The broker exposes real, typed tools dynamically for the current
Lily session:

```text
OpenCode shared serve
  -> MCP: lily_tool_broker
  -> session context resolver
  -> tool registry
  -> allowed tool list
  -> delegated executor
```

Tools remain explicit and model-friendly:

- `mail_list_accounts`
- `mail_search`
- `mail_read`
- `mail_send`
- `browser_open`
- `browser_click`
- `browser_screenshot`
- `runtime_pack_list`
- `runtime_pack_install`
- `web_<system>__<capability>`

Disabled tools are not returned by MCP tool discovery. Runtime handlers still
perform authorization again before execution.

## Components

### `tool-broker-registry.js`

Defines all broker-capable tools as data plus handlers.

Each tool definition includes:

- `id`: stable MCP tool name.
- `title`: short display label.
- `description`: model-facing description.
- `inputSchema`: Zod schema or MCP-compatible schema.
- `requiredSkillIds`: skill ids that make the tool visible.
- `risk`: `read`, `prepare`, `submit`, or `destructive`.
- `capability`: domain identifier such as `mail`, `browser`, `runtime-pack`,
  or `web-system`.
- `handler(ctx, input)`: executor.

Static tools are registered directly. Dynamic tools, such as learned web-system
capabilities, are expanded from installed skill artifacts at discovery time.

### `tool-broker-context.js`

Resolves the Lily session context for a broker request.

Context fields:

- `sessionId`
- `projectId`
- `workspacePath`
- `activeSkillIds`
- `permissionMode`
- `license`
- `connectorStatus`
- `runtimePackState`

The resolver must fail closed. If the session cannot be resolved, broker returns
no session-scoped tools and rejects calls.

### `tool-broker-mcp.js`

Implements the MCP server surface.

Responsibilities:

- `listTools`: return only tools allowed by the resolved session context.
- `callTool`: resolve context again, verify the tool is still allowed, enforce
  confirmation policy, then run the handler.
- Redact secrets from logs and errors.
- Return structured JSON text content for tool results.

### `tool-broker-stdio.js`

Stable stdio entrypoint launched by OpenCode.

It connects to the Electron main process through the existing local bridge
pattern where secrets or app state are needed. The stdio process should not hold
mail credentials, browser session secrets, or admin tokens.

### `session-runner-pool.js`

OpenCode shared config should register only `lily_tool_broker` as Lily's MCP
server. Session-specific tool visibility moves into the broker. The current
`activeSkillIds` passing remains useful during migration but is no longer the
final authority.

## Tool Families

### Mail

Move the existing `mail-mcp.js` definitions into broker registry equivalents:

- `mail_list_accounts`
- `mail_search`
- `mail_read`
- `mail_send`

Visibility requires the mail skill and a connected mail bridge. `mail_send` is
`submit` risk and must require confirmation.

### Learned Web Systems

For each enabled learned skill, read its `capability-map.json` and expand one
typed tool per capability using the existing `web-system-mcp.js` helpers:

```text
web_<system>__<capability>
```

Only enabled learned skills are scanned. Disabled learned skills produce no
tools. The executor should reuse the existing API-first playbook path and keep
browser fallback behind the same risk and confirmation rules.

### Browser

Browser QA and inspection tools are exposed only when browser-capable skills are
enabled and the runtime can actually launch the bundled browser path.

Initial broker tools:

- `browser_open`
- `browser_click`
- `browser_type`
- `browser_screenshot`
- `browser_console`

These tools should keep session-isolated browser contexts. Credentials must not
be silently reused unless the user explicitly captured a browser session for a
learned web system.

### Runtime Packs

Runtime pack tools are visible only when `lily-runtime-packs` is active:

- `runtime_pack_list`
- `runtime_pack_status`
- `runtime_pack_install`
- `runtime_pack_uninstall`

Install and uninstall are `submit` risk. They must disclose download/disk cost
and require confirmation.

## Data Flow

### Discovery

```text
OpenCode requests MCP tools
  -> broker resolves Lily session
  -> activeSkillIds loaded from SessionManager / SkillManager
  -> registry filters static tools
  -> learned web-system tools expanded
  -> broker returns allowed tools only
```

### Execution

```text
OpenCode calls a broker tool
  -> broker resolves Lily session again
  -> broker verifies the tool is still visible
  -> broker checks permission/risk policy
  -> broker delegates to domain handler
  -> result returned as structured text JSON
```

The second authorization check is required because skills or permissions may
change between discovery and execution.

## Permission Model

Visibility and execution are separate gates.

Visibility gate:

- active skill/capability is enabled for the session
- required connector/runtime exists
- license/config allows the feature

Execution gate:

- tool is still visible
- risk is compatible with session permission mode
- submit/destructive actions require explicit confirmation
- handler validates input against schema and domain constraints

Failure modes should be specific:

- `TOOL_NOT_AVAILABLE`
- `SESSION_NOT_FOUND`
- `SKILL_DISABLED`
- `CONNECTOR_NOT_CONNECTED`
- `RUNTIME_PACK_UNAVAILABLE`
- `CONFIRMATION_REQUIRED`
- `PERMISSION_DENIED`

## Migration Plan

1. Add broker modules and tests with only static in-memory tools.
2. Move mail tools into broker and keep old mail MCP tests as compatibility
   coverage.
3. Move learned web-system dynamic tools into broker and remove direct learned
   system MCP registration from shared config.
4. Add runtime pack broker tools.
5. Add browser broker tools.
6. Change OpenCode shared config to register only `lily_tool_broker` for Lily
   extension tools.
7. Remove obsolete per-session MCP assembly paths after tests cover equivalent
   behavior.

## Testing

Required tests:

- Tool discovery returns no mail tools when mail skill is disabled.
- Tool discovery returns mail tools when mail skill is enabled and bridge exists.
- Learned web-system tools appear only for enabled learned skills.
- Two sessions with different enabled skills get different tool lists while using
  the same OpenCode shared serve.
- Calling a tool after disabling its skill returns `SKILL_DISABLED`.
- Submit/destructive tools require confirmation.
- Broker does not log connector secrets or session tokens.
- OpenCode shared config contains one Lily broker MCP server, not per-skill MCP
  servers.

## Rollout

This should land behind a small internal feature flag:

```text
LILY_TOOL_BROKER=1
```

Default it on in development tests first. After parity tests pass for mail and
learned web systems, make it the production default and remove the old direct
MCP path.

## Success Criteria

- Disabled skills are invisible to the model, not merely rejected at call time.
- Skill changes do not require restarting the OpenCode shared serve.
- Multi-session concurrent runs cannot see each other's session-only tools.
- The model sees real typed tools, not a generic dispatcher.
- All sensitive credentials remain in Electron main or existing secure bridges,
  never in the broker stdio process environment beyond scoped bridge tokens.
