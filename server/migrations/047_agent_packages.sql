-- Agent packages — server-distributed 智能体 definitions (design §3.4 P2).
--
-- Mirrors skill_packages: one row per (agent_id, version, channel) publication,
-- but with an extra distribution scope so an enterprise can publish agents that
-- only its members receive:
--   scope_type = 'global'        → every client (platform admin publishes)
--   scope_type = 'organization'  → members of organization_id (org owner/admin publishes)
--
-- `definition` is the validated agent definition (services/agent-definition.js,
-- same rules as the desktop client). `role_card` optionally embeds a character
-- canonical so a distributed agent can carry its own role without referencing a
-- local id. ids are text (publicId "agentpkg_…") like every other package table;
-- organizations.id is text, so the FK is text too.
create table if not exists agent_packages (
  id text primary key,
  agent_id text not null,
  version text not null,
  channel text not null default 'stable',
  scope_type text not null default 'global',
  organization_id text references organizations(id) on delete cascade,
  enabled boolean not null default true,
  featured boolean not null default false,
  display_in_catalog boolean not null default true,
  publisher text not null default 'Lily Workbench',
  definition jsonb not null,
  role_card jsonb,
  min_app_version text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_packages_scope_type_ck check (scope_type in ('global', 'organization')),
  constraint agent_packages_scope_org_ck check (
    (scope_type = 'global' and organization_id is null)
    or (scope_type = 'organization' and organization_id is not null)
  )
);

-- One publication per agent/version/channel per scope. A unique CONSTRAINT
-- cannot express coalesce(); a unique INDEX can, and ON CONFLICT targets it via
-- the same expression list.
create unique index if not exists agent_packages_publication_uq
  on agent_packages (agent_id, version, channel, scope_type, coalesce(organization_id, ''));

create index if not exists agent_packages_scope_lookup
  on agent_packages (scope_type, organization_id, enabled);

create index if not exists agent_packages_registry_lookup
  on agent_packages (channel, enabled, created_at desc);
