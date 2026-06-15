---
name: config-delivery-scopes
description: How server delivers per-target config (models/runtime/policy) to clients — scopes global/group/license/device, priority merge
metadata:
  type: reference
---

Server-driven client config (model presets, runtime env, plugins, policy) is delivered via **config profiles** resolved per-device in `server/src/routes/public/client-config.js` `resolveEffectiveConfig`. Enabled profiles ordered by `priority asc, updated_at asc`, filtered by **scope**, then `deepMerge`d (later = higher priority overrides). Client applies `effectiveConfig.models.presets` (each `{id,label,env}` with `env.LILY_MODEL` etc.) via `src/main/remote-config.js` → `spawn-env.js`. **Client needs no change to support new scopes — the server resolves them.**

Scopes (broad→specific, set precedence via the `priority` field): `global` (no target_id) → `group` → `license` (target_id=licenses.id) → `device` (target_id=devices.id).

**Tier/"档位组" groups** (added 2026-06-13): `config_groups` table + `devices.group_id` / `licenses.group_id` (migration `011_config_groups.sql`). A device's effective group = its own `group_id`, else its license's `group_id` (`resolveDeviceGroupId`). Admin API in `server/src/routes/admin/config-groups.js`: create/list/delete groups + `POST .../assign {kind:device|license, id, groupId}`. Web: scope picker in `web/components/config-profile-form.js` includes "group"; `web/components/config-groups-panel.js` (on `/admin/config`) manages groups + membership. To give a group a model: create the group, assign members, then create a config profile with scope=group, target_id=groupId carrying `models.presets`.

**Model providers are a registry, delivery is gateway-only (added 2026-06-14):** there is NO more "client types a raw key / direct mode" in the config form. A provider = `{id,label,type,baseUrl,apiKey,models}` lives either in server env (`MODEL_GATEWAY_PROVIDERS` + `*_API_KEY`) or in the DB table `model_gateway_providers` (migration `012`, key encrypted via `security.encryptSecret`/`decryptSecret`, AES-256-GCM keyed off SESSION_SECRET). `model-gateway/providers.js listModelGatewayProviders()` merges env + DB (DB wins; lazy `import("../../db.js")` + 30s stale-while-revalidate cache so it stays sync for the `/llm` hot path; `refreshModelGatewayProviders()` called after admin CRUD). Admin CRUD: `server/src/routes/admin/model-providers.js` (`GET` returns `{providers: dbRows, gateway: merged-summary}`; key never returned, only `hasApiKey`). Web: `model-providers-panel.js` manages the registry; `config-profile-form.js` no longer hardcodes providers — it offers the merged `gateway` list and ALWAYS emits gateway env (`LILY_API_BASE_URL=/llm/<id>`, `LILY_API_KEY=$LILY_GATEWAY_TOKEN`, `LILY_GATEWAY_PROVIDER=<id>`). So the client never receives a raw model key; the gateway uses the stored key to reach the LLM.

NOTE: server resolution/migration is NOT covered by an automated test (the server suite needs Postgres); the `group` branch mirrors the proven `license`/`device` branches and the admin preview (`effective-preview?groupId=`). Client suite stays 88/88; `web` `next build` clean.
