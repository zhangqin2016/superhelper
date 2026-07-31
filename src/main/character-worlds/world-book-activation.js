"use strict";

/**
 * Deterministic world-book activation resolver (§10.4) — a pure function of
 * the admitted immutable snapshot:
 *   resolveWorldBookActivation({
 *     bookRevision,        // normalized §7.4 canonical (or {canonical})
 *     corpus,              // buildScanCorpus output
 *     checkpoint,          // previous timed-effect checkpoint or null
 *     seedIdentity,        // {ownerScope, sessionId, turnId}
 *     compatibilityProfile,
 *     generationContext,   // {characterName, characterTags, kind} (optional)
 *     budget,              // caller limits; may only tighten the hard caps
 *     revisionHash,        // optional pin; otherwise hashed from canonical
 *   })
 *   -> {activated, omitted, nextCheckpoint, trace, complexity}
 *
 * Determinism: no Date.now / Math.random / host locale. All randomness comes
 * from the SHA-256 counter PRNG (macro-prng.js) seeded by
 * sha256(ownerScope|sessionId|turnId|revisionHash|phase) with U+001F field
 * separators — separator bytes in any seed-identity field or entry id are
 * rejected with a coded error so two distinct identities can never collide.
 * Identical inputs produce byte-identical output across processes.
 *
 * Pipeline (§10.4.2-§10.4.6): enabled entries (useRegex inert fail-closed,
 * vectorized lexical-only fallback, @@dont_activate suppression, all
 * reported) → frontier evaluation
 * (world-book-frontier.js: key/constant/@@activate/sticky/stateful/delay-due
 * candidates from the compiled Aho-Corasick index, selective secondary
 * logic, per-entry @@scan_depth windows) → generation/character/decorator
 * filters BEFORE probability (§10.4.7 decorator gates:
 * @@activate_only_after / @@is_greeting / @@dont_activate_after_match),
 * timed gates by canonical sequence numbers, deterministic probability → inclusion groups (world-book-groups.js)
 * → bounded recursion fixed point OR min-activation sweeps (mutually
 * exclusive policies; profile v1 picks min mode when minActivations > 0) →
 * budget selection (world-book-insertion.js) → next timed checkpoint
 * (world-book-timed.js; transiently-blocked due delays are re-pended).
 *
 * Matching semantics are pinned in world-book-matching.js (matching policy
 * version). The trace records candidate metadata and the card-declared
 * matched KEY STRINGS (bounded per candidate) — never private corpus text.
 */

const crypto = require("node:crypto");
const { createCounterPrng } = require("./macro-prng");
const { codedError } = require("./persistence-codec");
const {
  WORLD_BOOK_MATCHING_POLICY_VERSION,
  DEFAULT_COMPATIBILITY_PROFILE,
} = require("./constants");
const {
  compileKeyIndex,
  hashRevision,
  resolveActivationLimits,
  matchingCopy,
} = require("./world-book-matching");
const { sanitizeCheckpoint, computeNextCheckpoint } = require("./world-book-timed");
const { selectWithinBudget, toInsertionPlan } = require("./world-book-insertion");
const { createFrontierEvaluator } = require("./world-book-frontier");

const PROFILES = {
  [DEFAULT_COMPATIBILITY_PROFILE]: {
    stickySkipsProbability: true,
    minActivationExcludesRecursion: true,
  },
};

const UINT32_RANGE = 0x1_0000_0000;
const SEED_SEPARATOR = "\u001f";
const MAX_TRACE_MATCHED_KEYS = 16;
// Delay-due entries blocked for these TRANSIENT reasons are re-pended with
// their original matchedSeq (world-book-timed.js pins the semantics).
const DELAY_REPEND_REASONS = new Set([
  "probability", "group_conflict", "budget_entries", "budget_tokens",
]);

function invalid(message, details = {}) {
  return codedError("WORLD_BOOK_ACTIVATION_INPUT", message, details);
}

function resolveProfile(name) {
  const profileName = typeof name === "string" && PROFILES[name]
    ? name
    : DEFAULT_COMPATIBILITY_PROFILE;
  return { name: profileName, flags: PROFILES[profileName] };
}

function resolveWorldBookActivation(input) {
  if (!input || typeof input !== "object") throw invalid("Activation input must be an object");
  const canonical = input.bookRevision && typeof input.bookRevision === "object"
    ? (input.bookRevision.canonical ?? input.bookRevision)
    : null;
  if (!canonical || !Array.isArray(canonical.entries)) {
    throw invalid("bookRevision must be a normalized world-book canonical");
  }
  const corpus = input.corpus;
  if (!corpus || !Array.isArray(corpus.units) || !corpus.stats) {
    throw invalid("corpus must be a buildScanCorpus result");
  }
  const seed = input.seedIdentity;
  if (!seed || [seed.ownerScope, seed.sessionId, seed.turnId].some((v) => typeof v !== "string" || !v)) {
    throw invalid("seedIdentity requires ownerScope, sessionId, and turnId strings");
  }
  if ([seed.ownerScope, seed.sessionId, seed.turnId].some((v) => v.includes(SEED_SEPARATOR))
      || (typeof input.revisionHash === "string" && input.revisionHash.includes(SEED_SEPARATOR))) {
    throw invalid("seed identity fields must not contain the U+001F separator");
  }

  const limits = resolveActivationLimits(input.budget);
  const profile = resolveProfile(input.compatibilityProfile);
  const revisionHash = typeof input.revisionHash === "string" && input.revisionHash
    ? input.revisionHash : hashRevision(canonical);
  const sequenceNow = Number.isSafeInteger(corpus.stats.sequenceNow) ? corpus.stats.sequenceNow : 0;
  const generationContext = input.generationContext && typeof input.generationContext === "object"
    ? input.generationContext : null;
  const scanPolicy = canonical.scanPolicy && typeof canonical.scanPolicy === "object"
    ? canonical.scanPolicy : {};
  const { checkpoint, dropped: checkpointDropped } = sanitizeCheckpoint(
    input.checkpoint, limits.maxTimedEntries,
  );

  const counters = {
    keyBytes: 0, automatonStates: 0, unitsScanned: 0, scanChars: 0, matchEvents: 0,
    candidatesEvaluated: 0, probabilityDraws: 0, groupRounds: 0,
    recursionFrontiers: 0, sweeps: 0, operations: 0,
  };
  function budget(amount = 1) {
    counters.operations += amount;
    if (counters.operations <= limits.maxOperations) return;
    throw codedError(
      "WORLD_BOOK_ACTIVATION_BUDGET_EXCEEDED",
      "World book activation operation budget was exhausted",
      { limit: "maxOperations", maximum: limits.maxOperations },
    );
  }

  const seedMaterial = (phase) => crypto.createHash("sha256")
    .update([seed.ownerScope, seed.sessionId, seed.turnId, revisionHash, phase].join(SEED_SEPARATOR), "utf8")
    .digest("hex");
  const prngFor = (phase) => createCounterPrng(seedMaterial(phase), 0);

  const omitted = [];
  const omittedReasonById = new Map();
  let omittedOverflow = 0;
  function omit(entryId, reason) {
    if (omittedReasonById.has(entryId)) return;
    omittedReasonById.set(entryId, reason);
    if (omitted.length < limits.maxOmitted) omitted.push({ entryId, reason });
    else omittedOverflow += 1;
  }

  const traceCandidates = [];
  let traceCandidateOverflow = 0;
  function traceCandidate(candidate) {
    if (traceCandidates.length >= limits.maxTraceCandidates) {
      traceCandidateOverflow += 1;
      return;
    }
    const record = {
      entryId: candidate.entry.id, route: candidate.route, sourceScope: candidate.sourceScope,
      matchedKeyCount: candidate.matchedKeyCount, recursionLevel: candidate.recursionLevel,
    };
    // Card-declared matched keys (never private corpus text), bounded.
    if (candidate.matchedKeys) record.matchedKeys = candidate.matchedKeys;
    if (candidate.matchedKeysTruncated) record.matchedKeysTruncated = candidate.matchedKeysTruncated;
    if (candidate.matchedSecondaryKeys) record.matchedSecondaryKeys = candidate.matchedSecondaryKeys;
    traceCandidates.push(record);
  }

  // ---------------------------------------------------------- entry prep --
  const entries = canonical.entries.filter((entry) => entry && typeof entry === "object");
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const enabled = entries.filter((entry) => entry.enabled !== false);
  for (const entry of enabled) {
    if (typeof entry.id === "string" && entry.id.includes(SEED_SEPARATOR)) {
      throw invalid("World book entry ids must not contain the U+001F separator");
    }
  }
  const inertRegex = [];
  const fallbackVectorized = [];
  const matchable = [];
  for (const entry of enabled) {
    if (entry.activation?.useRegex === true) {
      inertRegex.push(entry.id);
      omit(entry.id, "regex_inert");
      continue;
    }
    // @@dont_activate (CCV3): the entry is never a match, even constant/sticky.
    if (entry.activation?.forceState === "suppress") {
      omit(entry.id, "decorator_suppressed");
      continue;
    }
    if (entry.activation?.vectorized === true) fallbackVectorized.push(entry.id);
    matchable.push(entry);
  }
  const index = compileKeyIndex(matchable, limits);
  counters.keyBytes = index.keyBytes;
  counters.automatonStates = index.automatonStates;
  budget(enabled.length);

  // Vectorized entries with no lexical route are reported as semantic-only.
  const stickyById = new Map(checkpoint.sticky.map((item) => [item.entryId, item]));
  const cooldownById = new Map(checkpoint.cooldown.map((item) => [item.entryId, item]));
  const delayById = new Map(checkpoint.delay.map((item) => [item.entryId, item]));
  // V3 stateful match (§10.4.7): entries that activated on an earlier turn.
  const statefulMatched = new Set((checkpoint.matched ?? []).map((item) => item.entryId));
  for (const entry of matchable) {
    if (entry.activation.vectorized !== true) continue;
    if (entry.activation.constant || entry.activation.primaryKeys.length > 0) continue;
    const sticky = stickyById.get(entry.id);
    if (sticky && sticky.untilSeq >= sequenceNow) continue;
    if (delayById.has(entry.id)) continue;
    omit(entry.id, "vectorized_semantic_unavailable");
  }

  // -------------------------------------------------------- selection ----
  const selected = new Map();
  const blockedGroups = new Map();
  const pendingDelay = new Map();
  const traceGroups = [];

  function keepDelay(entryId, matchedSeq) {
    if (!pendingDelay.has(entryId)) pendingDelay.set(entryId, matchedSeq);
  }

  function passesFilters(entry) {
    const filter = entry.activation.characterFilter ?? {};
    const names = filter.characterNames ?? [];
    const tags = filter.characterTags ?? [];
    if (names.length > 0 || tags.length > 0) {
      const nameHit = generationContext != null && names.includes(generationContext.characterName);
      const tagHit = generationContext != null
        && Array.isArray(generationContext.characterTags)
        && generationContext.characterTags.some((tag) => tags.includes(tag));
      const hit = nameHit || tagHit;
      if ((filter.mode === "exclude" && hit) || (filter.mode !== "exclude" && !hit)) {
        omit(entry.id, "character_filter");
        return false;
      }
    }
    const triggers = entry.activation.generationTriggers ?? [];
    if (triggers.length > 0
        && !(generationContext && triggers.includes(generationContext.kind))) {
      omit(entry.id, "generation_filter");
      return false;
    }
    return true;
  }

  function passesTimed(entry, route) {
    const cooldown = cooldownById.get(entry.id);
    if (cooldown && cooldown.untilSeq >= sequenceNow) {
      omit(entry.id, "cooldown_active");
      return false;
    }
    if (route === "sticky" || route === "stateful") return true;
    const delayMessages = entry.activation.delayMessages ?? 0;
    if (delayMessages <= 0) return true;
    const pending = delayById.get(entry.id);
    if (pending) {
      if (sequenceNow - pending.matchedSeq >= delayMessages) return true;
      keepDelay(entry.id, pending.matchedSeq);
      omit(entry.id, "delay_pending");
      return false;
    }
    keepDelay(entry.id, sequenceNow);
    omit(entry.id, "delay_pending");
    return false;
  }

  function passesProbability(entry, route, level) {
    if ((route === "sticky" || route === "stateful") && profile.flags.stickySkipsProbability) {
      return true;
    }
    const probability = entry.activation.probability ?? 100;
    if (probability <= 0) {
      omit(entry.id, "probability");
      return false;
    }
    if (probability >= 100) return true;
    counters.probabilityDraws += 1;
    const draw = prngFor(`p:${entry.id}:${level}`).nextUInt32();
    if (draw < Math.floor((probability * UINT32_RANGE) / 100)) return true;
    omit(entry.id, "probability");
    return false;
  }

  // V3 decorator gates (§10.4.7), evaluated before timed/probability:
  // - @@activate_only_after N: no match until the TOTAL canonical message
  //   sequence (corpus.stats.sequenceNow) reaches N — a documented
  //   deterministic proxy for CCV3's "user input received Nth time" rule
  //   (Lily does not attempt assistant-message counting);
  // - @@is_greeting N: no match when the binding's active greeting index is
  //   known and differs; when the context cannot determine the greeting the
  //   decorator is ignored (CCV3), never fail-closed;
  // - @@dont_activate_after_match: no match once the entry activated before.
  function passesDecorators(entry) {
    const activation = entry.activation ?? {};
    if ((activation.activateOnlyAfter ?? 0) > 0 && sequenceNow < activation.activateOnlyAfter) {
      omit(entry.id, "decorator_activate_only_after");
      return false;
    }
    const greetingIndex = activation.greetingIndex;
    if (greetingIndex !== null && greetingIndex !== undefined
        && Number.isSafeInteger(generationContext?.greetingIndex)
        && generationContext.greetingIndex !== greetingIndex) {
      omit(entry.id, "decorator_greeting_mismatch");
      return false;
    }
    if (activation.statefulMatch === "suppress" && statefulMatched.has(entry.id)) {
      omit(entry.id, "stateful_suppressed");
      return false;
    }
    return true;
  }

  function makeCandidate(entry, route, sourceScope, matchedKeyCount, level, matched = null) {
    budget();
    counters.candidatesEvaluated += 1;
    if (selected.has(entry.id)) return null;
    if (!passesFilters(entry)) return null;
    if (!passesDecorators(entry)) return null;
    if (!passesTimed(entry, route)) return null;
    if (!passesProbability(entry, route, level)) return null;
    const sticky = stickyById.get(entry.id);
    const candidate = {
      entry,
      route,
      sourceScope,
      matchedKeyCount,
      recursionLevel: level,
      carriedStickyUntilSeq: route === "sticky" && sticky ? sticky.untilSeq : null,
    };
    if (matched) {
      candidate.matchedKeys = matched.primary.slice(0, MAX_TRACE_MATCHED_KEYS);
      candidate.matchedKeysTruncated = Math.max(0, matched.primary.length - MAX_TRACE_MATCHED_KEYS);
      if (matched.secondary) {
        candidate.matchedSecondaryKeys = matched.secondary.slice(0, MAX_TRACE_MATCHED_KEYS);
      }
    }
    traceCandidate(candidate);
    return candidate;
  }

  // Per-entry @@scan_depth (§10.4.7) anchors at the ABSOLUTE chat head: this
  // maps each admitted corpus message unit to the number of canonical message
  // units NEWER than it. Min-activation sweeps scan progressively older
  // slices of the same corpus, so anchoring per sweep window would let
  // @@scan_depth 1 match arbitrarily old messages; the book-level scan depth
  // keeps the sweep semantics, the per-entry override never re-anchors.
  const absoluteNewerByUnit = new Map();
  const corpusMessageUnits = corpus.units.filter((unit) => unit.kind === "message");
  corpusMessageUnits.forEach((unit, index) => {
    absoluteNewerByUnit.set(unit, corpusMessageUnits.length - 1 - index);
  });

  const { evaluateFrontier } = createFrontierEvaluator({
    index, entryById, matchable, checkpoint, selected, blockedGroups,
    keepDelay, omit, makeCandidate, traceGroups, counters, budget, prngFor,
    limits, sequenceNow, absoluteNewerByUnit,
  });

  // ------------------------------------------------------------ pipeline --
  const primaryUnits = corpus.units.slice(corpus.primaryMessageStart ?? 0);
  let winners = evaluateFrontier(primaryUnits, 0, "chat");

  const minActivations = Number.isSafeInteger(scanPolicy.minActivations)
    ? scanPolicy.minActivations
    : 0;
  const recursionEnabled = scanPolicy.recursive !== false;
  const maxRecursionSteps = Number.isSafeInteger(scanPolicy.maxRecursionSteps)
    ? scanPolicy.maxRecursionSteps
    : 0;
  const minMode = minActivations > 0 && profile.flags.minActivationExcludesRecursion;

  if (minMode) {
    const extended = corpus.units.slice(0, corpus.primaryMessageStart ?? 0);
    const scanDepth = Math.max(1, Number.isSafeInteger(scanPolicy.scanDepthMessages)
      ? scanPolicy.scanDepthMessages
      : 8);
    let sweep = 0;
    while (selected.size < minActivations && sweep * scanDepth < extended.length) {
      sweep += 1;
      counters.sweeps += 1;
      const end = extended.length - (sweep - 1) * scanDepth;
      const start = Math.max(0, end - scanDepth);
      evaluateFrontier(extended.slice(start, end), 0, "chat");
    }
  } else if (recursionEnabled && maxRecursionSteps > 0) {
    let level = 0;
    while (winners.length > 0 && level < maxRecursionSteps && selected.size < limits.maxEntries) {
      level += 1;
      const units = [];
      let chars = 0;
      for (const candidate of winners) {
        if (candidate.entry.recursion?.preventFurtherRecursion === true) continue;
        const content = candidate.entry.content ?? "";
        chars += [...content].length;
        if (chars > limits.maxCorpusChars) break;
        units.push({
          kind: "recursion",
          scope: "recursion",
          seq: null,
          insertable: false,
          extended: false,
          text: content,
          matchTextCs: matchingCopy(content, true),
          matchTextCi: matchingCopy(content, false),
        });
      }
      if (units.length === 0) break;
      winners = evaluateFrontier(units, level, "recursion");
      if (winners.length > 0) counters.recursionFrontiers += 1;
    }
  }

  // ------------------------------------------------------------- budget ---
  const policyTokenBudget = Number.isSafeInteger(scanPolicy.tokenBudget) && scanPolicy.tokenBudget > 0
    ? scanPolicy.tokenBudget : Number.POSITIVE_INFINITY;
  const chosen = selectWithinBudget([...selected.values()], {
    maxEntries: limits.maxEntries,
    tokenBudget: Math.min(policyTokenBudget, limits.maxTokens),
    omit,
  });
  const chosenIds = new Set(chosen.map((selection) => selection.entry.id));

  // Due delays blocked transiently this turn are re-pended (see timed docs).
  for (const [entryId, reason] of omittedReasonById) {
    if (!DELAY_REPEND_REASONS.has(reason) || chosenIds.has(entryId)) continue;
    const pending = delayById.get(entryId);
    if (pending) keepDelay(entryId, pending.matchedSeq);
  }

  // ------------------------------------------------- insertion plan -------
  const activated = toInsertionPlan(chosen);

  const nextCheckpoint = computeNextCheckpoint({
    previous: checkpoint,
    selected: chosen.map((selection) => ({
      entryId: selection.entry.id,
      stickyMessages: selection.entry.activation.stickyMessages ?? 0,
      cooldownMessages: selection.entry.activation.cooldownMessages ?? 0,
      carriedStickyUntilSeq: selection.carriedStickyUntilSeq,
      statefulMatch: selection.entry.activation.statefulMatch ?? "none",
    })),
    pendingDelay: [...pendingDelay.entries()]
      .filter(([entryId]) => !chosenIds.has(entryId))
      .map(([entryId, matchedSeq]) => ({ entryId, matchedSeq })),
    sequenceNow,
    maxTimedEntries: limits.maxTimedEntries,
  });

  // Compiled V3 decorator decisions recorded in the admitted revision
  // (§10.4.7), counted over EVERY entry in the revision — including disabled
  // and @@dont_activate-suppressed entries that never engaged this turn:
  // applied = directives that changed entry behavior, inert = decorator lines
  // that did not (unknown, invalid, shadowed, superseded, duplicate).
  const decoratorCounts = { applied: 0, inert: 0 };
  for (const entry of entries) {
    for (const node of entry.decorators?.directives ?? []) {
      decoratorCounts[node?.applied === true ? "applied" : "inert"] += 1;
    }
  }

  const trace = {
    matchingPolicyVersion: WORLD_BOOK_MATCHING_POLICY_VERSION,
    unicodeVersion: process.versions.unicode ?? "unknown",
    revisionHash,
    seedIdentity: {
      ownerScope: seed.ownerScope, sessionId: seed.sessionId, turnId: seed.turnId,
    },
    compatibilityProfile: profile.name,
    mode: minMode ? "min_activation" : "recursion",
    // Measured AFTER budget selection: what actually got inserted.
    minActivationsUnmet: minMode && chosen.length < minActivations,
    decorators: decoratorCounts,
    candidates: traceCandidates,
    groups: traceGroups,
    inert: { regex: inertRegex, vectorized: fallbackVectorized },
    truncated: {
      candidates: traceCandidateOverflow,
      omitted: omittedOverflow,
      checkpoint: checkpointDropped,
    },
  };

  return { activated, omitted, nextCheckpoint, trace, complexity: counters };
}

module.exports = {
  resolveWorldBookActivation,
};
