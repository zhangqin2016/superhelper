"use strict";
/**
 * §19.5: the indexed plain-key matcher is compared against a simple
 * Unicode-aware reference matcher over generated small-world fixtures. The
 * automaton and the reference must agree on the exact match set (entryId,
 * key kind, end position) for every generated corpus, deterministically.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const matching = require("../src/main/character-worlds/world-book-matching.js");

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

function isWordChar(cp) {
  return /[\p{L}\p{N}]/u.test(cp);
}

/** Whole-word rule: chars before start and after end must not be word chars. */
function wholeWordAt(cps, start, end) {
  const before = start > 0 ? cps[start - 1] : "";
  const after = end < cps.length ? cps[end] : "";
  return !isWordChar(before) && !isWordChar(after);
}

/** Simple Unicode-aware reference matcher. */
function referenceMatches(keys, text) {
  const source = text.normalize("NFC");
  const cps = [...source];
  const out = [];
  for (const key of keys) {
    const needle = (key.caseSensitive ? key.text : key.textFolded);
    const needleCps = [...needle];
    if (!needleCps.length) continue;
    const haystack = key.caseSensitive ? cps : cps.map((c) => c.toLowerCase());
    for (let i = 0; i + needleCps.length <= haystack.length; i += 1) {
      let ok = true;
      for (let j = 0; j < needleCps.length; j += 1) {
        if (haystack[i + j] !== needleCps[j]) { ok = false; break; }
      }
      if (!ok) continue;
      const end = i + needleCps.length;
      if (key.wholeWord && !key.cjkExempt && !wholeWordAt(haystack, i, end)) continue;
      out.push({ entryId: key.entryId, kind: key.kind, end, position: i });
    }
  }
  return out;
}

async function runOne(seed) {
  const rnd = prng(seed);
  const words = ["harbor", "lamp", "dock", "bell", "灯", "港口", "船", "dawn", "tide", "码头"];
  const entries = [];
  for (let e = 0; e < 8; e += 1) {
    const primary = [pick(rnd, words)];
    const secondary = rnd() < 0.4 ? [pick(rnd, words)] : [];
    entries.push({
      id: `e${e}`,
      activation: {
        primaryKeys: primary,
        secondaryKeys: secondary,
        caseSensitive: rnd() < 0.2,
        wholeWord: rnd() < 0.8,
      },
    });
  }
  const corpus = [];
  for (let w = 0; w < 12; w += 1) {
    corpus.push(pick(rnd, words));
    if (rnd() < 0.3) corpus.push("!");
  }
  const text = corpus.join(rnd() < 0.3 ? " " : "");

  const index = matching.compileKeyIndex(entries, {});
  const unit = {
    matchTextCs: text,
    matchTextCi: text.normalize("NFC").toLowerCase(),
  };
  const indexed = [];
  matching.scanUnit(index, unit, (key, end) => {
    indexed.push({ entryId: key.entryId, kind: key.kind, end });
  });

  const keys = index.keys.map((k) => ({
    entryId: k.entryId, kind: k.kind, text: k.text || k.dedupeKey,
    textFolded: k.foldedText || k.dedupeKey,
    caseSensitive: k.caseSensitive, wholeWord: k.wholeWord, cjkExempt: k.cjkExempt,
  }));
  const reference = referenceMatches(keys, text).map((m) => ({ entryId: m.entryId, kind: m.kind, end: m.end }));

  const sig = (list) => list.map((m) => `${m.entryId}:${m.kind}:${m.end}`).sort().join("|");
  assert.equal(sig(indexed), sig(reference), `seed ${seed} match disagreement`);
}

try {
  await check("indexed matcher agrees with the Unicode-aware reference matcher over 40 generated corpora", async () => {
    for (let seed = 1; seed <= 40; seed += 1) await runOne(seed);
  });
  await check("matching is deterministic for the same seed", async () => {
    await runOne(7);
    await runOne(7);
  });
  console.log(`PASS: test-character-world-matching-reference (${checks} checks)`);
} catch (error) {
  console.error("FAIL:", error?.message || error);
  process.exitCode = 1;
}
