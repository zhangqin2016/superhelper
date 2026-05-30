"use strict";

/**
 * Normalize runner spawn options for stable equality checks.
 * resumeSessionId is intentionally excluded — it only affects cold spawn.
 * @param {{ agentCommand?: string, permissionMode?: string, disallowedTools?: string[], stagingDir?: string, configDir?: string }} opts
 */
function normalizeSpawnOptions(opts) {
  const tools = [...(opts?.disallowedTools || [])].sort();
  return {
    agentCommand: opts?.agentCommand || "",
    permissionMode: opts?.permissionMode || "default",
    disallowedTools: tools,
    stagingDir: opts?.stagingDir || "",
    configDir: opts?.configDir || "",
  };
}

/**
 * Compare options that require process respawn if different.
 * configDir is excluded — AGENT.md is refreshed on disk without respawn.
 * @param {ReturnType<typeof normalizeSpawnOptions>} a
 * @param {ReturnType<typeof normalizeSpawnOptions>} b
 */
function sameRespawnOptions(a, b) {
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

/** @deprecated use sameRespawnOptions */
function sameSpawnOptions(a, b) {
  const na = normalizeSpawnOptions(a);
  const nb = normalizeSpawnOptions(b);
  if (!sameRespawnOptions(a, b)) return false;
  return na.configDir === nb.configDir;
}

module.exports = { normalizeSpawnOptions, sameRespawnOptions, sameSpawnOptions };
