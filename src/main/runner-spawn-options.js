"use strict";

/**
 * Normalize runner spawn options for stable equality checks.
 * resumeSessionId is intentionally excluded — it only affects cold spawn.
 * @param {{ agentCommand?: string, permissionMode?: string, disallowedTools?: string[], stagingDir?: string }} opts
 */
function normalizeSpawnOptions(opts) {
  const tools = [...(opts?.disallowedTools || [])].sort();
  return {
    agentCommand: opts?.agentCommand || "",
    permissionMode: opts?.permissionMode || "default",
    disallowedTools: tools,
    stagingDir: opts?.stagingDir || "",
  };
}

/**
 * @param {ReturnType<typeof normalizeSpawnOptions>} a
 * @param {ReturnType<typeof normalizeSpawnOptions>} b
 */
function sameSpawnOptions(a, b) {
  const na = normalizeSpawnOptions(a);
  const nb = normalizeSpawnOptions(b);
  if (
    na.agentCommand !== nb.agentCommand ||
    na.permissionMode !== nb.permissionMode ||
    na.stagingDir !== nb.stagingDir ||
    na.disallowedTools.length !== nb.disallowedTools.length
  ) {
    return false;
  }
  return na.disallowedTools.every((tool, i) => tool === nb.disallowedTools[i]);
}

module.exports = { normalizeSpawnOptions, sameSpawnOptions };
