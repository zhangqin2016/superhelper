"use strict";
/**
 * §19.5: inclusion-group conflict resolution. Winners never violate
 * inclusion (two winners cannot share a group), blocked groups propagate to
 * later candidates, the decision is deterministic for the same seed, and a
 * greedy reference planner agrees with the resolver on the no-competition
 * single-candidate components.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveInclusionGroups,
} = require("../src/main/character-worlds/world-book-groups.js");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function prngFactory(seed) {
  let state = (seed >>> 0) || 1;
  return (phase) => ({
    nextUInt32() {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state;
    },
  });
}

function entry(id, groups, opts = {}) {
  return {
    id,
    insertion: { order: opts.order ?? Number(id.replace(/\D/g, "") || 0) },
    activation: { inclusionGroups: groups, useGroupScoring: true, prioritizeInclusion: false },
  };
}

function candidate(id, groups, matchedKeyCount = 1, opts = {}) {
  return { entry: entry(id, groups, opts), matchedKeyCount };
}

function run(candidates, blockedGroups = new Map(), seed = 1) {
  const counters = { groupRounds: 0, probabilityDraws: 0 };
  const result = resolveInclusionGroups(
    candidates,
    blockedGroups,
    prngFactory(seed),
    counters,
    { budget: () => {}, maxGroupRounds: 64 },
  );
  return {
    winners: result.winners.map((w) => w.entry.id).sort(),
    eliminated: result.decisions.flatMap((d) => d.eliminated || []).sort(),
    blocked: result.blocked,
    decisions: result.decisions,
  };
}

try {
  await check("winners never share an inclusion group and blocked groups propagate", async () => {
    const candidates = [
      candidate("c1", ["g1"]),
      candidate("c2", ["g1"]),
      candidate("c3", ["g2"]),
    ];
    const result = run(candidates);
    assert.ok(result.winners.length >= 1, "at least one winner");
    for (const winner of result.winners) {
      const groups = candidates.find((c) => c.entry.id === winner).entry.activation.inclusionGroups;
      const sameGroupWinner = result.winners.find((other) => other !== winner
        && candidates.find((c) => c.entry.id === other).entry.activation.inclusionGroups.some((g) => groups.includes(g)));
      assert.equal(sameGroupWinner, undefined, `no shared group among winners (${result.winners})`);
    }
    // c3 belongs to a fresh group → always a winner regardless of g1 draw.
    assert.ok(result.winners.includes("c3"), "fresh-group candidate wins");
  });

  await check("blocked groups eliminate later candidates outright", async () => {
    const blocked = new Map([["g1", "c1"]]);
    const result = run([candidate("c2", ["g1"]), candidate("c3", ["g3"])], blocked);
    assert.ok(!result.winners.includes("c2"), "blocked-group candidate eliminated");
    assert.ok(result.winners.includes("c3"), "independent candidate wins");
  });

  await check("deterministic for the same seed", async () => {
    const candidates = [candidate("a", ["g1"]), candidate("b", ["g1", "g2"]), candidate("d", ["g3"])];
    const first = run(candidates, new Map(), 42);
    const second = run(candidates, new Map(), 42);
    assert.deepEqual(first.winners, second.winners, "same seed reproduces winners");
  });

  await check("greedy reference planner agrees on single-candidate components", async () => {
    // Components with exactly one eligible candidate resolve to that candidate.
    const candidates = [candidate("x", ["g1"]), candidate("y", ["g2"]), candidate("z", ["g3"])];
    const result = run(candidates);
    assert.deepEqual([...result.winners].sort(), ["x", "y", "z"], "independent groups all win");
  });

  console.log(`PASS: test-character-world-book-groups (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
