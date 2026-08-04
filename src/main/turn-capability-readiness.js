"use strict";

const { getLogger } = require("./logger");

const log = getLogger("turn-capability-readiness");

function buildDependencyAdvisoryForTurn(text, files) {
  try {
    const { buildRuntimePackAdvisory, preflightRuntimePacks } = require("./runtime-pack-preflight");
    const preflight = preflightRuntimePacks({ text, files });
    const advisory = buildRuntimePackAdvisory(preflight);
    if (!advisory) return null;
    return {
      text: advisory,
      requiredPackIds: preflight.requiredPackIds || [],
      missingPackIds: preflight.missingPackIds || [],
      installingPackIds: preflight.installingPackIds || [],
    };
  } catch (err) {
    log.warn("runtime pack advisory failed open: %s", err?.message || err);
    return null;
  }
}

function readinessResult(plan, patch = {}) {
  return {
    status: patch.status || "baseline",
    requiredPackIds: plan.requiredPackIds || [],
    enhancementPackIds: plan.enhancementPackIds || [],
    readyPackIds: patch.readyPackIds || [],
    failedPackIds: patch.failedPackIds || [],
    unavailablePackIds: patch.unavailablePackIds || [],
    fallbackCapabilityIds: plan.fallbackCapabilityIds || [],
    recommendedSkillIds: plan.recommendedSkillIds || [],
    ...(patch.error ? { error: patch.error } : {}),
  };
}

async function prepareTurnCapabilityReadiness({
  ctx,
  sessionId,
  turnId,
  text,
  files,
  taskContract = null,
  turnPolicy = null,
  deps = {},
  onProgress = null,
}) {
  try {
    const readiness = require("./capability-readiness");
    const installer = require("./runtime-pack-installer");
    const plan = (deps.plan || readiness.planCapabilityReadiness)({
      text,
      files,
      intentContract: taskContract?.intentContract || null,
      turnPolicy,
    });
    const resolved = readiness.resolveCapabilityReadiness(plan, {
      installedPackIds: (deps.installed || installer.installedRuntimePackIds)(),
      installingPackIds: (deps.installing || installer.installingRuntimePackIds)(),
      unavailablePackIds: new Set(),
    });
    const unresolvedPackIds = [...new Set([
      ...(resolved.missingRequiredPackIds || []),
      ...(resolved.installingPackIds || []),
    ])];
    if (!unresolvedPackIds.length) {
      return readinessResult(plan, {
        status: resolved.status,
        readyPackIds: resolved.readyPackIds,
        unavailablePackIds: resolved.unavailablePackIds,
      });
    }

    const prepare = deps.prepare || ((payload) => {
      const coordinator = ctx?.runtimePackCoordinator || require("./runtime-pack-coordinator").runtimePackCoordinator;
      return coordinator.prepare(payload);
    });
    const prepared = await prepare({
      turnId,
      requiredPackIds: unresolvedPackIds,
      onProgress,
    });
    if (prepared.refreshRequired) {
      const refresh = deps.refresh || ctx?.refreshPreparedRuntimeForTurn
        || require("./runner-live-config").refreshPreparedRuntimeForTurn;
      const progressId = prepared.readyPackIds?.[0] || unresolvedPackIds[0];
      const jobId = `runtime_refresh_${turnId}`;
      const publishProgress = deps.progress || installer.publishRuntimePackProgress;
      publishProgress({ id: progressId, jobId, turnId, phase: "refreshing", at: new Date().toISOString() });
      try {
        refresh(ctx, sessionId);
      } catch (error) {
        publishProgress({
          id: progressId,
          jobId,
          turnId,
          phase: "failed",
          error: error?.message || String(error),
          at: new Date().toISOString(),
        });
        return readinessResult(plan, {
          status: "degraded",
          readyPackIds: prepared.readyPackIds,
          failedPackIds: unresolvedPackIds,
          unavailablePackIds: prepared.unavailablePackIds,
          error: error?.message || String(error),
        });
      }
      publishProgress({ id: progressId, jobId, turnId, phase: "installed", at: new Date().toISOString() });
    }
    return readinessResult(plan, {
      status: prepared.ok ? "ready" : "degraded",
      readyPackIds: prepared.readyPackIds,
      failedPackIds: prepared.failedPackIds,
      unavailablePackIds: prepared.unavailablePackIds,
    });
  } catch (error) {
    log.warn("capability readiness failed open to baseline: %s", error?.message || error);
    return { status: "baseline", error: error?.message || String(error) };
  }
}

module.exports = {
  buildDependencyAdvisoryForTurn,
  prepareTurnCapabilityReadiness,
};
