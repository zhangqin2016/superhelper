"use strict";

/**
 * Inclusion-group conflict resolution (§10.4.3).
 *
 * Entries share a conflict edge when they share any inclusion group. For each
 * connected component, resolve in stable rounds until no conflict remains:
 *
 * 1. Scoring (optional, once per component): for each group where EVERY
 *    member candidate declares useGroupScoring, keep only the highest
 *    key-match score (ties survive).
 * 2. Prioritized: when any remaining member declares prioritizeInclusion, the
 *    round winner is the flagged entry with the highest insertion order, then
 *    the lexicographically smallest stable entry ID — no PRNG involved.
 * 3. Weighted: deterministic draw over integer cumulative groupWeight with
 *    rejection sampling (uniformInt over the total weight, no modulo bias).
 *    When the total weight exceeds 2^32 the weights are proportionally
 *    down-scaled (floor(w * 2^31 / total)) before the draw — same cumulative
 *    order, deterministic; entries whose scaled weight floors to 0 simply
 *    cannot win. Total (scaled) weight 0 or exhausted draws fall back to the
 *    smallest entry ID — both documented, deterministic fallbacks.
 * 4. Remove every entry conflicting with the winner and repeat.
 *
 * Complexity: entry→groups and group→members indexes are built ONCE per
 * frontier (O(G)); components come from a union-find over those indexes (no
 * O(m²) edge materialization); per round the weighted pick and each
 * elimination cost O(log m) through a Fenwick tree over member weights, so a
 * 10k-entry single group resolves in one round and a path-shaped graph of
 * thousands of entries finishes in O(m log m). All work is charged to the
 * resolver operation budget and rounds are hard-capped (maxGroupRounds) with
 * a coded breach error — never a silent hang.
 *
 * The resolver feeds the PRNG factory (keyed by owner/session/turn/revision/
 * component/round), so evaluation order cannot change outcomes. Decisions are
 * recorded per round for the trace; no matched text is recorded.
 */

const { uniformInt } = require("./macro-prng");
const { codedError } = require("./persistence-codec");

const UINT32_RANGE = 0x1_0000_0000;
const WEIGHT_SCALE_TARGET = 0x8000_0000;

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function budgetExceeded(limit, maximum, actual) {
  return codedError(
    "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED",
    "World book activation group budget was exhausted",
    { limit, maximum, actual },
  );
}

// Fenwick tree over per-member weights with point deletes and an order-statistic
// select, so each weighted draw and elimination costs O(log m).
class WeightTree {
  constructor(weights) {
    this.size = weights.length;
    this.tree = new Array(this.size).fill(0);
    for (let index = 0; index < this.size; index += 1) this.add(index, weights[index]);
  }

  add(index, delta) {
    for (let at = index; at < this.size; at |= at + 1) this.tree[at] += delta;
  }

  remove(index, weight) {
    this.add(index, -weight);
  }

  total() {
    return this.prefix(this.size);
  }

  prefix(count) {
    let sum = 0;
    for (let at = count - 1; at >= 0; at = (at & (at + 1)) - 1) sum += this.tree[at];
    return sum;
  }

  // Smallest index whose prefix sum exceeds ticket (ticket in [0, total)).
  select(ticket) {
    let position = 0;
    for (let bit = 1 << (31 - Math.clz32(this.size || 1)); bit > 0; bit >>= 1) {
      const next = position + bit - 1;
      if (next < this.size && this.tree[next] <= ticket) {
        ticket -= this.tree[next];
        position += bit;
      }
    }
    return position;
  }
}

function buildComponents(candidates, budget) {
  const groupToMembers = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    for (const group of candidates[index].entry.activation.inclusionGroups) {
      if (!groupToMembers.has(group)) groupToMembers.set(group, []);
      groupToMembers.get(group).push(index);
    }
  }
  const parent = candidates.map((_, index) => index);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== root) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  for (const members of groupToMembers.values()) {
    budget(members.length);
    for (let index = 1; index < members.length; index += 1) {
      parent[find(members[index])] = find(members[0]);
    }
  }
  const components = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index].entry.activation.inclusionGroups.length === 0) continue;
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(index);
  }
  return { components: [...components.values()], groupToMembers };
}

// Spec step 1, applied once per component: in groups where every member
// declares useGroupScoring, drop all but the highest key-match score.
function applyGroupScoring(live, candidates, groupToMembers, eliminated, budget) {
  const seen = new Set();
  for (const index of live) {
    for (const group of candidates[index].entry.activation.inclusionGroups) {
      if (seen.has(group)) continue;
      seen.add(group);
      const members = groupToMembers.get(group).filter((member) => live.has(member));
      budget(members.length);
      if (members.length < 2) continue;
      if (!members.every((member) => candidates[member].entry.activation.useGroupScoring)) continue;
      const best = Math.max(...members.map((member) => candidates[member].matchedKeyCount));
      for (const member of members) {
        if (candidates[member].matchedKeyCount < best && live.has(member)) {
          live.delete(member);
          eliminated.push(candidates[member].entry.id);
        }
      }
    }
  }
}

/**
 * @param {Array} candidates frontier candidates ({entry, matchedKeyCount, ...})
 * @param {Map} blockedGroups group name -> selected entryId (already selected
 *   entries; new candidates sharing such a group are eliminated outright)
 * @param {(phase: string) => object} prngFor deterministic PRNG factory
 * @param {object} counters complexity counters (groupRounds, probabilityDraws)
 * @param {object} options {budget, maxGroupRounds}
 */
function resolveInclusionGroups(candidates, blockedGroups, prngFor, counters, options) {
  const budget = options.budget;
  const blocked = [];
  const eligible = [];
  for (const candidate of candidates) {
    const hit = candidate.entry.activation.inclusionGroups.find((group) => blockedGroups.has(group));
    if (hit === undefined) eligible.push(candidate);
    else blocked.push({ entryId: candidate.entry.id, winnerId: blockedGroups.get(hit) });
  }

  const winners = eligible.filter((candidate) => (
    candidate.entry.activation.inclusionGroups.length === 0
  ));
  const withGroups = eligible.filter((candidate) => (
    candidate.entry.activation.inclusionGroups.length > 0
  ));
  const decisions = [];
  const { components, groupToMembers } = buildComponents(withGroups, budget);

  for (const component of components) {
    const componentIds = component.map((index) => withGroups[index].entry.id).sort(compareIds);
    const live = new Set(component);
    const componentEliminated = [];
    const componentWinners = [];
    const rounds = [];

    applyGroupScoring(live, withGroups, groupToMembers, componentEliminated, budget);

    // Stable draw order: ascending entry id. Weights are scaled once when the
    // component total would overflow the PRNG's 2^32 bound.
    const drawOrder = [...live].sort((a, b) => (
      compareIds(withGroups[a].entry.id, withGroups[b].entry.id)
    ));
    const rawWeights = drawOrder.map((index) => Math.max(0, withGroups[index].entry.activation.groupWeight | 0));
    const rawTotal = rawWeights.reduce((sum, weight) => sum + weight, 0);
    const scale = rawTotal > UINT32_RANGE ? WEIGHT_SCALE_TARGET / rawTotal : 1;
    const weights = rawWeights.map((weight) => Math.floor(weight * scale));
    const tree = new WeightTree(weights);
    const positionOf = new Map(drawOrder.map((index, position) => [index, position]));
    const flagged = drawOrder
      .filter((index) => withGroups[index].entry.activation.prioritizeInclusion)
      .sort((a, b) => (
        withGroups[b].entry.insertion.order - withGroups[a].entry.insertion.order
        || compareIds(withGroups[a].entry.id, withGroups[b].entry.id)
      ));

    while (live.size > 1) {
      counters.groupRounds += 1;
      if (counters.groupRounds > options.maxGroupRounds) {
        throw budgetExceeded("maxGroupRounds", options.maxGroupRounds, counters.groupRounds);
      }
      budget();
      let winnerIndex = null;
      let mode = "weighted";
      const flaggedWinner = flagged.find((index) => live.has(index));
      if (flaggedWinner !== undefined) {
        winnerIndex = flaggedWinner;
        mode = "prioritized";
      } else {
        const total = tree.total();
        if (total > 0) {
          counters.probabilityDraws += 1;
          const anchor = componentIds[0];
          const ticket = uniformInt(prngFor(`g:${anchor}:${rounds.length}`), total);
          winnerIndex = ticket === null ? null : drawOrder[tree.select(ticket)];
        }
        if (winnerIndex === null) winnerIndex = drawOrder.find((index) => live.has(index));
      }
      const winnerId = withGroups[winnerIndex].entry.id;
      const roundEliminated = [];
      const conflicts = new Set([winnerIndex]);
      for (const group of withGroups[winnerIndex].entry.activation.inclusionGroups) {
        for (const member of groupToMembers.get(group)) conflicts.add(member);
      }
      budget(conflicts.size);
      for (const member of conflicts) {
        if (!live.has(member)) continue;
        live.delete(member);
        tree.remove(positionOf.get(member), weights[positionOf.get(member)]);
        if (member !== winnerIndex) {
          roundEliminated.push(withGroups[member].entry.id);
          componentEliminated.push(withGroups[member].entry.id);
        }
      }
      componentWinners.push(winnerId);
      rounds.push({ winnerId, eliminated: roundEliminated.sort(compareIds), mode });
    }
    if (live.size === 1) {
      componentWinners.push(withGroups[[...live][0]].entry.id);
    }
    for (const winnerId of componentWinners) {
      winners.push(withGroups.find((candidate) => candidate.entry.id === winnerId));
    }
    decisions.push({
      component: componentIds,
      winnerId: componentWinners[0],
      winners: [...componentWinners].sort(compareIds),
      eliminated: [...componentEliminated].sort(compareIds),
      mode: rounds.length > 0 ? rounds[0].mode : "single",
      rounds,
    });
  }
  return { winners, decisions, blocked };
}

module.exports = {
  resolveInclusionGroups,
};
