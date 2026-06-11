"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Identifies our managed hook entry inside the user's hooks array. */
const HOOK_MARKER = "verify-edit.cjs";

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildHookEntry(nodePath, scriptPath) {
  return {
    matcher: "Edit|Write|MultiEdit|Bash",
    hooks: [
      {
        type: "command",
        command: `${quoteArg(nodePath)} ${quoteArg(scriptPath)}`,
        timeout: 30,
      },
    ],
  };
}

/**
 * Idempotently install the post-edit verification hook into the engine's
 * user settings (CLAUDE_CONFIG_DIR/settings.json — per-session config dirs
 * symlink this file, so one write covers every session). Replaces only our
 * own marker entry; any hooks the user configured themselves are preserved.
 *
 * @param {{ settingsPath: string, nodePath: string, scriptPath: string }} opts
 * @returns {boolean} true when the file was written
 */
function ensureVerificationHooks({ settingsPath, nodePath, scriptPath }) {
  if (!settingsPath || !nodePath || !scriptPath) return false;
  if (!fs.existsSync(scriptPath)) return false;

  let settings = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object") settings = parsed;
  } catch {
    // missing or corrupt settings: start from the managed entry only
  }

  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const post = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  const desired = buildHookEntry(nodePath, scriptPath);
  const index = post.findIndex((entry) => JSON.stringify(entry).includes(HOOK_MARKER));

  if (index >= 0 && JSON.stringify(post[index]) === JSON.stringify(desired)) return false;
  if (index >= 0) post[index] = desired;
  else post.push(desired);

  hooks.PostToolUse = post;
  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return true;
}

module.exports = { ensureVerificationHooks, buildHookEntry, HOOK_MARKER };
