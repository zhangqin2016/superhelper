"use strict";

/**
 * The engine scans ~/.claude/skills and ~/.agents/skills for skills of other
 * agents and advertises every one in its native `skill` tool. What a user's
 * machine happens to hold is not Lily's catalog: on 2026-09-25 the engine
 * offered 91 skills on the developer's machine, 90 of them foreign, and they
 * were loaded 91 times in 30 days — behaviour that differs machine to machine
 * and dozens of foreign descriptions in every request. Lily's skills reach the
 * model through AGENT.md and the capability graph, and the native tool is
 * denied (opencode-config-builder baseSharedPermission); the scan is off too.
 * LILY_ENGINE_EXTERNAL_SKILLS=1 restores it.
 */
function externalSkillScanEnv(env = process.env) {
  if (env.LILY_ENGINE_EXTERNAL_SKILLS === "1") return {};
  return { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" };
}

module.exports = { externalSkillScanEnv };
