"use strict";

// Feedback reinforcement (roadmap ④): memories that keep proving useful rank a
// little higher; ones that fall out of use fade. Durable per-project usage stats
// keyed by the memory item's entryKey. OPT-IN (LILY_MEMORY_REINFORCE=1).
//
// NOT-DUMBER contract: the reinforcement boost is BOUNDED and SMALL (≤ MAX_BOOST,
// vs relevance*25 in the ranker), so it only reorders items that are already
// closely relevant — it can NEVER surface an irrelevant memory or override a
// clearly-more-relevant one. Recency-weighted so a once-popular but stale item
// decays (no rich-get-richer entrenchment). Read/writes are fail-open; nothing is
// ever deleted — this only re-weights.

const fs = require("node:fs");
const path = require("node:path");

const MAX_BOOST = 8; // ceiling of the reinforcement term (base relevance is up to ~43)
const RECENCY_HALFLIFE_DAYS = 30; // usage older than this contributes ~nothing
const MAX_ENTRIES = 500; // cap the per-project store (drop least-recently-used)
const DAY_MS = 86_400_000;

function safeKey(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function storePath(projectKey) {
  try {
    return require("./config").userDataPath("memory-reinforcement", `${safeKey(projectKey)}.json`);
  } catch {
    return null;
  }
}

// Map(entryKey -> { hits, lastUsedAt }). Fail-open to empty.
function loadReinforcement(projectKey) {
  const out = new Map();
  const file = storePath(projectKey);
  if (!file) return out;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [key, stat] of Object.entries(parsed?.entries || {})) {
      out.set(key, { hits: Number(stat?.hits || 0), lastUsedAt: Number(stat?.lastUsedAt || 0) });
    }
  } catch {
    /* missing/corrupt → empty */
  }
  return out;
}

// Bounded [0..MAX_BOOST] score from usage frequency (saturating) + recency (decay).
function scoreFrom(stat, now = Date.now()) {
  const hits = Number(stat?.hits || 0);
  if (hits <= 0) return 0;
  const ageDays = Math.max(0, (now - Number(stat?.lastUsedAt || 0)) / DAY_MS);
  const recency = Math.max(0, 1 - ageDays / RECENCY_HALFLIFE_DAYS);
  const freq = Math.min(1, Math.log2(1 + hits) / 4); // hits≈15 → ~1
  return Number((MAX_BOOST * (0.6 * freq + 0.4 * recency)).toFixed(3));
}

// entryKey -> bounded boost, for the ranker. Empty map when nothing tracked.
function reinforcementBoosts(entryKeys = [], projectKey, now = Date.now()) {
  const stats = loadReinforcement(projectKey);
  const out = new Map();
  for (const key of entryKeys) {
    const stat = stats.get(key);
    if (stat) out.set(key, scoreFrom(stat, now));
  }
  return out;
}

// Record that these memories were actually USED (selected for injection) this
// turn — the positive signal. Bumps hits + lastUsedAt, caps the store LRU-style.
function recordUsage(projectKey, entryKeys = [], now = Date.now()) {
  const file = storePath(projectKey);
  if (!file) return false;
  const keys = [...new Set((Array.isArray(entryKeys) ? entryKeys : []).map(String).filter(Boolean))];
  if (!keys.length) return false;
  try {
    const stats = loadReinforcement(projectKey);
    for (const key of keys) {
      const prev = stats.get(key) || { hits: 0, lastUsedAt: 0 };
      stats.set(key, { hits: prev.hits + 1, lastUsedAt: now });
    }
    // LRU cap: keep the most-recently-used MAX_ENTRIES.
    let entries = [...stats.entries()];
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => Number(b[1].lastUsedAt || 0) - Number(a[1].lastUsedAt || 0));
      entries = entries.slice(0, MAX_ENTRIES);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries(entries) }), "utf8");
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MAX_BOOST,
  loadReinforcement,
  scoreFrom,
  reinforcementBoosts,
  recordUsage,
};
