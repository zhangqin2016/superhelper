"use strict";

/**
 * Environment applicability for the mandatory guide bodies that ride every
 * prompt.
 *
 * Those bodies used to be one monolithic string per locale, so nothing inside
 * them could ever be conditional. Windows PowerShell rules shipped in every
 * prompt on macOS and Linux, where they cannot apply, and there was no way to
 * prune them without editing prose. A manifest can now declare its guide as
 * addressable `blocks`, each optionally carrying an `appliesTo` condition.
 *
 * Rules are pushed, not pulled: a rule the model was never shown is a rule it
 * violates. So this prunes ONLY blocks that provably cannot apply to the
 * current environment, and every uncertain path keeps the block:
 *
 *   - no `blocks` at all            -> the original `body`, unchanged
 *   - block with no `appliesTo`     -> always kept
 *   - condition key we do not know  -> kept (never delete a rule on a guess)
 *   - every block filtered out      -> the original `body`, unchanged
 *
 * The worst case is therefore today's behaviour, never less guidance.
 */

/** What the running install actually is. Kept tiny and injectable so tests can
 *  ask for another platform without pretending to be one. */
function currentGuideEnvironment() {
  return { platform: process.platform };
}

/**
 * Does this block apply here? Every declared key must match; an unknown key is
 * treated as matching, because the alternative is dropping a mandatory rule
 * because a newer manifest used a condition this build has not learned yet.
 */
function blockApplies(block, env) {
  const applies = block && block.appliesTo;
  if (!applies || typeof applies !== "object") return true;
  for (const [key, wanted] of Object.entries(applies)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) return true;
    const allowed = Array.isArray(wanted) ? wanted : [wanted];
    if (!allowed.includes(env[key])) return false;
  }
  return true;
}

/**
 * The guide body to inline for this environment.
 *
 * Joining every block with a blank line must reproduce `body` byte for byte —
 * that is what keeps a Windows install identical to before this existed, and
 * scripts/test-agent-guide-blocks.mjs holds manifests to it.
 */
function resolveGuideBody(guide, env = currentGuideEnvironment()) {
  const fallback = typeof guide?.body === "string" ? guide.body : "";
  const blocks = guide?.blocks;
  if (!Array.isArray(blocks) || !blocks.length) return fallback;

  const usable = blocks.filter((block) => block && typeof block.body === "string");
  if (!usable.length) return fallback;

  const kept = usable.filter((block) => blockApplies(block, env));
  // A section that pruned itself to nothing is a bug in the manifest, not an
  // instruction to ship no rules.
  if (!kept.length) return fallback;

  return kept.map((block) => block.body).join("\n\n");
}

/** Ids of the blocks a given environment drops, for logs and tests. */
function prunedBlockIds(guide, env = currentGuideEnvironment()) {
  const blocks = Array.isArray(guide?.blocks) ? guide.blocks : [];
  if (!blocks.length) return [];
  const kept = blocks.filter((block) => block && typeof block.body === "string" && blockApplies(block, env));
  if (!kept.length) return [];
  return blocks
    .filter((block) => block && typeof block.body === "string" && !blockApplies(block, env))
    .map((block) => String(block.id || "(unnamed)"));
}

module.exports = { currentGuideEnvironment, blockApplies, resolveGuideBody, prunedBlockIds };
