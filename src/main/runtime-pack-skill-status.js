"use strict";

function resolveInstalledRuntimePackIds(deps = {}) {
  if (typeof deps.installedRuntimePackIds === "function") return deps.installedRuntimePackIds;
  return require("./runtime-pack-installer").installedRuntimePackIds;
}

async function runtimePackStatusForSkills(skillGraph, installedPacks, deps = {}) {
  const { PACK_SPECS } = require("./runtime-pack-specs");
  const installed = new Set(installedPacks || []);
  const healthById = await runtimePackHealthForRequiredSkills(skillGraph, installed, deps);
  const requiredByActiveSkills = [];
  const missing = [];
  for (const skill of Array.isArray(skillGraph) ? skillGraph : []) {
    const required = Array.isArray(skill?.requiredRuntimePacks)
      ? skill.requiredRuntimePacks.map(String).filter(Boolean)
      : [];
    if (!required.length) continue;
    const itemMissing = required.filter((id) => !runtimePackReady(id, installed, healthById));
    for (const id of itemMissing) {
      if (!missing.includes(id)) missing.push(id);
    }
    requiredByActiveSkills.push({
      skillId: skill.id,
      required,
      missing: itemMissing,
    });
  }
  return {
    requiredByActiveSkills,
    missing,
    missingDetails: missing.map((id) => {
      const spec = PACK_SPECS[id] || {};
      return {
        id,
        category: spec.category || "",
        label: spec.label || { en: id, "zh-CN": id, ar: id },
        description: spec.description || {},
        sizeEstimate: spec.sizeEstimate || "",
        installed: installed.has(id),
        health: healthSummary(healthById.get(id)),
        installAction: {
          tool: "runtime_pack_install",
          args: { packId: id, ...(installed.has(id) ? { repair: true } : {}) },
          destructive: true,
          requiresConfirmation: true,
        },
      };
    }),
  };
}

function explicitInstalledRuntimePackIds(deps = {}) {
  return typeof deps.installedRuntimePackIds === "function";
}

function resolveRuntimePackHealth(deps = {}) {
  if (typeof deps.runtimePackHealth === "function") return deps.runtimePackHealth;
  if (explicitInstalledRuntimePackIds(deps)) return null;
  return require("./runtime-health").checkRuntimePackHealth;
}

function runtimePackReady(id, installed, healthById) {
  if (!installed.has(id)) return false;
  const health = healthById.get(id);
  if (!health) return true;
  return health.ok !== false;
}

function healthSummary(health) {
  if (!health) return null;
  return {
    ok: health.ok !== false,
    status: health.status || (health.ok === false ? "failed" : "ok"),
    error: health.error || "",
    path: health.path || "",
    checks: Array.isArray(health.checks)
      ? health.checks.map((check) => ({
        id: check.id || "",
        ok: check.ok !== false,
        status: check.status || (check.ok === false ? "failed" : "ok"),
        error: check.error || "",
        path: check.path || "",
      }))
      : [],
  };
}

async function runtimePackHealthForRequiredSkills(skillGraph, installed, deps = {}) {
  const checkHealth = resolveRuntimePackHealth(deps);
  const required = new Set();
  for (const skill of Array.isArray(skillGraph) ? skillGraph : []) {
    for (const id of Array.isArray(skill?.requiredRuntimePacks) ? skill.requiredRuntimePacks : []) {
      if (installed.has(String(id || ""))) required.add(String(id || ""));
    }
  }
  const healthById = new Map();
  if (!checkHealth) return healthById;
  for (const id of required) {
    try {
      healthById.set(id, await checkHealth(id));
    } catch (error) {
      healthById.set(id, { ok: false, status: "failed", error: error?.message || String(error) });
    }
  }
  return healthById;
}

module.exports = {
  resolveInstalledRuntimePackIds,
  runtimePackStatusForSkills,
};
