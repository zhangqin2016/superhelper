"use strict";

const CHARACTER_SCHEMA_VERSION = 1;
const CHARACTER_BINDING_SCHEMA_VERSION = 1;
const CHARACTER_COMPATIBILITY_PROFILE_VERSION = 1;
const CHARACTER_COMPATIBILITY_PROFILE = "lily-character-worlds-v1";
const CHARACTER_ASSET_LIMITS_VERSION = 1;
const CHARACTER_CARD_PARSER_LIMITS_VERSION = 4;
const CHARACTER_MACRO_LIMITS_VERSION = 1;
// World-book activation (§10.4) matching policy. Version-pinned because any
// change to normalization, case folding, segmentation, or CJK exemption must
// invalidate cached indexes explicitly and make cross-platform fixtures fail
// loud rather than drift. v1 semantics:
//   - matching copy: Unicode NFC (String.prototype.normalize("NFC"));
//   - case folding: Unicode default case mapping via locale-independent
//     String.prototype.toLowerCase() (NOT full case folding: e.g. "ß" is not
//     folded to "ss"); never the host OS locale;
//   - whole-word segmentation: a built-in deterministic rule — a match is
//     whole-word when the code points immediately before/after it are outside
//     [\p{L}\p{M}\p{N}\p{Pc}]; keys containing Han/Hiragana/Katakana/Hangul
//     code points are exempt (substring match) because CJK text has no word
//     spacing;
//   - multi-pattern index: Aho-Corasick over code points (see
//     world-book-matching.js), one automaton per case class.
const WORLD_BOOK_MATCHING_POLICY_VERSION = "lily-world-book-match-1";
const WORLD_BOOK_ACTIVATION_LIMITS_VERSION = 1;

const MAX_CHARACTER_CANONICAL_BYTES = 8 * 1024 * 1024;
const MAX_CHARACTER_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_CHARACTER_TEXT_FIELD_BYTES = 1024 * 1024;
const MAX_CHARACTER_ASSET_COUNT = 1000;
const MAX_CHARACTER_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_CHARACTER_ASSET_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_CHARACTER_ASSET_PURPOSE_BYTES = 256;
const MAX_CHARACTER_ASSET_MIME_BYTES = 255;
const MAX_CHARACTER_BINDING_BYTES = 64 * 1024;
const MAX_CHARACTER_RECONCILE_FILES = 1000;
const MAX_CHARACTER_RECONCILE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_CHARACTER_PNG_CHUNKS = 4096;
const MAX_CHARACTER_PNG_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHARACTER_PNG_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_CHARACTER_PNG_CARD_CHUNKS = 16;
const MAX_CHARACTER_PNG_CARD_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_CHARACTER_PNG_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_CHARACTER_PNG_PIXELS = 40_000_000;
const MAX_CHARACTER_WORKER_RESULT_BYTES = 64 * 1024 * 1024;
const DEFAULT_CHARACTER_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const CHARACTER_BLOB_RECONCILE_CURSOR_KEY = "character_worlds.blob_reconcile_cursor.v1";

// World-book (§7.4) normalization limits. Versioned and monotonic: a limit
// may only loosen through a deliberate WORLD_BOOK_LIMITS_VERSION bump, never
// silently. Every string/array/count admitted into a world-book revision is
// bounded by one of these; unknown fields are preserved inert under the same
// walk bounds.
const WORLD_BOOK_SCHEMA_VERSION = 1;
const MAX_WORLD_BOOK_LIMITS_VERSION = 1;
const MAX_WORLD_BOOK_CANONICAL_BYTES = 8 * 1024 * 1024;
const MAX_WORLD_BOOK_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_WORLD_BOOK_NAME_CHARS = 1024;
const MAX_WORLD_BOOK_ENTRIES = 10_000;
const MAX_WORLD_BOOK_ENTRY_ID_CHARS = 1024;
const MAX_WORLD_BOOK_CONTENT_CHARS = 1024 * 1024;
const MAX_WORLD_BOOK_SHORT_STRING_CHARS = 1024;
const MAX_WORLD_BOOK_KEYS_PER_ENTRY = 1024;
const MAX_WORLD_BOOK_INCLUSION_GROUPS = 1024;
const MAX_WORLD_BOOK_FILTER_ITEMS = 1024;
const MAX_WORLD_BOOK_GENERATION_TRIGGERS = 64;
const MAX_WORLD_BOOK_MATCH_SOURCES = 16;
const MAX_WORLD_BOOK_MESSAGE_COUNT = 100_000;
const MAX_WORLD_BOOK_RECURSION_STEPS = 1_000;
const MAX_WORLD_BOOK_DEPTH = 10_000;
const MAX_WORLD_BOOK_TOKEN_BUDGET = 1_000_000;
const MAX_WORLD_BOOK_ORDER = 1_000_000;
const MAX_WORLD_BOOK_GROUP_WEIGHT = 1_000_000;
const MAX_WORLD_BOOK_PRESERVED_DECORATORS = 1024;
const MAX_WORLD_BOOK_DATA_DEPTH = 32;
const MAX_WORLD_BOOK_DATA_NODES = 100_000;
const MAX_WORLD_BOOK_DATA_ARRAY_LENGTH = 100_000;
const MAX_WORLD_BOOK_STRING_CHARS = 2 * 1024 * 1024;

// Activation resolver hard limits (§10.4/§10.6). Caller-supplied budgets may
// only tighten these, never loosen (same discipline as DEFAULT_MACRO_LIMITS).
const DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS = Object.freeze({
  version: WORLD_BOOK_ACTIVATION_LIMITS_VERSION,
  // Selected insertion plan size.
  maxEntries: 256,
  // Conservative token estimate: one token per content code point.
  maxTokens: 32_768,
  // Total scan-corpus code points (chat window + matching sources).
  maxCorpusChars: 256_000,
  // One matching-source opt-in (description/personality/scenario/creatorNotes).
  maxSourceChars: 64_000,
  // Canonical messages admitted to the scan window (incl. min-activation sweeps).
  maxWindowMessages: 512,
  // Frontier candidates evaluated per recursion level / sweep. Sized to the
  // hard entry cap so a fully-matching book still resolves; callers may only
  // tighten.
  maxCandidatesPerFrontier: 16_384,
  // Timed-effect checkpoint entries per list (also the intake cap when
  // sanitizing a previous checkpoint).
  maxTimedEntries: 4_096,
  // Reported omissions (overflow is counted, not listed).
  maxOmitted: 1_024,
  // Trace candidate records (metadata only; overflow is counted).
  maxTraceCandidates: 2_048,
  // Inclusion-group resolution rounds across the whole resolve. A path-shaped
  // conflict graph eliminates a constant number of entries per round, so this
  // is sized to the hard entry cap; breach fails coded, never hangs.
  maxGroupRounds: 16_384,
  // Compiled plain-key index ceilings (§10.6: revision index build is
  // O(B + K)). Breach fails coded BEFORE the automaton materializes.
  maxKeyBytes: 8 * 1024 * 1024,
  maxAutomatonStates: 4_000_000,
  // Deterministic operation ceiling standing in for an elapsed-time budget:
  // the resolver is pure, so wall time can never affect its output; work is
  // bounded by counters instead (§10.6).
  maxOperations: 8_000_000,
});

// Rollout policy (design spec §16/§18). The server-signed client config may
// enable Character Worlds compilation/selection for a named compatibility
// profile; everything else — hard byte/macro limits, executable-content
// rejection — lives in the constants above and is NOT remotely tunable. The
// policy only ever gates availability: local card data and bindings stay
// stored and readable regardless of the resolved policy.
const DEFAULT_COMPATIBILITY_PROFILE = "lily-character-compat-1";
const SUPPORTED_PROFILES = new Set([DEFAULT_COMPATIBILITY_PROFILE]);

/**
 * Resolve the effective local policy from the (signature-verified, fresh)
 * remote client config. Fail-closed ordering:
 *   1. LILY_CHARACTER_WORLDS=0 — the emergency kill switch — always wins;
 *   2. an absent/invalid/disabled remote policy disables the feature;
 *   3. an enabled policy is honored with a SUPPORTED_PROFILES-validated
 *      compatibility profile (unknown → DEFAULT_COMPATIBILITY_PROFILE).
 * `remoteConfig` is the remote effectiveConfig object (or null/undefined when
 * there is no fresh verified config).
 */
function characterWorldsPolicy(remoteConfig) {
  if (process.env.LILY_CHARACTER_WORLDS === "0") return { enabled: false, reason: "kill_switch" };
  // Strict boolean: a hostile/loosely-typed policy block can only ever turn
  // the feature OFF, never on (mirrors the server-side delivery gate).
  if (remoteConfig?.characterWorlds?.enabled !== true) {
    return { enabled: false, reason: "remote_disabled" };
  }
  return {
    enabled: true,
    compatibilityProfile: SUPPORTED_PROFILES.has(remoteConfig.characterWorlds.compatibilityProfile)
      ? remoteConfig.characterWorlds.compatibilityProfile
      : DEFAULT_COMPATIBILITY_PROFILE,
  };
}

const DEFAULT_MACRO_LIMITS = Object.freeze({
  version: CHARACTER_MACRO_LIMITS_VERSION,
  maxInputBytes: 256 * 1024,
  maxOutputBytes: 512 * 1024,
  maxTokens: 65_536,
  maxNesting: 8,
  maxExpansions: 1_000,
  maxArgs: 64,
  maxArgBytes: 64 * 1024,
  maxTotalArgBytes: 256 * 1024,
  maxNameBytes: 64,
  maxContextStringBytes: 256 * 1024,
  maxContextTotalBytes: 512 * 1024,
  maxSeedBytes: 4 * 1024,
  maxDiceCount: 100,
  maxDiceSides: 1_000_000,
  maxDiceModifierAbs: 1_000_000,
  maxRandomDrawsPerChoice: 64,
  maxOperations: 1_000_000,
  maxElapsedMs: 1_000,
  maxWarnings: 128,
});
const DEFAULT_IMPORT_LIMITS = Object.freeze({
  version: CHARACTER_CARD_PARSER_LIMITS_VERSION,
  maxContainerBytes: MAX_CHARACTER_SOURCE_BYTES,
  maxJsonBytes: MAX_CHARACTER_CANONICAL_BYTES,
  maxCanonicalBytes: MAX_CHARACTER_CANONICAL_BYTES,
  maxDepth: 64,
  maxObjects: 10_000,
  maxMembers: 50_000,
  maxArrays: 10_000,
  maxArrayLength: 10_000,
  maxStrings: 50_000,
  maxKeys: 50_000,
  maxStringBytes: MAX_CHARACTER_TEXT_FIELD_BYTES,
  maxTotalStringBytes: MAX_CHARACTER_CANONICAL_BYTES,
  maxKeyBytes: 1024,
  maxTotalKeyBytes: 1024 * 1024,
  maxStringChars: 1024 * 1024,
  maxTotalStringChars: 8 * 1024 * 1024,
  maxKeyChars: 1024,
  maxTotalKeyChars: 1024 * 1024,
  maxCanonicalFieldChars: MAX_CHARACTER_TEXT_FIELD_BYTES,
  maxPngChunks: MAX_CHARACTER_PNG_CHUNKS,
  maxPngChunkBytes: MAX_CHARACTER_PNG_CHUNK_BYTES,
  maxPngMetadataBytes: MAX_CHARACTER_PNG_METADATA_BYTES,
  maxPngCardChunks: MAX_CHARACTER_PNG_CARD_CHUNKS,
  maxPngCardMetadataBytes: MAX_CHARACTER_PNG_CARD_METADATA_BYTES,
  maxPngDecodedPayloadBytes: MAX_CHARACTER_PNG_PAYLOAD_BYTES,
  maxPngPixels: MAX_CHARACTER_PNG_PIXELS,
  maxParseOperations: 64 * 1024 * 1024,
  maxParseElapsedMs: 30_000,
  maxReportEntries: 512,
  maxReportPathBytes: 64 * 1024,
  maxReportSupportedEntries: 96,
  maxReportSupportedPathBytes: 8 * 1024,
  maxReportMigratedEntries: 96,
  maxReportMigratedPathBytes: 8 * 1024,
  maxReportPreservedInertEntries: 224,
  maxReportPreservedInertPathBytes: 32 * 1024,
  maxReportIgnoredInvalidEntries: 48,
  maxReportIgnoredInvalidPathBytes: 8 * 1024,
  maxReportRejectedExecutableEntries: 48,
  maxReportRejectedExecutablePathBytes: 8 * 1024,
  maxNumberLexemes: 10_000,
  maxNumberLexemePathBytes: 256 * 1024,
});

module.exports = {
  CHARACTER_SCHEMA_VERSION,
  CHARACTER_BINDING_SCHEMA_VERSION,
  CHARACTER_COMPATIBILITY_PROFILE_VERSION,
  CHARACTER_COMPATIBILITY_PROFILE,
  CHARACTER_ASSET_LIMITS_VERSION,
  CHARACTER_CARD_PARSER_LIMITS_VERSION,
  CHARACTER_MACRO_LIMITS_VERSION,
  WORLD_BOOK_MATCHING_POLICY_VERSION,
  WORLD_BOOK_ACTIVATION_LIMITS_VERSION,
  DEFAULT_WORLD_BOOK_ACTIVATION_LIMITS,
  DEFAULT_MACRO_LIMITS,
  DEFAULT_IMPORT_LIMITS,
  MAX_CHARACTER_CANONICAL_BYTES,
  MAX_CHARACTER_SOURCE_BYTES,
  MAX_CHARACTER_TEXT_FIELD_BYTES,
  MAX_CHARACTER_ASSET_COUNT,
  MAX_CHARACTER_ASSET_BYTES,
  MAX_CHARACTER_ASSET_TOTAL_BYTES,
  MAX_CHARACTER_ASSET_PURPOSE_BYTES,
  MAX_CHARACTER_ASSET_MIME_BYTES,
  MAX_CHARACTER_BINDING_BYTES,
  MAX_CHARACTER_RECONCILE_FILES,
  MAX_CHARACTER_RECONCILE_FILE_BYTES,
  MAX_CHARACTER_PNG_CHUNKS,
  MAX_CHARACTER_PNG_CHUNK_BYTES,
  MAX_CHARACTER_PNG_METADATA_BYTES,
  MAX_CHARACTER_PNG_CARD_CHUNKS,
  MAX_CHARACTER_PNG_CARD_METADATA_BYTES,
  MAX_CHARACTER_PNG_PAYLOAD_BYTES,
  MAX_CHARACTER_PNG_PIXELS,
  MAX_CHARACTER_WORKER_RESULT_BYTES,
  DEFAULT_CHARACTER_ORPHAN_GRACE_MS,
  CHARACTER_BLOB_RECONCILE_CURSOR_KEY,
  WORLD_BOOK_SCHEMA_VERSION,
  MAX_WORLD_BOOK_LIMITS_VERSION,
  MAX_WORLD_BOOK_CANONICAL_BYTES,
  MAX_WORLD_BOOK_SOURCE_BYTES,
  MAX_WORLD_BOOK_NAME_CHARS,
  MAX_WORLD_BOOK_ENTRIES,
  MAX_WORLD_BOOK_ENTRY_ID_CHARS,
  MAX_WORLD_BOOK_CONTENT_CHARS,
  MAX_WORLD_BOOK_SHORT_STRING_CHARS,
  MAX_WORLD_BOOK_KEYS_PER_ENTRY,
  MAX_WORLD_BOOK_INCLUSION_GROUPS,
  MAX_WORLD_BOOK_FILTER_ITEMS,
  MAX_WORLD_BOOK_GENERATION_TRIGGERS,
  MAX_WORLD_BOOK_MATCH_SOURCES,
  MAX_WORLD_BOOK_MESSAGE_COUNT,
  MAX_WORLD_BOOK_RECURSION_STEPS,
  MAX_WORLD_BOOK_DEPTH,
  MAX_WORLD_BOOK_TOKEN_BUDGET,
  MAX_WORLD_BOOK_ORDER,
  MAX_WORLD_BOOK_GROUP_WEIGHT,
  MAX_WORLD_BOOK_PRESERVED_DECORATORS,
  MAX_WORLD_BOOK_DATA_DEPTH,
  MAX_WORLD_BOOK_DATA_NODES,
  MAX_WORLD_BOOK_DATA_ARRAY_LENGTH,
  MAX_WORLD_BOOK_STRING_CHARS,
  DEFAULT_COMPATIBILITY_PROFILE,
  SUPPORTED_PROFILES,
  characterWorldsPolicy,
};
