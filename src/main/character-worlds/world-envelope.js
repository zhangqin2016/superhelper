"use strict";

/**
 * World-entry envelope buckets (spec §10.3.1, Phase 2 Task WB-4).
 *
 * The compiler's world half: run the pure activation resolver over the
 * caller-prepared input, turn the insertion plan into indivisible packing
 * units tagged with their §10.3.1 assembly bucket, and re-serialize packed
 * blocks in positional order. Positions the runtime cannot represent exactly
 * (at_depth / outlet, and any unknown position) map to the documented
 * lower-authority tail bucket and report safe_behavior — never a silent
 * lossless-parity claim.
 */

const { resolveWorldBookActivation } = require("./world-book-activation");
const { mergeWorldBooks } = require("./world-book-merge");
const { normalizeWorldBookCanonical } = require("./world-book-model");

// `rank` is the assembly slot between the character blocks (§10.3.1:
// identity 0 / task_integrity 1 … persona 6 … imported_post_history_instructions 13).
const WORLD_POSITION_BUCKETS = Object.freeze({
  before_character: Object.freeze({ type: "world_entry_before_character", rank: 2, supported: true }),
  after_character: Object.freeze({ type: "world_entry_after_character", rank: 5, supported: true }),
  before_examples: Object.freeze({ type: "world_entry_before_examples", rank: 7, supported: true }),
  after_examples: Object.freeze({ type: "world_entry_after_examples", rank: 9, supported: true }),
  author_note_top: Object.freeze({ type: "world_author_note_top", rank: 11, supported: true }),
  author_note_bottom: Object.freeze({ type: "world_author_note_bottom", rank: 12, supported: true }),
  at_depth: Object.freeze({ type: "world_at_depth", rank: 14, supported: false }),
  outlet: Object.freeze({ type: "world_outlet", rank: 15, supported: false }),
});
const WORLD_BLOCK_RANKS = Object.freeze({
  identity: 0,
  task_integrity: 1,
  character_definitions: 3,
  scenario: 4,
  // §10.3.1 slot 6: persona narrative description (scene state is Phase 3).
  persona: 6,
  example_dialogue: 8,
  imported_system_prompt: 10,
  imported_post_history_instructions: 13,
});

function rankOfBlock(block) {
  const fixed = WORLD_BLOCK_RANKS[block.type];
  if (fixed !== undefined) return fixed;
  for (const bucket of Object.values(WORLD_POSITION_BUCKETS)) {
    if (bucket.type === block.type) return bucket.rank;
  }
  return 99;
}

// §10.1 contract reason enum. Internal resolver routes map onto it:
// delay_due is a due primary-key match; any activation reached through the
// recursion frontier reports "recursion" regardless of its incoming route.
// stateful (V3 @@keep_activate_after_match) reports "sticky": it is a
// checkpoint-carried re-activation without a fresh key match, and the §10.1
// enum has no dedicated value for it.
const ROUTE_TO_CONTRACT_REASON = Object.freeze({
  constant: "constant",
  primary_key: "primary_key",
  selective_match: "selective_match",
  semantic: "semantic",
  recursion: "recursion",
  sticky: "sticky",
  stateful: "sticky",
  delay_due: "primary_key",
});

function contractReason(entry) {
  if (Number.isSafeInteger(entry.recursionLevel) && entry.recursionLevel > 0) {
    return "recursion";
  }
  return ROUTE_TO_CONTRACT_REASON[entry.reason] || "primary_key";
}

/** §10.1 activatedWorldEntries rows, in envelope assembly order. */
function contractEntries(selectedWorldUnits) {
  return selectedWorldUnits
    .slice()
    .sort((a, b) => (a.rank - b.rank) || (a.planIndex - b.planIndex))
    .map((unit) => ({
      worldBookRevisionId: unit.revisionId,
      entryId: unit.entry.entryId,
      reason: unit.reason,
      recursionLevel: unit.entry.recursionLevel ?? 0,
      contentHash: unit.entry.contentHash,
    }));
}

/** §10.3.1 block fields for one activated world entry. */
function worldBlockFields(unit) {
  const fields = {
    entryId: unit.entry.entryId,
    content: unit.content,
    reason: unit.reason,
  };
  if (!unit.supported) {
    // Depth/outlet positions cannot be represented exactly in the dynamic
    // system suffix; the tail placement is labelled explicitly (§10.3.1).
    fields.placement = "envelope_tail";
    if (unit.type === "world_at_depth") {
      fields.role = unit.entry.role;
      fields.depth = unit.entry.depth;
      // @@reverse_depth (CCV3): depth counted from the oldest message; the
      // envelope cannot represent either depth direction exactly (§10.3.1),
      // so the flag rides along for the trace.
      if (unit.entry.reverseDepth === true) fields.reverseDepth = true;
    } else if (unit.type === "world_outlet") {
      fields.outletName = unit.entry.outletName;
    }
  }
  return fields;
}

/**
 * Run the resolver and build packing units. Any resolver error fails open:
 * world content is dropped with a metadata-only warning and the character
 * context still compiles (§16 "world resolver failure"). `redact` is the
 * compiler's blocked-directive redactor so one versioned pattern list covers
 * every low-authority imported field.
 */
function prepareWorldUnits({
  worldBook,
  compatibilityProfile,
  characterName,
  redact,
  warnings,
  diagnostic,
  omitted,
}) {
  const empty = { resolution: null, revisionId: null, units: [], safeBehaviors: [] };
  if (!worldBook) return empty;
  // §10.4.1 multi-book input merges chat/persona/character/global lore first
  // (source precedence, insertion order preserved); the merged entries become
  // constant lore. Single-book input is unchanged.
  const merged = mergeWorldBooks(worldBook.books, worldBook.mergeStrategy || "constant");
  const effectiveRevision = merged.length
    ? {
        ...(worldBook.revision || {}),
        id: worldBook.revision?.id || "merged-lore",
        canonical: normalizeWorldBookCanonical({
          schemaVersion: 1,
          name: "merged-lore",
          entries: merged.map((unit) => ({
            id: unit.entryId,
            content: unit.content,
            activation: { constant: true },
          })),
        }),
      }
    : worldBook.revision;
  // The contract requires activatedWorldEntries[].worldBookRevisionId and
  // every world block's sourceRevision to name the BOOK revision: a worldBook
  // input without a revision id fails open to character-only (§16) rather
  // than leaking the character revision id into world blocks.
  const revisionId = typeof worldBook.revision?.id === "string" && worldBook.revision.id
    ? worldBook.revision.id
    : null;
  if (!revisionId) {
    warnings.push({ code: "WORLD_BOOK_REVISION_INVALID", reason: "missing_revision_id" });
    diagnostic("world_book_revision_invalid");
    return empty;
  }
  let resolution = null;
  try {
    resolution = resolveWorldBookActivation({
      bookRevision: effectiveRevision,
      corpus: worldBook.corpus,
      checkpoint: worldBook.checkpoint ?? null,
      seedIdentity: worldBook.seedIdentity,
      compatibilityProfile: worldBook.compatibilityProfile ?? compatibilityProfile,
      // Known limitation (Phase 2A): no greetingIndex is plumbed into the
      // generation context, so a compiled @@is_greeting decorator is always
      // The active greeting index comes from the admitted binding (§8); when
      // it is unknown the @@is_greeting decorator is IGNORED (CCV3).
      generationContext: {
        characterName,
        kind: "normal",
        greetingIndex: Number.isSafeInteger(worldBook.greetingIndex) ? worldBook.greetingIndex : undefined,
      },
      budget: worldBook.budget,
      revisionHash: typeof worldBook.revision?.revisionHash === "string"
        && worldBook.revision.revisionHash
        ? worldBook.revision.revisionHash
        : undefined,
    });
  } catch (worldError) {
    warnings.push({
      code: "WORLD_BOOK_RESOLVER_FAILED",
      reason: typeof worldError?.code === "string" ? worldError.code : "error",
    });
    diagnostic("world_book_resolver_failed");
    return empty;
  }
  const safeBehaviors = [];
  const units = [];
  for (const [planIndex, entry] of resolution.activated.entries()) {
    const bucket = WORLD_POSITION_BUCKETS[entry.position] || null;
    const supported = bucket?.supported === true;
    const target = bucket || WORLD_POSITION_BUCKETS.at_depth;
    if (!supported) {
      safeBehaviors.push({
        entryId: entry.entryId,
        position: String(entry.position || "unknown"),
        mappedTo: "envelope_tail",
        behavior: "safe_behavior",
      });
    }
    const content = redact("world_entry", String(entry.content ?? "")).trim();
    if (!content) {
      resolution.omitted.push({ entryId: entry.entryId, reason: "empty" });
      continue;
    }
    units.push({
      entry,
      planIndex,
      type: target.type,
      supported,
      rank: target.rank,
      content,
      reason: contractReason(entry),
      revisionId,
    });
  }
  for (const entry of resolution.omitted) {
    omitted.push({ source: "world_entry", id: entry.entryId, reason: entry.reason });
  }
  return { resolution, revisionId, units, safeBehaviors };
}

/**
 * World packing candidates in §10.3 budget priority: constant entries before
 * triggered entries, each preserving the resolver's insertion-plan order.
 */
function worldCandidates(units, revisionId, expand = (content) => content) {
  const make = (unit) => {
    const expanded = { ...unit, content: expand(unit.content) };
    return {
      type: unit.type,
      compatibility: unit.supported ? "lossless_data" : "safe_behavior",
      parts: [["content", expanded.content]],
      worldUnit: expanded,
      revisionId,
    };
  };
  return [
    ...units.filter((unit) => unit.entry.reason === "constant").map(make),
    ...units.filter((unit) => unit.entry.reason !== "constant").map(make),
  ];
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Persona packing candidate (§10.3 priority 3, §10.3.1 slot 6; Phase 2B
 * P2B-2). The persona narrative description is lower-authority data exactly
 * like character narrative fields: the same blocked-directive redaction runs
 * (through the compiler's `redact`), the description segments at paragraph
 * boundaries under budget pressure, and the persona name rides the block as
 * an indivisible companion field — a persona name without its description is
 * a misleading fragment, so when the description cannot fit at all the whole
 * block disappears.
 *
 * Fail open (§16): no pin, a missing/corrupt/drifted revision, or text that
 * redacts to empty yields NO candidate plus a metadata-only warning and
 * diagnostic — never a fatal compile. `persona` is pre-resolved by the
 * caller from the admitted snapshot's pinned personaRevisionId (never the
 * current entity state); a revision whose id differs from the pin is refused.
 */
function preparePersonaCandidate({
  persona,
  snapshot,
  redact,
  boundField,
  warnings,
  diagnostic,
}) {
  const personaRevisionId = typeof snapshot?.personaRevisionId === "string"
    && snapshot.personaRevisionId
    ? snapshot.personaRevisionId
    : "";
  if (!personaRevisionId) return null;
  const missing = (reason) => {
    warnings.push({ code: "PERSONA_REVISION_MISSING", reason });
    diagnostic("persona_revision_missing");
    return null;
  };
  const revision = persona && typeof persona === "object" && !Array.isArray(persona)
    ? persona.revision
    : null;
  const canonical = revision?.canonical
    && typeof revision.canonical === "object"
    && !Array.isArray(revision.canonical)
    ? revision.canonical
    : null;
  if (!canonical || revision.id !== personaRevisionId) return missing("missing_or_unusable");
  const name = redact("personaName", cleanText(canonical.name));
  const bounded = typeof boundField === "function"
    ? boundField(cleanText(canonical.description))
    : cleanText(canonical.description);
  const description = redact("personaDescription", bounded).trim();
  if (!description) return missing("empty_after_redaction");
  return {
    type: "persona",
    compatibility: "lily_native",
    omittedSource: "persona_field",
    extraFields: { authority: "lower_authority_narrative", personaName: name },
    parts: [["personaDescription", description]],
    revisionId: personaRevisionId,
  };
}

/**
 * §10.3.1 assembly: budget packing ran in PRIORITY order; the envelope
 * serializes blocks in POSITIONAL order (world blocks within a bucket keep
 * the resolver's insertion-plan order). Token estimates are
 * order-independent over the same block set, so the packed fit holds.
 */
function assembleInPositionalOrder(envelope, worldBlockPlanIndex) {
  envelope.blocks = envelope.blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => (rankOfBlock(a.block) - rankOfBlock(b.block))
      || ((worldBlockPlanIndex.get(a.block) ?? -1) - (worldBlockPlanIndex.get(b.block) ?? -1))
      || (a.index - b.index))
    .map((entry) => entry.block);
}

module.exports = {
  WORLD_POSITION_BUCKETS,
  assembleInPositionalOrder,
  contractEntries,
  contractReason,
  preparePersonaCandidate,
  prepareWorldUnits,
  worldBlockFields,
  worldCandidates,
};
