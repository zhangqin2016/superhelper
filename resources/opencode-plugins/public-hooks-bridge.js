import fs from "node:fs";

function registryToken(engineSessionId) {
  try {
    const filePath = String(process.env.LILY_RUNTIME_IDENTITY_REGISTRY || "").trim();
    if (!filePath) return "";
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"))?.sessions?.[String(engineSessionId || "")];
    if (!record || Number(record.expiresAt || 0) <= Date.now()) return "";
    return String(record.token || "");
  } catch { return ""; }
}

// A subagent runs in a child engine session the host never granted: the
// identity lives on the session that dispatched it. Every tool call a subagent
// made used to fail here with PUBLIC_HOOK_BRIDGE_IDENTITY_UNAVAILABLE, so a
// dispatched subagent could read, search and run nothing (2026-09-27/28). The
// nearest granted ancestor is the identity it acts under — the same turn —
// and is what the host checks the token against; a session with no granted
// ancestor still fails closed.
const parentCache = new Map();
async function grantedIdentity(engineSessionId, client) {
  let id = String(engineSessionId || "");
  for (let hop = 0; id && hop < 8; hop += 1) {
    const token = registryToken(id);
    if (token) return { token, engineSessionId: id };
    if (!client?.session?.get) return null;
    if (!parentCache.has(id)) {
      let parent = "";
      try {
        const res = await client.session.get({ path: { id } });
        parent = String(res?.data?.parentID || res?.parentID || "");
      } catch (err) {
        console.warn("[public-hooks-bridge] parent session lookup failed:", err?.message || err);
      }
      parentCache.set(id, parent);
      if (parentCache.size > 512) parentCache.delete(parentCache.keys().next().value);
    }
    id = parentCache.get(id) || "";
  }
  return null;
}

function outputFailed(output) {
  return Boolean(output?.error || output?.isError || output?.status === "error");
}

async function execute(event, input, payload = {}, client = null) {
  if (process.env.LILY_PUBLIC_HOOKS_V1 === "0") return { allow: true };
  const baseUrl = String(process.env.LILY_PUBLIC_HOOK_BRIDGE_URL || "").trim();
  if (!baseUrl) return { allow: true };
  const identity = await grantedIdentity(input?.sessionID, client);
  if (!identity) throw new Error("PUBLIC_HOOK_BRIDGE_IDENTITY_UNAVAILABLE");
  const { token } = identity;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 310_000);
  try {
    const response = await fetch(`${baseUrl}/v1/hooks/execute`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        event,
        engineSessionId: identity.engineSessionId,
        ...(identity.engineSessionId !== String(input?.sessionID || "") ? { actingEngineSessionId: String(input?.sessionID || "") } : {}),
        tool: String(input?.tool || ""),
        args: payload.args || input?.args || {},
        output: payload.output || {},
      }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(result.error || `PUBLIC_HOOK_BRIDGE_HTTP_${response.status}`);
    if (result.allow === false) throw new Error(`PUBLIC_HOOK_DENIED: ${result.reason || event}`);
    return result;
  } finally { clearTimeout(timer); }
}

export const PublicHooksBridgePlugin = async (ctx = {}) => ({
  "tool.execute.before": async (input, output) => {
    await execute("tool.before", input, { args: output?.args || input?.args || {} }, ctx.client);
  },
  "tool.execute.after": async (input, output) => {
    const event = outputFailed(output) ? "tool.failed" : "tool.after";
    await execute(event, input, { args: input?.args || {}, output }, ctx.client);
  },
  "experimental.session.compacting": async (input, output) => {
    const result = await execute("compaction.before", input, {}, ctx.client);
    if (result.contextAppend && output && typeof output === "object") {
      const context = Array.isArray(output.context) ? output.context : [];
      output.context = [String(result.contextAppend).slice(0, 4_000), ...context];
    }
  },
});

export default PublicHooksBridgePlugin;
