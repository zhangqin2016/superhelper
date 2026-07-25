/**
 * Pure workspace ordering transforms and optimistic persistence coordination.
 */

const pendingCommits = new WeakSet();

export function canReorderWorkspaces(query) {
  return !String(query ?? "").trim();
}

export function moveWorkspaceIds(ids, sourceId, targetIndex) {
  const next = [...ids];
  const from = next.indexOf(sourceId);
  if (from < 0 || !Number.isInteger(targetIndex)) return next;

  const [id] = next.splice(from, 1);
  const bounded = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(bounded, 0, id);
  return next;
}

export function moveWorkspaceByDelta(ids, sourceId, delta) {
  const next = [...ids];
  const from = next.indexOf(sourceId);
  if (from < 0 || !Number.isInteger(delta)) return next;

  const target = Math.max(0, Math.min(from + delta, next.length - 1));
  if (target === from) return next;
  return moveWorkspaceIds(next, sourceId, target);
}

export function orderProjectsByIds(projects, ids) {
  const byId = new Map();
  for (const project of projects) {
    if (byId.has(project.id)) {
      const error = new Error(`Duplicate project id: ${String(project.id)}`);
      error.code = "DUPLICATE_PROJECT_ID";
      throw error;
    }
    byId.set(project.id, project);
  }
  const ordered = [];
  const included = new Set();

  for (const id of ids) {
    const project = byId.get(id);
    if (!project || included.has(project)) continue;
    ordered.push(project);
    included.add(project);
  }

  for (const project of projects) {
    if (included.has(project)) continue;
    ordered.push(project);
    included.add(project);
  }

  return ordered;
}

export function reorderKnownProjectSlots(projects, ids) {
  const byId = new Map();
  for (const project of projects) {
    if (byId.has(project.id)) {
      const error = new Error(`Duplicate project id: ${String(project.id)}`);
      error.code = "DUPLICATE_PROJECT_ID";
      throw error;
    }
    byId.set(project.id, project);
  }

  const orderedKnown = [];
  const knownIds = new Set();
  for (const id of ids) {
    if (knownIds.has(id)) {
      const error = new Error(`Duplicate project id: ${String(id)}`);
      error.code = "DUPLICATE_PROJECT_ID";
      throw error;
    }
    knownIds.add(id);
    const project = byId.get(id);
    if (project) orderedKnown.push(project);
  }

  const next = [...projects];
  let orderedIndex = 0;
  for (let index = 0; index < next.length; index += 1) {
    if (!knownIds.has(next[index].id)) continue;
    next[index] = orderedKnown[orderedIndex];
    orderedIndex += 1;
  }
  return next;
}

export function isWorkspaceOrderCommitPending(deps) {
  return pendingCommits.has(deps);
}

export async function commitWorkspaceOrder(nextIds, deps) {
  if (!deps || (typeof deps !== "object" && typeof deps !== "function")) {
    return { ok: false, error: "INVALID_WORKSPACE_ORDER_DEPS" };
  }
  if (isWorkspaceOrderCommitPending(deps)) {
    return { ok: false, error: "WORKSPACE_ORDER_BUSY" };
  }

  const requestedIds = [...nextIds];
  const previousProjects = [...(deps.getProjects?.() || [])];
  const previousIds = previousProjects.map((project) => project.id);
  let optimisticPainted = false;
  pendingCommits.add(deps);

  try {
    const optimistic = orderProjectsByIds(previousProjects, requestedIds);
    deps.setProjects(optimistic);
    optimisticPainted = true;

    const result = await deps.persist(requestedIds);
    if (!result?.ok) {
      const currentProjects = [...(deps.getProjects?.() || [])];
      deps.setProjects(reorderKnownProjectSlots(currentProjects, previousIds));
      return { ok: false, error: result?.error || "SAVE_FAILED" };
    }

    const canonicalProjects = result?.state?.projects;
    if (!Array.isArray(canonicalProjects)) {
      const currentProjects = [...(deps.getProjects?.() || [])];
      deps.setProjects(reorderKnownProjectSlots(currentProjects, previousIds));
      return { ok: false, error: "INVALID_WORKSPACE_ORDER_STATE" };
    }
    const canonicalIds = canonicalProjects.map((project) => project.id);
    const currentProjects = [...(deps.getProjects?.() || [])];
    deps.setProjects(reorderKnownProjectSlots(currentProjects, canonicalIds));
    return { ok: true, previousIds };
  } catch (error) {
    if (optimisticPainted) {
      const currentProjects = [...(deps.getProjects?.() || [])];
      deps.setProjects(reorderKnownProjectSlots(currentProjects, previousIds));
    }
    return { ok: false, error: error?.message || "SAVE_FAILED" };
  } finally {
    pendingCommits.delete(deps);
  }
}
