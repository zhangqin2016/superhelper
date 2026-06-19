"use strict";

/** @see `claude --help` — bypass flag */
const ALLOW_BYPASS_FLAG = "--allow-dangerously-skip-permissions";

/**
 * Permission-mode values the CLI's `--permission-mode` flag accepts. "auto" is
 * accepted by this build and is the app default; the other four are the native
 * choices. App-internal modes NOT in this set (notably "dontAsk") are enforced
 * by the approval broker, not the CLI — passing one as the flag makes the CLI
 * reject the arg and exit non-zero at startup, which silently broke every
 * unattended scheduled run (they always force "dontAsk").
 */
const CLI_PERMISSION_MODES = new Set([
  "auto",
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

/** Map an app permission mode to one the CLI flag accepts (the broker keeps the real mode). */
function toCliPermissionMode(permissionMode) {
  return CLI_PERMISSION_MODES.has(permissionMode) ? permissionMode : "default";
}

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
  args.push("--permission-mode", toCliPermissionMode(permissionMode || "default"));
  args.push(ALLOW_BYPASS_FLAG);
}

module.exports = {
  ALLOW_BYPASS_FLAG,
  CLI_PERMISSION_MODES,
  toCliPermissionMode,
  appendPermissionSpawnArgs,
};
