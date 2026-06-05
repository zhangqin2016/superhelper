"use strict";

/** @see `claude --help` — permission-mode choices and bypass flags */
const ALLOW_BYPASS_FLAG = "--allow-dangerously-skip-permissions";

/**
 * Append Claude CLI permission flags for AgentSession spawn.
 *
 * The desktop app exposes bypass in settings and can hot-switch via
 * set_permission_mode. Native CLI only enables bypass when spawn includes
 * `--allow-dangerously-skip-permissions` (or `--dangerously-skip-permissions`).
 *
 * @param {string[]} args mutable spawn argv
 * @param {string} [permissionMode]
 */
function appendPermissionSpawnArgs(args, permissionMode) {
  args.push("--permission-mode", permissionMode || "default");
  args.push(ALLOW_BYPASS_FLAG);
}

module.exports = {
  ALLOW_BYPASS_FLAG,
  appendPermissionSpawnArgs,
};
