"use strict";

/**
 * Agent activation — apply one agent revision to one conversation by calling
 * the EXISTING per-dimension setters, then record a binding + receipt.
 *
 * Invariants (docs/agent-management-design.md §3.2):
 *  - Every dimension is applied independently and fails open: a dimension
 *    that cannot be applied is recorded as `degraded` with a reason and the
 *    conversation keeps today's default for that dimension. Activation never
 *    leaves a session in a worse state than before it started.
 *  - Hot dimensions (role, skills, knowledge, autonomy) apply on the next
 *    prompt. Cold dimensions (model, tools.disallow) fork the shared serve;
 *    they are applied only when the fork budget allows and the caller is
 *    expected to (re)build the engine session — never mid-conversation.
 *  - The pre-activation snapshot is stored on the binding so `deactivate`
 *    restores exactly what the user had.
 *  - The role card is bound through the character repository (lower-authority
 *    narrative); tools/permissions/model are host configuration. The role
 *    activation contract ("a role never changes tools") is untouched.
 */

const { agentsEnabled, serveForkLimit } = require("./constants");
const { codedError, activeDimensions } = require("./agent-definition");
const { getKnowledgePack } = require("./knowledge-packs");
const { invalidateSessionAgentPolicy } = require("./session-agent-policy");

function defaultDeps(ctx) {
  const sessionManager = ctx?.sessionManager || null;
  const store = (() => {
    try { return sessionManager?._store?.() || null; } catch { return null; }
  })();
  return {
    sessionManager,
    projectManager: ctx?.projectManager || null,
    agentRepository: ctx?.agentRepository || store?.agents?.() || null,
    characterRepository: ctx?.characterWorldsRepository || store?.characterWorlds?.() || null,
    scheduledTaskManager: ctx?.scheduledTaskManager || null,
    skillManager: require("../skill-manager"),
    modelSelection: require("../model-selection-catalog"),
    permissionSettings: require("../permission-settings"),
    officialCharacters: require("../character-worlds/official-character-catalog"),
    officialCharacterInstall: require("../official-character-ipc"),
    characterPolicyEnabled: () => {
      try {
        const { characterWorldsPolicyFor } = require("../ipc-character-guards");
        return characterWorldsPolicyFor(ctx)?.enabled === true;
      } catch {
        return false;
      }
    },
    countServeProfiles: () => {
      try { return require("../runtime/opencode-shared-server").countSharedServerProfiles(); } catch { return 0; }
    },
    locale: () => {
      try { return require("../locale-settings").getLocale() || "en"; } catch { return "en"; }
    },
    log: (...args) => console.warn("[agents]", ...args),
  };
}

function applied(extra = {}) { return { status: "applied", ...extra }; }
function skipped(reason, extra = {}) { return { status: "skipped", reason, ...extra }; }
function degraded(reason, extra = {}) { return { status: "degraded", reason, ...extra }; }

// ---------------------------------------------------------------------------
// Dimension appliers (each: never throws; returns a status record)
// ---------------------------------------------------------------------------

function snapshotPrevious(deps, session, ownerScope) {
  const previous = {
    enabledSkillIds: Array.isArray(session?.enabledSkillIds) ? [...session.enabledSkillIds] : null,
    permissionModeId: session?.permissionModeId ?? null,
    modelSelection: null,
    character: null,
    automationTaskIds: [],
  };
  try { previous.modelSelection = deps.modelSelection.getSessionModelSelection?.(session.id) || null; } catch { /* inherit */ }
  try {
    const binding = deps.characterRepository?.getBinding?.(session.id, ownerScope);
    if (binding) previous.character = { mode: binding.mode, characterRevisionId: binding.characterRevisionId || null, greetingIndex: binding.greetingIndex ?? null };
  } catch { /* native */ }
  return previous;
}

function resolveRoleRevisionId(deps, ownerScope, role) {
  const repo = deps.characterRepository;
  if (!repo) return { error: "character_repository_unavailable" };
  if (role.characterRevisionId) {
    return repo.getRevision(ownerScope, role.characterRevisionId)
      ? { revisionId: role.characterRevisionId }
      : { error: "character_revision_not_found" };
  }
  if (role.characterEntityId) {
    const entity = repo.getCharacter(ownerScope, role.characterEntityId);
    return entity?.currentRevisionId ? { revisionId: entity.currentRevisionId } : { error: "character_not_found" };
  }
  if (role.officialCharacterId) {
    const official = deps.officialCharacters.getOfficialCharacter(role.officialCharacterId, deps.locale());
    if (!official) return { error: "official_character_unknown" };
    const installed = deps.officialCharacterInstall.installedOfficialRevisions(repo, ownerScope).get(official.id) || null;
    const installedVersion = Number(installed?.source?.officialVersion) || 0;
    if (installed && installedVersion >= official.version && String(installed.source?.officialLocale || "") === official.locale) {
      return { revisionId: installed.id, installed: false };
    }
    const source = deps.officialCharacterInstall.officialSource(official);
    const created = installed
      ? repo.createRevision({ ownerScope, entityId: installed.characterId, baseRevisionId: installed.id, canonical: official.canonical, source })
      : repo.createCharacter({ ownerScope, canonical: official.canonical, source }).revision;
    return { revisionId: created.id, installed: true };
  }
  return { error: "role_reference_missing" };
}

function applyRole(deps, session, ownerScope, definition) {
  if (!definition.role) return skipped("not_set");
  if (!deps.characterPolicyEnabled()) return degraded("character_policy_disabled");
  try {
    const resolved = resolveRoleRevisionId(deps, ownerScope, definition.role);
    if (resolved.error) return degraded(resolved.error);
    const repo = deps.characterRepository;
    const current = repo.getBinding(session.id, ownerScope);
    if (current.mode === "character" && current.characterRevisionId === resolved.revisionId) {
      return applied({ characterRevisionId: resolved.revisionId, unchanged: true });
    }
    const binding = repo.setBinding({
      sessionId: session.id,
      ownerScope,
      expectedBindingVersion: current.bindingVersion,
      next: { mode: "character", characterRevisionId: resolved.revisionId },
    });
    return applied({ characterRevisionId: resolved.revisionId, bindingVersion: binding.bindingVersion, installed: Boolean(resolved.installed) });
  } catch (error) {
    deps.log("role activation failed open:", error?.code || error?.message || error);
    return degraded(error?.code || "role_binding_failed");
  }
}

async function applySkills(deps, session, workspacePath, definition) {
  if (!definition.skills.enabled.length) return skipped("not_set");
  const sm = deps.skillManager;
  let installed;
  try {
    installed = new Set(typeof sm.getAllInstalledSkillIds === "function" ? sm.getAllInstalledSkillIds() : []);
  } catch (error) {
    deps.log("skill inventory unavailable, skills dimension skipped:", error?.message || error);
    return degraded("skill_inventory_unavailable");
  }
  const installedNow = [];
  const missing = [];
  for (const id of definition.skills.required) {
    if (installed.has(id)) continue;
    try {
      const result = typeof sm.installFromRegistry === "function" ? await sm.installFromRegistry(id) : { ok: false };
      if (result?.ok) { installed.add(id); installedNow.push(id); } else missing.push(id);
    } catch {
      missing.push(id);
    }
  }
  try {
    // Agent skills ADD to what the conversation already has (globals +
    // workspace skills); they never silently remove user choices.
    const base = sm.resolveSessionSkillIds(session);
    const union = [...new Set([...base, ...definition.skills.enabled])].filter((id) => installed.has(id));
    const normalized = sm.normalizeSessionSkillSelection(union, workspacePath);
    if (!deps.sessionManager.setEnabledSkillIds(session.id, normalized)) return degraded("session_not_found");
    const unavailable = definition.skills.enabled.filter((id) => !installed.has(id));
    const base_ = missing.length ? degraded("required_skills_missing") : applied();
    return { ...base_, enabled: normalized, installedNow, missing, unavailable };
  } catch (error) {
    deps.log("skill activation failed open:", error?.message || error);
    return degraded("skill_selection_failed", { installedNow, missing });
  }
}

function applyAutonomy(deps, session, definition) {
  const mode = definition.autonomy.permissionModeId;
  if (mode === "inherit") return skipped("not_set");
  try {
    return deps.sessionManager.setPermissionMode(session.id, mode)
      ? applied({ permissionModeId: mode })
      : degraded("permission_mode_rejected");
  } catch (error) {
    deps.log("autonomy activation failed open:", error?.message || error);
    return degraded("permission_mode_failed");
  }
}

function applyKnowledge(deps, definition) {
  const { packs, guidance } = definition.knowledge;
  if (!packs.length && !guidance) return skipped("not_set");
  const unknown = packs.filter((id) => !getKnowledgePack(id));
  const known = packs.filter((id) => getKnowledgePack(id));
  // Packs are prepared lazily by turn preparation (download + index can be
  // heavy); activation only validates the references and records intent.
  return unknown.length
    ? degraded("unknown_knowledge_packs", { packs: known, unknown, guidance: Boolean(guidance) })
    : applied({ packs: known, guidance: Boolean(guidance), preparedAt: "first_turn" });
}

function coldBudgetAvailable(deps) {
  const limit = serveForkLimit();
  const count = deps.countServeProfiles();
  return { ok: count < limit, count, limit };
}

function applyModel(deps, session, definition, budget) {
  const presetId = definition.model.presetId;
  if (!presetId) return skipped("not_set");
  if (!budget.ok) return degraded("serve_fork_budget", { count: budget.count, limit: budget.limit });
  try {
    const state = deps.modelSelection.listModelSelectionPublic(session.id);
    const exists = (state.models || []).some((model) => model.id === presetId);
    if (!exists) return degraded("model_unavailable", { presetId });
    const result = deps.modelSelection.setModelSelectionPreference({ mode: "manual", manualModelId: presetId }, session.id);
    return result?.ok ? applied({ presetId, cold: true }) : degraded(result?.error || "model_selection_failed", { presetId });
  } catch (error) {
    deps.log("model activation failed open:", error?.message || error);
    return degraded("model_selection_failed", { presetId });
  }
}

function applyTools(definition, budget) {
  const { disallow, mcpAllow, connectors } = definition.tools;
  if (!disallow.length && !mcpAllow.length && !connectors.length) return skipped("not_set");
  // mcpAllow/connectors are advisory (delivered through guidance); disallow is
  // enforced through the serve permission map at engine (re)build.
  if (disallow.length && !budget.ok) {
    return degraded("serve_fork_budget", { disallow: [], mcpAllow, connectors, count: budget.count, limit: budget.limit });
  }
  return applied({ disallow, mcpAllow, connectors, cold: disallow.length > 0 });
}

function applyAutomations(deps, session, definition) {
  if (!definition.automations.length) return skipped("not_set");
  const manager = deps.scheduledTaskManager;
  if (!manager?.importPausedTemplates) return degraded("scheduler_unavailable");
  try {
    const result = manager.importPausedTemplates(definition.automations, { sessionId: session.id, projectId: session.projectId });
    const taskIds = (result?.tasks || []).map((task) => task.id);
    return result?.ok ? applied({ taskIds, paused: true, skipped: result.skipped || 0 }) : degraded(result?.error || "automation_import_failed");
  } catch (error) {
    deps.log("automation import failed open:", error?.message || error);
    return degraded("automation_import_failed");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function ownerScopeFor(deps, sessionId) {
  const resolved = deps.sessionManager?.resolveTurnOwnerScope?.(sessionId);
  if (!resolved?.ok || !resolved.ownerScope) throw codedError(resolved?.error || "OWNER_SCOPE_UNAVAILABLE", "Owner scope unavailable");
  return resolved.ownerScope;
}

/**
 * Activate an agent revision for a session.
 * @returns {Promise<{ok:true, binding, receipt}>} or throws a coded error for
 *   the hard failures (kill switch, unknown session/revision, CAS conflict).
 */
async function activateAgent({ ctx, sessionId, agentRevisionId, expectedBindingVersion, deps: overrides = {} }) {
  if (!agentsEnabled()) throw codedError("AGENTS_UNAVAILABLE", "Agents are disabled");
  const deps = { ...defaultDeps(ctx), ...overrides };
  const session = deps.sessionManager?.findById?.(sessionId);
  if (!session) throw codedError("NO_SESSION", "Session not found");
  const ownerScope = ownerScopeFor(deps, sessionId);
  const repo = deps.agentRepository;
  if (!repo) throw codedError("AGENTS_UNAVAILABLE", "Agent repository unavailable");
  const revision = repo.getRevision(ownerScope, agentRevisionId);
  if (!revision) throw codedError("AGENT_REVISION_NOT_FOUND", "Agent revision not found");
  const current = repo.getBinding(sessionId, ownerScope);
  const expected = Number.isInteger(expectedBindingVersion) ? expectedBindingVersion : current.bindingVersion;
  if (expected !== current.bindingVersion) throw codedError("AGENT_BINDING_CONFLICT", "Agent binding version is stale", { current });

  const definition = revision.definition;
  const workspacePath = deps.projectManager?.find?.(session.projectId)?.path || session.workspacePath || "";
  // Deactivate-and-restore semantics: if another agent is bound, keep ITS
  // pre-activation snapshot as the thing we restore to, not the intermediate.
  const previous = current.agentRevisionId && current.previous ? current.previous : snapshotPrevious(deps, session, ownerScope);
  const budget = coldBudgetAvailable(deps);

  const receipt = {
    schemaVersion: 1,
    activatedAt: new Date().toISOString(),
    dimensions: activeDimensions(definition),
    role: applyRole(deps, session, ownerScope, definition),
    skills: await applySkills(deps, deps.sessionManager.findById(sessionId), workspacePath, definition),
    autonomy: applyAutonomy(deps, session, definition),
    knowledge: applyKnowledge(deps, definition),
    model: applyModel(deps, session, definition, budget),
    tools: applyTools(definition, budget),
    automations: applyAutomations(deps, session, definition),
  };
  receipt.degraded = Object.entries(receipt)
    .filter(([, value]) => value && typeof value === "object" && value.status === "degraded")
    .map(([dimension, value]) => ({ dimension, reason: value.reason }));
  receipt.coldApplied = Boolean(receipt.model.cold || receipt.tools.cold);

  const automationTaskIds = receipt.automations.status === "applied" ? receipt.automations.taskIds : [];
  const binding = repo.setBinding({
    sessionId,
    ownerScope,
    expectedBindingVersion: current.bindingVersion,
    agentRevisionId: revision.id,
    receipt,
    previous: { ...previous, automationTaskIds: [...(previous.automationTaskIds || []), ...automationTaskIds] },
  });
  invalidateSessionAgentPolicy(sessionId);
  try {
    deps.sessionManager.setAgentBinding?.(sessionId, {
      agentId: revision.agentId,
      agentRevisionId: revision.id,
      name: definition.name,
      icon: definition.icon || "",
      bindingVersion: binding.bindingVersion,
    });
  } catch { /* mirror is display-only */ }
  return { ok: true, binding, receipt, revision };
}

/** Clear the agent binding and restore the pre-activation snapshot. */
async function deactivateAgent({ ctx, sessionId, expectedBindingVersion, deps: overrides = {} }) {
  const deps = { ...defaultDeps(ctx), ...overrides };
  const session = deps.sessionManager?.findById?.(sessionId);
  if (!session) throw codedError("NO_SESSION", "Session not found");
  const ownerScope = ownerScopeFor(deps, sessionId);
  const repo = deps.agentRepository;
  if (!repo) throw codedError("AGENTS_UNAVAILABLE", "Agent repository unavailable");
  const current = repo.getBinding(sessionId, ownerScope);
  if (!current.agentRevisionId) return { ok: true, binding: current, restored: null };
  const expected = Number.isInteger(expectedBindingVersion) ? expectedBindingVersion : current.bindingVersion;
  if (expected !== current.bindingVersion) throw codedError("AGENT_BINDING_CONFLICT", "Agent binding version is stale", { current });

  const previous = current.previous || {};
  const restored = {};
  try {
    deps.sessionManager.setEnabledSkillIds(sessionId, previous.enabledSkillIds ?? null);
    restored.skills = true;
  } catch { restored.skills = false; }
  try {
    deps.sessionManager.setPermissionMode(sessionId, previous.permissionModeId ?? null);
    restored.autonomy = true;
  } catch { restored.autonomy = false; }
  try {
    if (previous.modelSelection) deps.modelSelection.setModelSelectionPreference(previous.modelSelection, sessionId);
    else deps.modelSelection.clearSessionModelSelection?.(sessionId);
    restored.model = true;
  } catch { restored.model = false; }
  try {
    const characterRepo = deps.characterRepository;
    const binding = characterRepo?.getBinding?.(sessionId, ownerScope);
    if (binding && current.receipt?.role?.status === "applied") {
      const next = previous.character?.mode === "character" && previous.character.characterRevisionId
        ? { mode: "character", characterRevisionId: previous.character.characterRevisionId }
        : { mode: "native" };
      characterRepo.setBinding({ sessionId, ownerScope, expectedBindingVersion: binding.bindingVersion, next });
    }
    restored.role = true;
  } catch { restored.role = false; }
  try {
    for (const taskId of previous.automationTaskIds || []) {
      deps.scheduledTaskManager?.remove?.(taskId, { sessionId, projectId: session.projectId });
    }
    restored.automations = true;
  } catch { restored.automations = false; }

  const binding = repo.setBinding({ sessionId, ownerScope, expectedBindingVersion: current.bindingVersion, agentRevisionId: null, receipt: { deactivatedAt: new Date().toISOString(), restored }, previous: null });
  invalidateSessionAgentPolicy(sessionId);
  try { deps.sessionManager.setAgentBinding?.(sessionId, null); } catch { /* display-only */ }
  return { ok: true, binding, restored };
}

module.exports = { activateAgent, deactivateAgent, snapshotPrevious, coldBudgetAvailable };
