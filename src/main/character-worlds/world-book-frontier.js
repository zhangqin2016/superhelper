"use strict";

/**
 * Frontier evaluation for the world-book activation resolver (§10.4.2/§10.4.4).
 *
 * One frontier = one bounded scan pass plus candidate production and
 * inclusion-group resolution for that pass:
 *
 * - level 0 scans the primary corpus window and additionally produces
 *   constant, sticky carry-over, and due-delay candidates;
 * - recursion frontiers (level >= 1) scan the recursion corpus built from the
 *   previous frontier's winners;
 * - min-activation sweeps are extra level-0 frontiers over progressively
 *   older canonical messages.
 *
 * delayUntilRecursion entries are admitted only at their declared recursion
 * level; excludeFromRecursion entries never match from a recursion corpus;
 * matching-source units only match entries that opted in via matchSources.
 * Candidate count per frontier is hard-capped (maxCandidatesPerFrontier) with
 * a coded breach error. Selective secondary logic runs before filters; the
 * candidate gate (filters/timed/probability) lives in the resolver.
 *
 * Everything is deterministic: scan order follows corpus order, candidates
 * keep book order, and group resolution is seeded per component/round.
 */

const { scanUnit, matchingCopy } = require("./world-book-matching");
const { MATCHING_SOURCE_NAMES } = require("./world-book-corpus");
const { resolveInclusionGroups } = require("./world-book-groups");
const { codedError } = require("./persistence-codec");

function recursionGate(entry, level) {
  const recursion = entry.recursion ?? {};
  if (recursion.delayUntilRecursion === true) {
    return level === (recursion.recursionLevel ?? 0);
  }
  return true;
}

function sourceScopeFor(aggregate, unitKind) {
  if (aggregate.chat) return unitKind === "recursion" ? "recursion" : "chat";
  for (const name of MATCHING_SOURCE_NAMES) {
    if (aggregate.sources.has(name)) return name;
  }
  return unitKind === "recursion" ? "recursion" : "chat";
}

/**
 * @param {object} ctx shared resolver state:
 *   { index, entryById, matchable, checkpoint, selected, blockedGroups,
 *     keepDelay, omit, makeCandidate, traceGroups, counters, budget, prngFor,
 *     limits, sequenceNow }
 */
function createFrontierEvaluator(ctx) {
  const {
    index, entryById, matchable, checkpoint, selected, blockedGroups,
    keepDelay, omit, makeCandidate, traceGroups, counters, budget, prngFor,
    limits, sequenceNow,
  } = ctx;

  function scanUnits(units, level) {
    const matches = new Map();
    for (const unit of units) {
      budget();
      counters.unitsScanned += 1;
      counters.scanChars += [...unit.matchTextCi].length;
      scanUnit(index, unit, (key) => {
        counters.matchEvents += 1;
        budget();
        const entry = entryById.get(key.entryId);
        if (!entry || selected.has(entry.id)) return;
        if (unit.kind === "source" && !(entry.activation.matchSources ?? []).includes(unit.scope)) return;
        if (level > 0 && entry.recursion?.excludeFromRecursion === true) return;
        if (!recursionGate(entry, level)) return;
        if (!matches.has(entry.id)) {
          matches.set(entry.id, {
            primary: new Set(), secondary: new Set(), chat: false, sources: new Set(),
          });
        }
        const aggregate = matches.get(entry.id);
        (key.kind === "primary" ? aggregate.primary : aggregate.secondary).add(key.dedupeKey);
        if (unit.scope === "chat" || unit.kind === "recursion") aggregate.chat = true;
        else aggregate.sources.add(unit.scope);
      });
    }
    return matches;
  }

  function admitWinners(winners) {
    for (const candidate of winners) {
      selected.set(candidate.entry.id, candidate);
      for (const group of candidate.entry.activation.inclusionGroups ?? []) {
        if (!blockedGroups.has(group)) blockedGroups.set(group, candidate.entry.id);
      }
    }
  }

  function resolveFrontier(candidates) {
    if (candidates.length > limits.maxCandidatesPerFrontier) {
      throw codedError(
        "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED",
        "World book activation frontier candidate budget was exhausted",
        { limit: "maxCandidatesPerFrontier", maximum: limits.maxCandidatesPerFrontier, actual: candidates.length },
      );
    }
    const { winners, decisions, blocked } = resolveInclusionGroups(
      candidates, blockedGroups, prngFor, counters,
      { budget, maxGroupRounds: limits.maxGroupRounds },
    );
    for (const item of blocked) omit(item.entryId, "group_conflict");
    for (const decision of decisions) {
      traceGroups.push(decision);
      for (const entryId of decision.eliminated) omit(entryId, "group_conflict");
    }
    admitWinners(winners);
    return winners;
  }

  function evaluateFrontier(units, level, unitKind) {
    const candidates = [];
    if (level === 0) {
      for (const item of checkpoint.sticky) {
        if (item.untilSeq < sequenceNow || selected.has(item.entryId)) continue;
        const entry = entryById.get(item.entryId);
        if (!entry || entry.enabled === false || entry.activation?.useRegex === true) continue;
        const candidate = makeCandidate(entry, "sticky", "sticky", 0, 0);
        if (candidate) candidates.push(candidate);
      }
      const carriedIds = new Set(candidates.map((candidate) => candidate.entry.id));
      for (const entry of matchable) {
        if (entry.activation.constant !== true || carriedIds.has(entry.id)) continue;
        if (!recursionGate(entry, 0)) continue;
        const candidate = makeCandidate(entry, "constant", "constant", 0, 0);
        if (candidate) candidates.push(candidate);
      }
      for (const item of checkpoint.delay) {
        if (selected.has(item.entryId) || carriedIds.has(item.entryId)) continue;
        const entry = entryById.get(item.entryId);
        if (!entry || entry.enabled === false || entry.activation?.useRegex === true) continue;
        if (sequenceNow - item.matchedSeq < (entry.activation.delayMessages ?? 0)) {
          keepDelay(entry.id, item.matchedSeq);
          continue;
        }
        const candidate = makeCandidate(entry, "delay_due", "chat", 0, 0);
        if (candidate) candidates.push(candidate);
      }
    }
    const carriedIds = new Set(candidates.map((candidate) => candidate.entry.id));
    const matches = scanUnits(units, level);
    for (const [entryId, aggregate] of matches) {
      if (carriedIds.has(entryId)) continue;
      const entry = entryById.get(entryId);
      if (aggregate.primary.size === 0) continue;
      let matchedSecondary = null;
      if (entry.activation.selective === true) {
        const caseSensitive = entry.activation.caseSensitive === true;
        const total = new Set(
          (entry.activation.secondaryKeys ?? []).map((key) => matchingCopy(key, caseSensitive)),
        ).size;
        const matched = aggregate.secondary.size;
        const logic = entry.activation.selectiveLogic ?? "and_any";
        const pass = logic === "and_all" ? matched >= total
          : logic === "not_any" ? matched === 0
          : logic === "not_all" ? matched < total
          : matched >= 1;
        if (!pass) {
          omit(entryId, "selective_logic");
          continue;
        }
        matchedSecondary = [...aggregate.secondary].sort();
      }
      const candidate = makeCandidate(
        entry, "primary_key", sourceScopeFor(aggregate, unitKind), aggregate.primary.size, level,
        { primary: [...aggregate.primary].sort(), secondary: matchedSecondary },
      );
      if (candidate) candidates.push(candidate);
    }
    return resolveFrontier(candidates);
  }

  return { evaluateFrontier };
}

module.exports = {
  createFrontierEvaluator,
};
