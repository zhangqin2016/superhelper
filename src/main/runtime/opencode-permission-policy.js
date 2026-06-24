"use strict";

/**
 * Host-side permission decision — the single source of truth for a session's
 * permission MODE. The shared serve only ever "asks" for mutations (see
 * buildSharedBaseConfig); when that ask arrives as a permission event, THIS
 * decides what to do for the session's mode: "allow" (auto-approve), "deny"
 * (auto-reject), or "ask" (surface the dialog to the user).
 *
 * This replaces baking the permission ruleset into the serve config — which a
 * single shared serve can't do per-session. Mirrors the official desktop
 * client, which likewise decides auto-accept host-side and responds to events.
 *
 * Catastrophic shell is NEVER auto-allowed: it always surfaces, in every mode,
 * as a backstop independent of the mode logic.
 */

const { DESTRUCTIVE_BASH, CATASTROPHIC_BASH } = require("./opencode-config-builder");
const { assessWorkspaceWrite } = require("../workspace-grounding-gate");

function escapeRe(x) {
  return String(x).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Match a command against one "*"-glob from the bash lists (anchored at start). */
function globMatch(command, pattern) {
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*"));
  return re.test(String(command || ""));
}

function matchesAny(command, patterns) {
  return patterns.some((p) => globMatch(command, p));
}

/**
 * @param {string} mode  "plan" | "ask" | "full"
 * @param {string} toolName  the gated tool (bash/edit/write/external_directory/...)
 * @param {object} input  the permission event metadata (bash: {command}, edit: {filePath})
 * @param {{ cwd?: string, taskContract?: object|null }} context
 * @returns {"allow"|"deny"|"ask"}
 */
function decidePermission(mode, toolName, input = {}, context = {}) {
  const tool = String(toolName || "").toLowerCase();
  const command = input.command || input.cmd || "";
  const filePath = input.filePath || input.path || input.file || "";
  const outsideWorkspace = typeof filePath === "string" && filePath.startsWith("..");

  // Backstop: irreversible disasters always surface, regardless of mode.
  if (tool === "bash" && matchesAny(command, CATASTROPHIC_BASH)) return "ask";

  const workspaceVerdict = assessWorkspaceWrite({
    projectPath: context.cwd || context.taskContract?.projectPath || "",
    toolName: tool,
    input,
    groundingPolicy: context.taskContract?.workspaceGroundingPolicy || null,
  });
  if (workspaceVerdict.verdict === "ask") return "ask";
  if (workspaceVerdict.verdict === "deny") return "deny";

  switch (mode) {
    case "plan":
      // Read-only: every mutation denied (reads/research already "allow" server-side).
      if (["edit", "write", "patch", "bash", "external_directory"].includes(tool)) return "deny";
      return "allow";

    case "full":
      // Autonomous: everything runs (catastrophic already handled above).
      return "allow";

    case "ask":
    default:
      // Balanced: confirm risky shell + edits/work outside the workspace; rest runs.
      if (tool === "bash" && matchesAny(command, DESTRUCTIVE_BASH)) return "ask";
      if ((tool === "edit" || tool === "write" || tool === "patch") && outsideWorkspace) return "ask";
      if (tool === "external_directory") return "ask";
      return "allow";
  }
}

module.exports = { decidePermission, globMatch, matchesAny };
