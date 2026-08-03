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

function outputFailed(output) {
  return Boolean(output?.error || output?.isError || output?.status === "error");
}

async function execute(event, input, payload = {}) {
  if (process.env.LILY_PUBLIC_HOOKS_V1 === "0") return { allow: true };
  const baseUrl = String(process.env.LILY_PUBLIC_HOOK_BRIDGE_URL || "").trim();
  if (!baseUrl) return { allow: true };
  const token = registryToken(input?.sessionID);
  if (!token) throw new Error("PUBLIC_HOOK_BRIDGE_IDENTITY_UNAVAILABLE");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 310_000);
  try {
    const response = await fetch(`${baseUrl}/v1/hooks/execute`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        event,
        engineSessionId: String(input?.sessionID || ""),
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

export const PublicHooksBridgePlugin = async () => ({
  "tool.execute.before": async (input, output) => {
    await execute("tool.before", input, { args: output?.args || input?.args || {} });
  },
  "tool.execute.after": async (input, output) => {
    const event = outputFailed(output) ? "tool.failed" : "tool.after";
    await execute(event, input, { args: input?.args || {}, output });
  },
  "experimental.session.compacting": async (input, output) => {
    const result = await execute("compaction.before", input);
    if (result.contextAppend && output && typeof output === "object") {
      const context = Array.isArray(output.context) ? output.context : [];
      output.context = [String(result.contextAppend).slice(0, 4_000), ...context];
    }
  },
});

export default PublicHooksBridgePlugin;
