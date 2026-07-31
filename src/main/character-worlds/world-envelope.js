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

// `rank` is the assembly slot between the Phase-1 character blocks
// (identity 0 / task_integrity 1 … imported_post_history_instructions 12).
const WORLD_POSITION_BUCKETS = Object.freeze({
  before_character: Object.freeze({ type: "world_entry_before_character", rank: 2, supported: true }),
  after_character: Object.freeze({ type: "world_entry_after_character", rank: 5, supported: true }),
  before_examples: Object.freeze({ type: "world_entry_before_examples", rank: 6, supported: true }),
  after_examples: Object.freeze({ type: "world_entry_after_examples", rank: 8, supported: true }),
  author_note_top: Object.freeze({ type: "world_author_note_top", rank: 10, supported: true }),
  author_note_bottom: Object.freeze({ type: "world_author_note_bottom", rank: 11, supported: true }),
  at_depth: Object.freeze({ type: "world_at_depth", rank: 13, supported: false }),
  outlet: Object.freeze({ type: "world_outlet", rank: 14, supported: false }),
});
const WORLD_BLOCK_RANKS = Object.freeze({
  identity: 0,
  task_integrity: 1,
  character_definitions: 3,
  scenario: 4,
  example_dialogue: 7,
  imported_system_prompt: 9,
  imported_post_history_instructions: 12,
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
const ROUTE_TO_CONTRACT_REASON = Object.freeze({
  constant: "constant",
  primary_key: "primary_key",
  selective_match: "selective_match",
  semantic: "semantic",
  recursion: "recursion",
  sticky: "sticky",
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
      bookRevision: worldBook.revision,
      corpus: worldBook.corpus,
      checkpoint: worldBook.checkpoint ?? null,
      seedIdentity: worldBook.seedIdentity,
      compatibilityProfile: worldBook.compatibilityProfile ?? compatibilityProfile,
      generationContext: { characterName, kind: "normal" },
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
function worldCandidates(units, revisionId) {
  const make = (unit) => ({
    type: unit.type,
    compatibility: unit.supported ? "lossless_data" : "safe_behavior",
    parts: [["content", unit.content]],
    worldUnit: unit,
    revisionId,
  });
  return [
    ...units.filter((unit) => unit.entry.reason === "constant").map(make),
    ...units.filter((unit) => unit.entry.reason !== "constant").map(make),
  ];
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
  prepareWorldUnits,
  worldBlockFields,
  worldCandidates,
};
