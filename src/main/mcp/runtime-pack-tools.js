"use strict";
const path = require("node:path");
const { PACK_SPECS } = require("../runtime-pack-specs");
function installerFor(deps) { return deps.runtimePackInstaller || require("../runtime-pack-installer"); }
function repairability(pack) {
  // The installer always skips bundled artifacts, even when force is requested.
  // Base-provided libraries can be overlaid by a managed user pack; readOnly alone
  // therefore does not mean repair is unsupported.
  return pack.bundled
    ? { repairSupported: false, repairLimitation: "BUNDLED_RUNTIME_PACK_READ_ONLY: the current installer cannot replace a bundled artifact. Report the health failure; an app/runtime distribution repair is required, not repeated install attempts." }
    : { repairSupported: true };
}
function executionHint(deps) {
  const runtime = deps.runtimePython || require("../runtime-python");
  const env = runtime.getBundledPythonEnv({ ...runtime.getRuntimeEnvExtras() });
  env.PATH = [...runtime.getRuntimePathEntries(), process.env.PATH].filter(Boolean).join(path.delimiter);
  const safe = {};
  for (const key of ["PATH", "PYTHONPATH", "NODE_PATH", "PLAYWRIGHT_BROWSERS_PATH", "LILY_LIBREOFFICE_PROGRAM", "UNO_PATH", "SAL_USE_VCLPLUGIN"]) {
    if (typeof env[key] === "string") safe[key] = env[key];
  }
  return { python: runtime.resolveVenvPython(), env: safe, instruction: "Apply these environment values explicitly to the failed operation in the current shell; use python for Python operations. Retry only that operation after health.ok is true. No shared-server restart is needed." };
}
async function listRuntimePackTool({ packId, verify = false } = {}, _context, deps = {}) {
  if (packId && !Object.hasOwn(PACK_SPECS, packId)) return { ok: false, error: "INVALID_RUNTIME_PACK" };
  if (verify && !packId) return { ok: false, error: "PACK_ID_REQUIRED_FOR_HEALTH_CHECK" };
  const result = await installerFor(deps).listRuntimePacks({ packId, includeInternal: true });
  if (!result?.ok) return result;
  const packs = result.packs.filter((pack) => !packId || pack.id === packId).map((pack) => ({ ...pack, ...repairability(pack), ready: false, status: pack.installing ? "installing" : pack.progress?.phase === "failed" ? "failed" : pack.installed ? "installed_unverified" : "missing" }));
  if (verify && packs[0] && !packs[0].installing) {
    const pack = packs[0];
    try {
      pack.health = await (deps.checkRuntimePackHealth || require("../runtime-health").checkRuntimePackHealth)(packId);
      pack.ready = pack.health?.ok === true;
      pack.status = pack.ready ? "ready" : pack.progress?.phase === "failed" ? "failed" : pack.installed ? "unhealthy" : "missing";
      if (pack.ready) pack.execution = executionHint(deps);
    } catch (error) {
      pack.ready = false;
      pack.status = "verification_failed";
      pack.error = error?.message || String(error);
    }
  }
  return { ...result, packs };
}
async function installRuntimePackTool({ packId, repair }, _context, deps = {}) {
  const installer = installerFor(deps);
  if (repair && typeof installer.listRuntimePacks === "function") {
    const listed = await installer.listRuntimePacks({ packId });
    const pack = listed?.packs?.find((entry) => entry.id === packId);
    if (pack?.bundled) return { ok: false, id: packId, started: false, error: "BUNDLED_RUNTIME_PACK_READ_ONLY", ...repairability(pack) };
  }
  return installer.startRuntimePackInstall(packId, repair ? { repair: true, force: true } : {});
}
module.exports = { listRuntimePackTool, installRuntimePackTool };
