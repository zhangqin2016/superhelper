# Agent distribution — server + admin web (design §3.4 P2)

Server half of 智能体管理: admins and enterprise owners/admins publish agent
definitions; clients pull a signed registry and receive per-scope targeting in
the signed effective config. Additive only; a profile without `config.agents`
produces byte-identical config output to before.

## Table `agent_packages` (migration `server/migrations/047_agent_packages.sql`)

| column | notes |
|---|---|
| `id` text pk | `publicId("agentpkg")`, like every other package table |
| `agent_id`, `version`, `channel` | channel default `stable`; version newest-wins (`compareVersions`) |
| `scope_type` | `global` \| `organization` (check constraint) |
| `organization_id` | text FK → `organizations(id)` (that column is text, not uuid); required iff scope is `organization` |
| `enabled`, `featured`, `display_in_catalog` | soft delete = `enabled=false` |
| `publisher`, `min_app_version`, `created_by` | |
| `definition` jsonb NOT NULL | validated by `services/agent-definition.js` |
| `role_card` jsonb | optional `{ canonical }`, ≤ 1 MiB |

Unique index on `(agent_id, version, channel, scope_type, coalesce(organization_id,''))`;
lookup indexes on `(scope_type, organization_id, enabled)` and `(channel, enabled, created_at desc)`.

## Validator parity

`server/src/services/agent-definition.js` is an ESM port of the client's
`src/main/agents/agent-definition.js` + `constants.js`: same limits, same
normalization, same codes — `AGENT_DEFINITION_INVALID {field}` and
`AGENT_DEFINITION_TOO_LARGE`. `server/scripts/test-agent-packages-logic.mjs`
loads BOTH validators and asserts identical output / codes / fields.

Distribution rule (quality gate, not the validator): a published `role` may only
be `{ officialCharacterId }`, or the package carries `roleCard: { canonical }`.
`characterEntityId` / `characterRevisionId` are local ids → `LOCAL_ROLE_REFERENCE`.

## Endpoints

Package body (admin + enterprise): `{ agentId, version, channel?, scopeType?, organizationId?,
enabled?, featured?, displayInCatalog?, publisher?, definition, roleCard?, minAppVersion? }`.

Coded failures: `AGENT_PACKAGE_INVALID {field}` 400, `AGENT_DEFINITION_INVALID {field}` 400,
`AGENT_DEFINITION_TOO_LARGE` 413, `AGENT_ROLE_CARD_INVALID` 400, `AGENT_ROLE_CARD_TOO_LARGE` 413,
`AGENT_QUALITY_GATE_FAILED { issues:[{field,code,message}] }` 400, `AGENT_PACKAGE_CONFLICT` 409,
`AGENT_PACKAGE_NOT_FOUND` 404, `AGENT_REGISTRY_SIGNING_UNAVAILABLE` 503.

### Admin (`/api/admin/*`, admin cookie or `Authorization: Bearer <ADMIN_TOKEN>`) — `routes/admin/agent-packages.js`

| method | path | body / query | response |
|---|---|---|---|
| GET | `/api/admin/agent-packages` | `?channel=&scope=global\|organization&organizationId=` | `{ ok, agentPackages:[rows] }` |
| GET | `/api/admin/agent-packages/:id` | | `{ ok, agentPackage }` |
| POST | `/api/admin/agent-packages` | package body (scope from body) | 201 `{ ok, id, agentId, created }` |
| PATCH | `/api/admin/agent-packages/:id` | `{ enabled?, featured?, displayInCatalog? }` (≥1) | `{ ok, id }` |
| DELETE | `/api/admin/agent-packages/:id` | soft: `enabled=false` | `{ ok, id }` |

Every mutation writes `audit_logs` (`agent_package.upsert|update|unpublish`).

### Enterprise (`/api/enterprise/*`, Bearer account token or `lily_user_session` cookie) — `routes/public/enterprise-agents.js`

| method | path | role | notes |
|---|---|---|---|
| GET | `/api/enterprise/organizations/:id/agents` | member | `{ ok, agentPackages }` — this org's rows only |
| POST | `/api/enterprise/organizations/:id/agents` | admin/owner | scope pinned to `organization`/`:id` from the URL; body cannot widen it |
| PATCH | `/api/enterprise/organizations/:id/agents/:packageId` | admin/owner | 404 unless the package belongs to `:id` |

Role check = `requireOrgRole` (`roleAtLeast`, active membership). Audited as `actor=user:<id>`.

### Public registry — `routes/public/agents.js`

`GET /api/agents/registry?channel=stable` (optional `Authorization: Bearer <account access token>` or session cookie):

```
{ ok:true, schemaVersion:1, publisher, registryUrl, channel, generatedAt,
  agents:[{ packageId, agentId, version, channel, scope:{type:"global"|"organization",organizationId?},
            publisher, featured, displayInCatalog, definition, roleCard?, minAppVersion, updatedAt }],
  signature }
```

Anonymous / invalid / stale token ⇒ global enabled packages only (never a 401).
Valid token ⇒ global ∪ organization packages for orgs where the caller is an
**active** member of an **active** org (selected only through the membership
join — org packages cannot leak). Newest enabled version per `(agentId, scope)`.

**Signing**: `buildAgentRegistry(rows, { channel, registryUrl, signer: signConfigPayload })`
— the same Ed25519 detached signature the client already trusts for the effective
config (`services/security.js`, canonical `stableStringify` of the payload minus
`signature`). No signing key and unsigned mode not allowed ⇒ 503, never an unsigned body.

## `config.agents` in the effective config

Profiles may carry `agents: { available: [agentId…], default?: agentId }` at any scope
(global / group / license / device), merged like every other block. In
`POST /api/client/config` the resolver runs **only when the merged config has an
`agents` block**:

```
availableAgentIds = enabled global agentIds ∪ org-scoped agentIds for the caller's active orgs
config.agents.available ∩= availableAgentIds; default must be ∈ available else dropped;
empty intersection ⇒ the block is removed entirely
```

Fail-open: no block ⇒ zero queries, config untouched; DB error ⇒ config left as resolved.
`DEFAULT_EFFECTIVE_CONFIG` deliberately has no `agents` key (same as `media`): absent means
"every registry agent available, no default" — today's behaviour. The client also honours an
optional `tools.agentRegistryUrl` (absolute or `/api/...`) to point at a different registry.

## Admin web

- `/admin/agents` (distribution nav group, icon `Bot`): list, `/admin/agents/new`, `/admin/agents/[id]`
  (edit = re-publish). Form parses JSON client-side and renders server `code/field/issues` by field.
- Config delivery form (`web/components/config-profile-form.js`): "可用智能体" multi-select +
  default radio → `config.agents`; options come from `GET /api/admin/agent-packages`. Empty ⇒ block omitted.

## Tests

`cd server && npm run test:agent-packages` — pure logic, no Postgres: validator parity with the client,
envelope + quality gate, `resolveAgentSelection` fail-open contract, registry builder + signer hook, and
route-level coded rejections via Fastify `inject` (validation paths that never reach the DB).
