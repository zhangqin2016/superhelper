"use strict";

/**
 * The router's best match, stated as an instruction instead of a listing.
 *
 * The capability graph lists recommended guides as reference, and models that
 * were not trained on a read-the-skill-first protocol skip it: over 60 days
 * DeepSeek-V4.1-Flash read a recommended guide on 5% of such turns,
 * deepseek-v4-pro on 4%, Qwen3.8-Flash on 12% — while gpt-6-astra, whose
 * vendor trains that protocol (Codex), read on 50%. Codex's own rule is: a
 * clearly matching skill must be read completely before acting, and a skipped
 * one must be explained. This applies that rule to the router's top pick.
 *
 * It is an instruction the model may decline, never content forced on it: the
 * router scores by regex and misfires even at high scores (a pasted image tag
 * scored 160 for code repair), so injecting the guide's body would carry those
 * misfires into the turn. Asked to read — or to say in a line why it does not
 * fit — the model keeps its judgment. Only rule-level matches get the line:
 * scores below 120 come from keyword hints alone (60 on real turns).
 * LILY_SKILL_BEST_MATCH_DIRECTIVE=0 restores the listing alone.
 */
const DIRECTIVE_MIN_SCORE = 120;
const DIRECTIVE_PREFIX = "Best match for this request:";

/**
 * Characters the directive adds. The capability context grants them on top of
 * its own budget: at 1800 chars the listing already kept only the first of five
 * platform routes (dependency.install), and the directive must not push even
 * that one out (2026-09-26).
 */
function directiveChars(lines = []) {
  return lines.filter((line) => String(line).startsWith(DIRECTIVE_PREFIX)).reduce((sum, line) => sum + String(line).length + 1, 0);
}

function bestMatchDirective(opts = {}, listed = []) {
  if (process.env.LILY_SKILL_BEST_MATCH_DIRECTIVE === "0") return [];
  try {
    const top = require("./capability-broker").rankSkillCapabilityGraph({ ...opts, maxSkills: 1 })[0];
    if (!top || top.score < DIRECTIVE_MIN_SCORE) return [];
    if (!listed.some((item) => item.id === top.skill.id)) return [];
    return [`${DIRECTIVE_PREFIX} ${top.skill.id}. Before taking task actions, read its guide completely: ${top.skill.guidePath}. If it does not fit this request, say why in one short line and continue.`];
  } catch (err) {
    console.warn("[skill-guide-directive] failed open:", err?.message || err);
    return [];
  }
}

module.exports = { DIRECTIVE_MIN_SCORE, DIRECTIVE_PREFIX, bestMatchDirective, directiveChars };
