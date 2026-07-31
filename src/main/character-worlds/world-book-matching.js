"use strict";

/**
 * World-book activation matching primitives (§10.4.1).
 *
 * Matching policy `lily-world-book-match-1` (WORLD_BOOK_MATCHING_POLICY_VERSION,
 * pinned in constants.js — bump it to change ANY of these semantics):
 *
 * - Matching copy: Unicode NFC, then locale-independent Unicode default case
 *   mapping (String.prototype.toLowerCase) when the entry is not
 *   caseSensitive. This is NOT full case folding (e.g. "ß" does not become
 *   "ss"); the deviation is deliberate, deterministic, and recorded here.
 *   The host OS locale is never consulted.
 * - Whole-word segmentation: a built-in rule — a match is whole-word when the
 *   code points immediately before and after it are outside
 *   [\p{L}\p{M}\p{N}\p{Pc}] (letters, marks, numbers, connector punctuation).
 *   Keys containing Han/Hiragana/Katakana/Hangul code points are exempt and
 *   match as plain substrings, because CJK text has no word spacing.
 * - Multi-pattern plain-key index: an Aho-Corasick automaton over code
 *   points, one per case class (sensitive / folded). Build is O(K) in total
 *   key code points; scanning one corpus unit is O(C + matches) where C is
 *   the unit length. There is no entries x keys x corpus nested loop.
 *
 * Everything here is pure and deterministic: no Date.now, no Math.random, no
 * host locale.
 */

const crypto = require("node:crypto");
const C = require("./constants");
const { stableJson, codedError } = require("./persistence-codec");

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR_PATTERN = /[\p{L}\p{M}\p{N}\p{Pc}]/u;

function budgetExceeded(limit, maximum, actual) {
  return codedError(
    "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED",
    "World book activation index budget was exhausted",
    { limit, maximum, actual },
  );
}

function matchingCopy(text, caseSensitive) {
  const nfc = text.normalize("NFC");
  return caseSensitive ? nfc : nfc.toLowerCase();
}

function containsCjk(text) {
  return CJK_PATTERN.test(text);
}

// A match spanning cps[start, end) is whole-word when both neighbors (if any)
// are non-word code points under the pinned segmentation rule.
function isWholeWordMatch(cps, start, end) {
  if (start > 0 && WORD_CHAR_PATTERN.test(cps[start - 1])) return false;
  if (end < cps.length && WORD_CHAR_PATTERN.test(cps[end])) return false;
  return true;
}

function buildAutomaton(patterns, maxStates) {
  const transitions = [new Map()];
  const outputs = [[]];
  for (const { id, cps } of patterns) {
    let state = 0;
    for (const cp of cps) {
      let next = transitions[state].get(cp);
      if (next === undefined) {
        next = transitions.length;
        if (next > maxStates) throw budgetExceeded("maxAutomatonStates", maxStates, next);
        transitions.push(new Map());
        outputs.push([]);
        transitions[state].set(cp, next);
      }
      state = next;
    }
    outputs[state].push(id);
  }
  const failure = new Array(transitions.length).fill(0);
  const queue = [];
  for (const [, next] of transitions[0]) queue.push(next);
  for (let head = 0; head < queue.length; head += 1) {
    const state = queue[head];
    for (const [cp, next] of transitions[state]) {
      queue.push(next);
      let fallback = failure[state];
      while (fallback !== 0 && !transitions[fallback].has(cp)) fallback = failure[fallback];
      failure[next] = transitions[fallback].get(cp) ?? 0;
      if (failure[next] === next) failure[next] = 0;
      if (outputs[failure[next]].length > 0) {
        outputs[next] = outputs[next].concat(outputs[failure[next]]);
      }
    }
  }
  return { transitions, failure, outputs, stateCount: transitions.length };
}

// Emits onMatch(keyId, endExclusive) with code-point indices into cps, in
// scanning order (deterministic: automaton construction order is stable).
function scanAutomaton(automaton, cps, onMatch) {
  let state = 0;
  for (let index = 0; index < cps.length; index += 1) {
    const cp = cps[index];
    while (state !== 0 && !automaton.transitions[state].has(cp)) {
      state = automaton.failure[state];
    }
    state = automaton.transitions[state].get(cp) ?? 0;
    const out = automaton.outputs[state];
    for (let hit = 0; hit < out.length; hit += 1) onMatch(out[hit], index + 1);
  }
}

/**
 * Compile the plain-key index for one immutable book revision. Callers cache
 * it by revision hash. Both primary and secondary keys are indexed; per-entry
 * duplicate key strings are deduplicated so matchedKeyCount counts distinct
 * key strings. Key meta records the whole-word/CJK-exemption posture so the
 * resolver can filter match events without re-reading entry data. `limits`
 * (maxKeyBytes / maxAutomatonStates) trip a coded budget error mid-build,
 * before an adversarial book materializes an oversized automaton.
 */
function compileKeyIndex(entries, limits = {}) {
  const maxKeyBytes = Number.isSafeInteger(limits.maxKeyBytes)
    ? limits.maxKeyBytes
    : C.DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxKeyBytes;
  const maxStates = Number.isSafeInteger(limits.maxAutomatonStates)
    ? limits.maxAutomatonStates
    : C.DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS.maxAutomatonStates;
  const keys = [];
  const sensitivePatterns = [];
  const foldedPatterns = [];
  let keyBytes = 0;
  for (const entry of entries) {
    const caseSensitive = entry.activation.caseSensitive === true;
    const seen = new Set();
    for (const kind of ["primary", "secondary"]) {
      const rawKeys = kind === "primary"
        ? entry.activation.primaryKeys
        : entry.activation.secondaryKeys;
      for (const raw of rawKeys) {
        const text = matchingCopy(raw, caseSensitive);
        if (!text || seen.has(`${kind}${text}`)) continue;
        seen.add(`${kind}${text}`);
        const cps = [...text];
        const id = keys.length;
        keys.push({
          entryId: entry.id,
          kind,
          dedupeKey: text,
          length: cps.length,
          wholeWord: entry.activation.matchWholeWords === true,
          cjkExempt: containsCjk(text),
        });
        keyBytes += Buffer.byteLength(text, "utf8");
        if (keyBytes > maxKeyBytes) throw budgetExceeded("maxKeyBytes", maxKeyBytes, keyBytes);
        (caseSensitive ? sensitivePatterns : foldedPatterns).push({ id, cps });
      }
    }
  }
  const sensitive = buildAutomaton(sensitivePatterns, maxStates);
  const folded = buildAutomaton(foldedPatterns, maxStates - sensitive.stateCount);
  return {
    keys,
    sensitive,
    folded,
    keyBytes,
    automatonStates: sensitive.stateCount + folded.stateCount,
  };
}

// Scan one corpus unit's matching copies against both automatons. Returns
// match events filtered by the pinned whole-word rule. Eligibility (which
// entries may match which unit scope) is the resolver's concern.
function scanUnit(index, unit, onMatch) {
  const sensitiveCps = [...unit.matchTextCs];
  scanAutomaton(index.sensitive, sensitiveCps, (keyId, end) => {
    const key = index.keys[keyId];
    if (key.wholeWord && !key.cjkExempt
        && !isWholeWordMatch(sensitiveCps, end - key.length, end)) {
      return;
    }
    onMatch(key, end);
  });
  const foldedCps = [...unit.matchTextCi];
  scanAutomaton(index.folded, foldedCps, (keyId, end) => {
    const key = index.keys[keyId];
    if (key.wholeWord && !key.cjkExempt
        && !isWholeWordMatch(foldedCps, end - key.length, end)) {
      return;
    }
    onMatch(key, end);
  });
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function hashContent(content) {
  return `sha256:${sha256Hex(content)}`;
}

// Revision identity for seeding and trace when the caller does not pin the
// persisted revision hash: canonical data only, never provenance.
function hashRevision(canonical) {
  return `sha256:${sha256Hex(stableJson(canonical))}`;
}

// Caller budgets may only tighten the hard activation limits, mirroring
// resolveMacroLimits: absent/invalid values fall back to the hard default.
function resolveActivationLimits(overrides) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  const resolved = {};
  for (const [key, hardLimit] of Object.entries(C.DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS)) {
    if (key === "version") {
      resolved[key] = hardLimit;
      continue;
    }
    const candidate = Object.getOwnPropertyDescriptor(source, key);
    resolved[key] = candidate
      && "value" in candidate
      && Number.isSafeInteger(candidate.value)
      && candidate.value >= 1
      ? Math.min(hardLimit, candidate.value)
      : hardLimit;
  }
  return Object.freeze(resolved);
}

module.exports = {
  matchingCopy,
  containsCjk,
  compileKeyIndex,
  scanUnit,
  hashContent,
  hashRevision,
  resolveActivationLimits,
};
