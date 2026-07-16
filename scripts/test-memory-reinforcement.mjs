#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-reinforce-"));
process.env.LILY_USER_DATA_DIR = tmp;

const require = createRequire(import.meta.url);
const { MAX_BOOST, scoreFrom, recordUsage, loadReinforcement, reinforcementBoosts } = require("../src/main/memory-reinforcement.js");
const { rankMemoryItemsWithDiagnostics } = require("../src/main/memory-registry.js");
const { entryKey } = require("../src/main/memory-vector-index.js");

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

// --- scoreFrom: bounded, freq-saturating, recency-decaying ---
assert.equal(scoreFrom({ hits: 0 }, NOW), 0, "no hits → 0");
const fresh = scoreFrom({ hits: 20, lastUsedAt: NOW }, NOW);
assert.ok(fresh > 0 && fresh <= MAX_BOOST, "fresh heavy use is positive but bounded by MAX_BOOST");
const stale = scoreFrom({ hits: 20, lastUsedAt: NOW - 60 * DAY }, NOW);
assert.ok(stale < fresh, "stale use decays below fresh (recency)");
const once = scoreFrom({ hits: 1, lastUsedAt: NOW }, NOW);
assert.ok(once < fresh, "one hit scores below many hits (frequency)");

// --- usage round-trip + increment ---
assert.equal(recordUsage("projA", ["k1", "k2"], NOW), true);
recordUsage("projA", ["k1"], NOW + DAY);
const stats = loadReinforcement("projA");
assert.equal(stats.get("k1").hits, 2, "k1 used twice");
assert.equal(stats.get("k2").hits, 1, "k2 used once");
const boosts = reinforcementBoosts(["k1", "k2", "unseen"], "projA", NOW + DAY);
assert.ok(boosts.get("k1") > 0 && boosts.get("k2") > 0, "seen keys boosted");
assert.equal(boosts.has("unseen"), false, "unseen key has no boost");
assert.equal(loadReinforcement("otherProj").size, 0, "per-project isolation");

// --- ranking: reinforcement reorders near-ties but CANNOT override relevance ---
const items = [
  { id: "a", kind: "reference", text: "database connection pool tuning", priority: 50 },
  { id: "b", kind: "reference", text: "database connection pool tuning", priority: 50 }, // same as a
  { id: "c", kind: "reference", text: "unrelated css color palette notes", priority: 50 },
];
const kb = entryKey(items[1]); // boost item b
const kc = entryKey(items[2]); // heavily boost the irrelevant item c
const reinforcement = new Map([[kb, MAX_BOOST], [kc, MAX_BOOST]]);
const ranked = rankMemoryItemsWithDiagnostics(items, "database connection pool", { reinforcement }).items;
const byId = Object.fromEntries(ranked.map((r) => [r.id, r]));
assert.ok(byId.b.effectivePriority > byId.a.effectivePriority, "among equal-relevance items, the reinforced one ranks higher");
assert.equal(byId.b.effectivePriority - byId.a.effectivePriority, MAX_BOOST, "boost is exactly the bounded term");
assert.ok(byId.a.effectivePriority > byId.c.effectivePriority, "a relevant unboosted item still beats an irrelevant max-boosted one (can't dumb the model)");
assert.equal(byId.a.reinforcement, 0, "unboosted item carries no reinforcement");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("memory-reinforcement: ok");
