import fs from "node:fs";

let cachedPath = "";
let cachedMtimeMs = -1;
let cachedState = null;

function isLilyBrokerTool(name) {
  return /^(lily_tool_broker|lily_tb)_/.test(String(name || ""));
}

function isProcessJobTool(name) {
  return /^(lily_process_jobs|lily_pj)_/.test(String(name || ""));
}

function readRegistry(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (cachedState && cachedPath === filePath && cachedMtimeMs === stat.mtimeMs) return cachedState;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    cachedPath = filePath;
    cachedMtimeMs = stat.mtimeMs;
    cachedState = parsed && typeof parsed === "object" ? parsed : null;
    return cachedState;
  } catch {
    cachedPath = filePath;
    cachedMtimeMs = -1;
    cachedState = null;
    return null;
  }
}

function activeRecord(engineSessionId) {
  const filePath = String(process.env.LILY_RUNTIME_IDENTITY_REGISTRY || "").trim();
  if (!filePath) return null;
  const record = readRegistry(filePath)?.sessions?.[String(engineSessionId || "")];
  if (!record || Number(record.expiresAt || 0) <= Date.now()) return null;
  return record;
}

function resolveToken(engineSessionId) {
  return String(activeRecord(engineSessionId)?.token || "");
}

/**
 * The turn's process-job scope, for this session or — a subagent's child
 * session — the nearest ancestor the host granted. A child session runs on
 * behalf of the same turn, so its jobs belong to that turn.
 */
const parentCache = new Map();
async function resolveProcessJobScope(engineSessionId, client) {
  let id = String(engineSessionId || "");
  for (let hop = 0; id && hop < 8; hop += 1) {
    const record = activeRecord(id);
    if (record?.processJobScopeToken) return String(record.processJobScopeToken);
    if (!client?.session?.get) return "";
    if (!parentCache.has(id)) {
      let parent = "";
      try {
        const res = await client.session.get({ path: { id } });
        parent = String(res?.data?.parentID || res?.parentID || "");
      } catch (err) {
        console.warn("[runtime-identity] parent session lookup failed open:", err?.message || err);
      }
      parentCache.set(id, parent);
      if (parentCache.size > 512) parentCache.delete(parentCache.keys().next().value);
    }
    id = parentCache.get(id) || "";
  }
  return "";
}

export const RuntimeIdentityPlugin = async (ctx = {}) => ({
  "tool.execute.before": async (input, output) => {
    if (process.env.LILY_RUNTIME_IDENTITY_V1 === "0") return;
    if (isProcessJobTool(input?.tool)) {
      // The host's per-turn scope replaces whatever the model wrote (a
      // hand-copied token is what goes wrong). No grant for this session or
      // its ancestors leaves the call as the model made it.
      if (process.env.LILY_PROCESS_JOB_SCOPE_INJECT === "0" || !output || typeof output !== "object") return;
      const scopeToken = await resolveProcessJobScope(input?.sessionID, ctx.client);
      if (!scopeToken) return;
      if (!output.args || typeof output.args !== "object" || Array.isArray(output.args)) output.args = {};
      output.args.scopeToken = scopeToken;
      return;
    }
    if (!isLilyBrokerTool(input?.tool)) return;
    const token = resolveToken(input?.sessionID);
    if (!token) {
      const error = new Error("LILY_RUNTIME_IDENTITY_UNAVAILABLE: no active identity for this engine session");
      error.code = "LILY_RUNTIME_IDENTITY_UNAVAILABLE";
      throw error;
    }
    if (!output || typeof output !== "object") {
      throw new Error("LILY_RUNTIME_IDENTITY_UNAVAILABLE: tool argument envelope is missing");
    }
    if (!output.args || typeof output.args !== "object" || Array.isArray(output.args)) output.args = {};
    output.args.__lilyRuntimeToken = token;
  },
});

export default RuntimeIdentityPlugin;
