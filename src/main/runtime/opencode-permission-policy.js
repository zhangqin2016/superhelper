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

// Root/home wipe: rm with combined recursive+force flags whose target is
// exactly /, ~, or $HOME (optionally with a trailing /* or --no-preserve-root).
// Deliberately EXACT: "rm -rf /Users/x/build" is destructive, not catastrophic —
// full mode auto-allows it. The old glob "rm -rf /*" matched ANY absolute path,
// so full-autonomy sessions still got permission cards for ordinary absolute-path
// cleanups (the 2026-07-22 field case: rm -rf .../rendered-pages hung a turn).
const ROOT_HOME_WIPE_RE =
  /^rm\s+-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*\s+(?:\/|~\/?|\$HOME\/?|\$\{HOME\}\/?)(?:\s*\*)?(?:\s+--no-preserve-root)?$/i;

// Non-rm catastrophic patterns (mkfs, dd to raw disk) still come from the shared list.
const CATASTROPHIC_NON_RM = CATASTROPHIC_BASH.filter((p) => !p.startsWith("rm "));

/** True when any command segment (split on &&/||/;) wipes root or home. */
function isCatastrophicShell(command) {
  const segments = String(command || "").split(/&&|\|\||;/);
  return segments.some((seg) => ROOT_HOME_WIPE_RE.test(seg.trim())) || matchesAny(command, CATASTROPHIC_NON_RM);
}

/**
 * @param {string} mode  "plan" | "ask" | "full"
 * @param {string} toolName  the gated tool (bash/edit/write/external_directory/...)
 * @param {object} input  the permission event metadata (bash: {command}, edit: {filePath})
 * @param {{ cwd?: string, taskContract?: object|null, nonInteractive?: boolean }} context
 * @returns {"allow"|"deny"|"ask"}
 */
function decidePermission(mode, toolName, input = {}, context = {}) {
  const verdict = decidePermissionVerdict(mode, toolName, input, context);
  // Unattended internal turns (delivery re-checks, rescue retries): a card
  // nobody will ever answer hangs the turn until the watchdog kills it (the
  // 2026-07-22 field case: an internal delivery re-check's rm -rf cleanup
  // waited 20 minutes on a permission card, then the turn was aborted).
  // Deny instead — the engine continues immediately and the model adapts
  // (e.g. skips an optional cleanup). Deny is the fail-safe direction: an
  // internal turn never NEEDS a destructive op to finish its report.
  if (verdict === "ask" && context.nonInteractive) return "deny";
  return verdict;
}

function decidePermissionVerdict(mode, toolName, input = {}, context = {}) {
  const tool = String(toolName || "").toLowerCase();
  const command = input.command || input.cmd || "";
  const filePath = input.filePath || input.path || input.file || "";
  const outsideWorkspace = typeof filePath === "string" && filePath.startsWith("..");

  // Backstop: irreversible disasters always surface, regardless of mode.
  if (tool === "bash" && isCatastrophicShell(command)) return "ask";

  // Full autonomy = full. Beyond the catastrophic backstop above, full mode runs
  // everything WITHOUT asking — including the workspace-grounding gate below,
  // which is a confirm-first SAFETY check for the balanced ("ask") and "plan"
  // modes only. Running it in full contradicted full's own contract ("edits
  // files and runs commands without asking; still confirms a few irreversible
  // disasters") and was why full sessions still got prompted before creating new
  // directories in coding tasks. (User-confirmed: full means full.)
  if (mode === "full") return "allow";

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
