import fs from "node:fs";

let cachedPath = "";
let cachedMtimeMs = -1;
let cachedState = null;

function isLilyBrokerTool(name) {
  return /^(lily_tool_broker|lily_tb)_/.test(String(name || ""));
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

function resolveToken(engineSessionId) {
  const filePath = String(process.env.LILY_RUNTIME_IDENTITY_REGISTRY || "").trim();
  if (!filePath) return "";
  const record = readRegistry(filePath)?.sessions?.[String(engineSessionId || "")];
  if (!record || Number(record.expiresAt || 0) <= Date.now()) return "";
  return String(record.token || "");
}

export const RuntimeIdentityPlugin = async () => ({
  "tool.execute.before": async (input, output) => {
    if (process.env.LILY_RUNTIME_IDENTITY_V1 === "0" || !isLilyBrokerTool(input?.tool)) return;
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
