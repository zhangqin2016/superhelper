"use strict";

/**
 * Per-session agent policy — the single read path the runtime uses to ask
 * "what does the bound agent change for this conversation?".
 *
 * Fail-open by construction: any error, a missing repository, the kill
 * switch, or no binding all resolve to INACTIVE, which is exactly today's
 * behaviour. The result is cached per (session, bindingVersion) so the hot
 * path (every send) costs one indexed sqlite read at most.
 */

const { agentsEnabled } = require("./constants");
const { buildAgentGuidanceSection } = require("./agent-guidance");

const INACTIVE = Object.freeze({
  active: false,
  agentId: null,
  agentRevisionId: null,
  bindingVersion: 0,
  displayName: "",
  definition: null,
  disallowedTools: Object.freeze([]),
  knowledgePacks: Object.freeze([]),
  guidanceSignature: "",
});

const cache = new Map();
const CACHE_LIMIT = 256;

function remember(key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

function repositoryOf(ctx) {
  if (ctx?.agentRepository) return ctx.agentRepository;
  try {
    const store = ctx?.sessionManager?._store?.();
    return typeof store?.agents === "function" ? store.agents() : null;
  } catch {
    return null;
  }
}

function ownerScopeOf(ctx, sessionId) {
  try {
    const resolved = ctx?.sessionManager?.resolveTurnOwnerScope?.(sessionId);
    return resolved?.ok && resolved.ownerScope ? resolved.ownerScope : null;
  } catch {
    return null;
  }
}

/**
 * @returns {{active:boolean, agentId, agentRevisionId, bindingVersion, displayName, definition, disallowedTools:string[], knowledgePacks:string[], guidanceSignature:string}}
 */
function resolveSessionAgentPolicy(ctx, sessionId) {
  if (!agentsEnabled() || !sessionId) return INACTIVE;
  try {
    const repository = repositoryOf(ctx);
    const ownerScope = ownerScopeOf(ctx, sessionId);
    if (!repository || !ownerScope) return INACTIVE;
    const binding = repository.getBinding(sessionId, ownerScope);
    if (!binding.agentRevisionId) return INACTIVE;
    const key = `${ownerScope}\0${sessionId}\0${binding.bindingVersion}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const revision = repository.getRevision(ownerScope, binding.agentRevisionId);
    if (!revision?.definition) return remember(key, INACTIVE);
    const definition = revision.definition;
    return remember(key, Object.freeze({
      active: true,
      agentId: revision.agentId,
      agentRevisionId: revision.id,
      bindingVersion: binding.bindingVersion,
      displayName: definition.name || revision.displayName || "",
      definition,
      disallowedTools: Object.freeze([...(definition.tools?.disallow || [])]),
      knowledgePacks: Object.freeze([...(definition.knowledge?.packs || [])]),
      guidanceSignature: `${revision.id}\0${revision.definitionHash}`,
    }));
  } catch {
    return INACTIVE;
  }
}

/** Guide extension contract consumed by skill-manager.writeSessionAgentGuide. */
function createAgentGuideExtension(ctx) {
  return {
    signature(session) {
      const policy = resolveSessionAgentPolicy(ctx, session?.id);
      return policy.active ? `agent:${policy.guidanceSignature}` : "";
    },
    build(session, locale) {
      const policy = resolveSessionAgentPolicy(ctx, session?.id);
      if (!policy.active) return "";
      try {
        return buildAgentGuidanceSection(policy.definition, locale);
      } catch {
        return "";
      }
    },
  };
}

/** Compact label for the bound agent, stamped on each assistant record. */
function agentLabelFor(ctx, sessionId) {
  const policy = resolveSessionAgentPolicy(ctx, sessionId);
  return policy.active ? { id: policy.agentId, name: policy.displayName, icon: String(policy.definition?.icon || "") } : null;
}

function invalidateSessionAgentPolicy(sessionId) {
  for (const key of cache.keys()) {
    if (key.split("\0")[1] === sessionId) cache.delete(key);
  }
}

module.exports = { resolveSessionAgentPolicy, createAgentGuideExtension, invalidateSessionAgentPolicy, agentLabelFor, INACTIVE };
