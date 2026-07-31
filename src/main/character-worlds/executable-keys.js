"use strict";

/**
 * Shared executable-key predicate for the character-card ecosystem. Keys that
 * name executable behavior (scripts, plugins, quick replies) are never
 * imported into normalized documents: they classify as rejectedExecutable in
 * the compatibility report and survive only in the raw preserved payload.
 */

const EXECUTABLE_KEYS = new Set([
  "executable",
  "script",
  "scripts",
  "plugin",
  "plugins",
  "regexscript",
  "regexscripts",
  "stscript",
  "quickreply",
  "quickreplies",
]);

function executableKey(key) {
  return EXECUTABLE_KEYS.has(key.replace(/[\s_-]+/g, "").toLowerCase());
}

module.exports = {
  EXECUTABLE_KEYS,
  executableKey,
};
