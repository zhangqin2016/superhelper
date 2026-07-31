"use strict";

/**
 * Static field tables for the embedded character_book (SillyTavern lorebook)
 * mapping. Kept separate from character-book-import.js so both stay within
 * the architecture line budget. See that module for the mapping narrative.
 */

const MISSING = Symbol("missing");

const SELECTIVE_LOGIC_NUMBERS = new Map([
  [0, "and_any"],
  [1, "not_all"],
  [2, "not_any"],
  [3, "and_all"],
]);

const SELECTIVE_LOGIC_STRINGS = new Set(["and_any", "and_all", "not_any", "not_all"]);

const POSITION_STRINGS = new Map([
  ["before_char", "before_character"],
  ["after_char", "after_character"],
  ["before_em", "before_examples"],
  ["after_em", "after_examples"],
  ["before_an", "author_note_top"],
  ["after_an", "author_note_bottom"],
  ["at_depth", "at_depth"],
  ["outlet", "outlet"],
  ["before_character", "before_character"],
  ["after_character", "after_character"],
  ["before_examples", "before_examples"],
  ["after_examples", "after_examples"],
  ["author_note_top", "author_note_top"],
  ["author_note_bottom", "author_note_bottom"],
]);

// SillyTavern world_info_position numeric encoding.
const POSITION_NUMBERS = new Map([
  [0, "before_character"],
  [1, "after_character"],
  [2, "author_note_top"],
  [3, "author_note_bottom"],
  [4, "at_depth"],
  [5, "before_examples"],
  [6, "after_examples"],
  [7, "outlet"],
]);

const INSERTION_ROLES = new Set(["system", "user", "assistant"]);

function stringItems(value) {
  return value.filter((item) => typeof item === "string");
}

// Converters return MISSING when a present value is unusable (reported as
// ignoredInvalid) and the converted §7.4 value otherwise.
const CONVERTERS = {
  bool: (value) => (typeof value === "boolean" ? value : MISSING),
  int: (value) => (
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : MISSING
  ),
  probability: (value) => (
    typeof value === "number" && Number.isFinite(value) ? value : MISSING
  ),
  string: (value) => (typeof value === "string" && value.length > 0 ? value : MISSING),
  stringArray: (value) => (Array.isArray(value) ? stringItems(value) : MISSING),
  groupList: (value) => {
    if (typeof value === "string") return value.length > 0 ? [value] : MISSING;
    return Array.isArray(value) ? stringItems(value) : MISSING;
  },
  selectiveLogic: (value) => {
    // Unknown strings are rejected (ignoredInvalid + model default), never
    // silently rewritten while reported as supported.
    if (typeof value === "string") {
      return SELECTIVE_LOGIC_STRINGS.has(value) ? value : MISSING;
    }
    if (typeof value === "number" && SELECTIVE_LOGIC_NUMBERS.has(value)) {
      return SELECTIVE_LOGIC_NUMBERS.get(value);
    }
    return MISSING;
  },
  position: (value) => {
    if (typeof value === "string" && POSITION_STRINGS.has(value)) {
      return POSITION_STRINGS.get(value);
    }
    if (typeof value === "number" && POSITION_NUMBERS.has(value)) {
      return POSITION_NUMBERS.get(value);
    }
    return MISSING;
  },
  role: (value) => (
    typeof value === "string" && INSERTION_ROLES.has(value) ? value : MISSING
  ),
  boolOrInt: (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value > 0;
    return MISSING;
  },
  entryId: (value) => {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return MISSING;
  },
};

// [scope, key, targetSection, targetKey, converter]. First existing source
// wins, so entry top level beats entry.extensions (where V3 cards keep the
// behavior knobs).
const ENTRY_FIELDS = [
  ["entry", "constant", "activation", "constant", "bool"],
  ["extensions", "constant", "activation", "constant", "bool"],
  ["entry", "keys", "activation", "primaryKeys", "stringArray"],
  ["entry", "key", "activation", "primaryKeys", "stringArray"],
  ["entry", "secondary_keys", "activation", "secondaryKeys", "stringArray"],
  ["entry", "keysecondary", "activation", "secondaryKeys", "stringArray"],
  ["entry", "selective", "activation", "selective", "bool"],
  ["extensions", "selective", "activation", "selective", "bool"],
  ["entry", "selectiveLogic", "activation", "selectiveLogic", "selectiveLogic"],
  ["extensions", "selectiveLogic", "activation", "selectiveLogic", "selectiveLogic"],
  ["entry", "use_regex", "activation", "useRegex", "bool"],
  ["entry", "useRegex", "activation", "useRegex", "bool"],
  ["extensions", "use_regex", "activation", "useRegex", "bool"],
  ["extensions", "useRegex", "activation", "useRegex", "bool"],
  ["entry", "vectorized", "activation", "vectorized", "bool"],
  ["extensions", "vectorized", "activation", "vectorized", "bool"],
  ["entry", "case_sensitive", "activation", "caseSensitive", "bool"],
  ["entry", "caseSensitive", "activation", "caseSensitive", "bool"],
  ["extensions", "case_sensitive", "activation", "caseSensitive", "bool"],
  ["extensions", "caseSensitive", "activation", "caseSensitive", "bool"],
  ["entry", "match_whole_words", "activation", "matchWholeWords", "bool"],
  ["entry", "matchWholeWords", "activation", "matchWholeWords", "bool"],
  ["extensions", "matchWholeWords", "activation", "matchWholeWords", "bool"],
  ["entry", "probability", "activation", "probability", "probability"],
  ["extensions", "probability", "activation", "probability", "probability"],
  ["entry", "group", "activation", "inclusionGroups", "groupList"],
  ["extensions", "group", "activation", "inclusionGroups", "groupList"],
  ["entry", "groupWeight", "activation", "groupWeight", "int"],
  ["extensions", "groupWeight", "activation", "groupWeight", "int"],
  ["entry", "group_override", "activation", "prioritizeInclusion", "bool"],
  ["entry", "groupOverride", "activation", "prioritizeInclusion", "bool"],
  ["extensions", "groupOverride", "activation", "prioritizeInclusion", "bool"],
  ["entry", "useGroupScoring", "activation", "useGroupScoring", "bool"],
  ["extensions", "useGroupScoring", "activation", "useGroupScoring", "bool"],
  ["entry", "triggers", "activation", "generationTriggers", "stringArray"],
  ["extensions", "triggers", "activation", "generationTriggers", "stringArray"],
  ["entry", "delay", "activation", "delayMessages", "int"],
  ["extensions", "delay", "activation", "delayMessages", "int"],
  ["entry", "sticky", "activation", "stickyMessages", "int"],
  ["extensions", "sticky", "activation", "stickyMessages", "int"],
  ["entry", "cooldown", "activation", "cooldownMessages", "int"],
  ["extensions", "cooldown", "activation", "cooldownMessages", "int"],
  ["entry", "position", "insertion", "position", "position"],
  ["extensions", "position", "insertion", "position", "position"],
  ["entry", "depth", "insertion", "depth", "int"],
  ["extensions", "depth", "insertion", "depth", "int"],
  ["entry", "role", "insertion", "role", "role"],
  ["extensions", "role", "insertion", "role", "role"],
  ["entry", "outlet_name", "insertion", "outletName", "string"],
  ["entry", "outletName", "insertion", "outletName", "string"],
  ["extensions", "outletName", "insertion", "outletName", "string"],
  ["entry", "insertion_order", "insertion", "order", "int"],
  ["entry", "order", "insertion", "order", "int"],
  ["entry", "priority", "insertion", "priority", "int"],
  ["extensions", "priority", "insertion", "priority", "int"],
  ["entry", "prevent_recursion", "recursion", "preventFurtherRecursion", "bool"],
  ["entry", "preventRecursion", "recursion", "preventFurtherRecursion", "bool"],
  ["extensions", "preventRecursion", "recursion", "preventFurtherRecursion", "bool"],
  ["entry", "exclude_recursion", "recursion", "excludeFromRecursion", "bool"],
  ["entry", "excludeRecursion", "recursion", "excludeFromRecursion", "bool"],
  ["extensions", "exclude_recursion", "recursion", "excludeFromRecursion", "bool"],
  ["extensions", "excludeRecursion", "recursion", "excludeFromRecursion", "bool"],
  ["entry", "delay_until_recursion", "recursion", "delayUntilRecursion", "boolOrInt"],
  ["entry", "delayUntilRecursion", "recursion", "delayUntilRecursion", "boolOrInt"],
  ["extensions", "delayUntilRecursion", "recursion", "delayUntilRecursion", "boolOrInt"],
];

// Book-level scan-policy fields: [key, targetKey, converter].
const BOOK_FIELDS = [
  ["scan_depth", "scanDepthMessages", "int"],
  ["token_budget", "tokenBudget", "int"],
  ["recursive_scanning", "recursive", "bool"],
];

// Canonical §7.4 keys the mapper constructs itself; same-named raw keys are
// classified inert but never passed through (they would collide).
const RESERVED_BOOK_KEYS = new Set([
  "schemaVersion", "name", "displayName", "entries", "scanPolicy",
]);
const RESERVED_ENTRY_KEYS = new Set([
  "id", "enabled", "content", "activation", "insertion", "recursion",
  "preservedDecorators", "preservedExtensions",
]);
const STRUCTURAL_ENTRY_KEYS = new Set(["id", "content", "enabled", "disable", "extensions"]);

module.exports = {
  BOOK_FIELDS,
  CONVERTERS,
  ENTRY_FIELDS,
  MISSING,
  RESERVED_BOOK_KEYS,
  RESERVED_ENTRY_KEYS,
  STRUCTURAL_ENTRY_KEYS,
};
