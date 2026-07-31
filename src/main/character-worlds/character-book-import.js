"use strict";

/**
 * Embedded `character_book` (SillyTavern lorebook) mapping for V2/V3 cards.
 *
 * The mapper translates the ecosystem field spellings into the bounded §7.4
 * canonical input and normalizes it through world-book-model, so every limit
 * (entries, keys, strings, depth, nodes) is enforced at parse time. A book
 * that breaches a limit or carries hostile structure throws WORLD_BOOK_* and
 * rejects the whole import: per §14.1 a card is never partially imported and
 * presented as complete. Unsupported-but-harmless fields are preserved inert
 * (entry `preservedExtensions`, unknown-key passthrough) and surfaced through
 * the shared compatibility report: mapped fields classify as `supported`,
 * present-but-unusable values as `ignoredInvalid`, unknown data as
 * `preservedInert`.
 *
 * Field mapping (first existing source wins; entry top level beats
 * entry.extensions, which is where V3 cards keep the behavior knobs):
 *
 *   keys | key                                   -> activation.primaryKeys
 *   secondary_keys | keysecondary                 -> activation.secondaryKeys
 *   constant                                      -> activation.constant
 *   selective                                     -> activation.selective
 *   selectiveLogic (0..3: and_any/not_all/not_any/and_all, or string)
 *                                                 -> activation.selectiveLogic
 *   use_regex | useRegex                          -> activation.useRegex
 *   vectorized                                    -> activation.vectorized
 *   case_sensitive | caseSensitive                -> activation.caseSensitive
 *   match_whole_words | matchWholeWords           -> activation.matchWholeWords
 *   probability (useProbability === false forces 100)
 *                                                 -> activation.probability
 *   group                                         -> activation.inclusionGroups
 *   groupWeight                                   -> activation.groupWeight
 *   group_override | groupOverride                -> activation.prioritizeInclusion
 *   useGroupScoring                               -> activation.useGroupScoring
 *   triggers                                      -> activation.generationTriggers
 *   delay / sticky / cooldown                     -> activation.delay/sticky/cooldownMessages
 *   position (before_char/after_char/before_em/after_em/before_an/after_an/
 *     at_depth/outlet, normalized spellings, or SillyTavern numeric 0..7)
 *                                                 -> insertion.position
 *   depth                                         -> insertion.depth
 *   role (system|user|assistant)                  -> insertion.role
 *   outlet_name | outletName                      -> insertion.outletName
 *   insertion_order | order                       -> insertion.order
 *   priority                                      -> insertion.priority
 *   prevent_recursion | preventRecursion          -> recursion.preventFurtherRecursion
 *   exclude_recursion | excludeRecursion          -> recursion.excludeFromRecursion
 *   delay_until_recursion | delayUntilRecursion   -> recursion.delayUntilRecursion
 *   id (string or number)                         -> entry id
 *   content                                       -> entry content
 *   enabled (or inverted `disable`)               -> entry enabled
 *
 *   book.name | book.displayName                  -> book name (fallback:
 *                                                    "<character> embedded book")
 *   book.scan_depth / token_budget / recursive_scanning
 *                                                 -> scanPolicy
 *
 * Everything else (comment, name/memo, automation_id, display_index,
 * characterFilter, book-level extensions, ...) is preserved inert: the raw
 * entry.extensions object lands in entry.preservedExtensions verbatim and
 * unknown keys pass through the normalized document untouched. The static
 * field tables live in character-book-fields.js.
 */

const { normalizeWorldBookCanonical } = require("./world-book-model");
const { executableKey } = require("./executable-keys");
const {
  BOOK_FIELDS,
  CONVERTERS,
  ENTRY_FIELDS,
  MISSING,
  RESERVED_BOOK_KEYS,
  RESERVED_ENTRY_KEYS,
  STRUCTURAL_ENTRY_KEYS,
} = require("./character-book-fields");

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// Mirrors the card parser's preserved walk with one difference: executable-
// sounding keys are skipped entirely (not classified, not recursed into).
// The final whole-card walk already reports them as rejectedExecutable at the
// exact pointer even inside the demoted book subtree, so classifying them
// here would double-classify the pointer and reject the whole import (§4.2
// requires inert reporting without blocking the safe parts of the card).
function classifyBookInert(value, { report, pointer, budget }) {
  budget.consume(1);
  if (Array.isArray(value)) {
    if (value.length === 0) report.add("preservedInert", pointer);
    for (let index = 0; index < value.length; index += 1) {
      pointer.push(index);
      try {
        classifyBookInert(value[index], { report, pointer, budget });
      } finally {
        pointer.pop();
      }
    }
    return;
  }
  if (!isPlainObject(value)) {
    report.add("preservedInert", pointer);
    return;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) report.add("preservedInert", pointer);
  for (const key of keys) {
    if (executableKey(key)) continue;
    pointer.push(key);
    try {
      classifyBookInert(value[key], { report, pointer, budget });
    } finally {
      pointer.pop();
    }
  }
}

// Passthrough values never carry executable-flagged keys into the trusted
// canonical document (same stance as the character pipeline's inertClone):
// they survive only in the raw preserved payload. Returns the original
// reference when nothing had to be stripped.
function stripExecutableKeys(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const stripped = stripExecutableKeys(item);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? items : value;
  }
  if (!isPlainObject(value)) return value;
  let changed = false;
  const result = {};
  for (const key of Object.keys(value)) {
    if (executableKey(key)) {
      changed = true;
      continue;
    }
    const stripped = stripExecutableKeys(value[key]);
    if (stripped !== value[key]) changed = true;
    result[key] = stripped;
  }
  return changed ? result : value;
}

function mapEmbeddedCharacterBook(source, cardName, hooks) {
  if (!isPlainObject(source) || !hasOwn(source, "character_book")) return null;
  return mapBook(source, cardName, hooks);
}

function mapBook(source, cardName, hooks) {
  const { report, pointer, budget, consumeKey } = hooks;
  pointer.push("character_book");
  try {
    const book = source.character_book;
    consumeKey(source, "character_book");
    if (!isPlainObject(book)) {
      budget.consume(1);
      report.add("ignoredInvalid", pointer);
      return null;
    }
    const observedBefore = { ...report.observed };
    const input = {
      schemaVersion: 1,
      name: mapBookName(book, cardName, hooks),
      entries: mapBookEntries(book, hooks),
      scanPolicy: {},
    };
    for (const [key, target, kind] of BOOK_FIELDS) {
      if (!hasOwn(book, key)) continue;
      budget.consume(1);
      pointer.push(key);
      try {
        const converted = CONVERTERS[kind](book[key]);
        if (converted === MISSING) report.add("ignoredInvalid", pointer);
        else {
          report.add("supported", pointer);
          input.scanPolicy[target] = converted;
        }
      } finally {
        pointer.pop();
      }
    }
    for (const key of Object.keys(book)) {
      if (key === "entries" || key === "name" || key === "displayName"
        || BOOK_FIELDS.some(([field]) => field === key)) {
        continue;
      }
      if (executableKey(key)) continue; // deferred: final walk reports rejectedExecutable
      budget.consume(1);
      pointer.push(key);
      try {
        classifyBookInert(book[key], hooks);
        if (!RESERVED_BOOK_KEYS.has(key)) input[key] = stripExecutableKeys(book[key]);
      } finally {
        pointer.pop();
      }
    }
    if (Object.keys(input.scanPolicy).length === 0) delete input.scanPolicy;
    const canonical = normalizeWorldBookCanonical(input);
    return {
      canonical,
      summary: {
        name: canonical.name,
        entryCount: canonical.entries.length,
        supportedFields: report.observed.supported - observedBefore.supported,
        inertFields: report.observed.preservedInert - observedBefore.preservedInert,
      },
    };
  } finally {
    pointer.pop();
  }
}

function mapBookName(book, cardName, { report, pointer, budget }) {
  for (const key of ["name", "displayName"]) {
    if (!hasOwn(book, key)) continue;
    budget.consume(1);
    pointer.push(key);
    try {
      const converted = CONVERTERS.string(book[key]);
      if (converted === MISSING) {
        report.add("ignoredInvalid", pointer);
      } else {
        report.add("supported", pointer);
        return converted;
      }
    } finally {
      pointer.pop();
    }
  }
  return `${cardName} embedded book`;
}

function mapBookEntries(book, hooks) {
  const { report, pointer, budget } = hooks;
  if (!hasOwn(book, "entries")) return [];
  budget.consume(1);
  pointer.push("entries");
  try {
    if (!Array.isArray(book.entries)) {
      // normalizeWorldBookCanonical rejects this below with
      // WORLD_BOOK_DATA_INVALID (fail closed); the pointer is still recorded.
      report.add("ignoredInvalid", pointer);
      return book.entries;
    }
    report.add("supported", pointer);
    return book.entries.map((entry, index) => mapEntry(entry, index, hooks));
  } finally {
    pointer.pop();
  }
}

function mapEntry(entry, index, hooks) {
  const { report, pointer, budget } = hooks;
  budget.consume(1);
  pointer.push(index);
  try {
    if (!isPlainObject(entry)) {
      // Fail closed through the model's plain-object guard.
      return entry;
    }
    const extensions = isPlainObject(entry.extensions) ? entry.extensions : null;
    const input = { activation: {}, insertion: {}, recursion: {} };
    // Handled spellings are tracked per scope: an entry-level `constant` must
    // not mark extensions-level `constant` as handled (and vice versa).
    const handled = new Set(STRUCTURAL_ENTRY_KEYS);
    const handledExtensions = new Set();

    mapStructuralEntryFields(entry, input, hooks);
    mapTableFields(entry, extensions, input, handled, handledExtensions, hooks);
    mapUseProbability(entry, extensions, input, handled, handledExtensions, hooks);
    mapExtensions(entry, extensions, input, handledExtensions, hooks);

    for (const key of Object.keys(entry)) {
      if (handled.has(key)) continue;
      if (executableKey(key)) continue; // deferred: final walk reports rejectedExecutable
      budget.consume(1);
      pointer.push(key);
      try {
        classifyBookInert(entry[key], hooks);
        if (!RESERVED_ENTRY_KEYS.has(key)) input[key] = stripExecutableKeys(entry[key]);
      } finally {
        pointer.pop();
      }
    }

    if (Object.keys(input.activation).length === 0) delete input.activation;
    if (Object.keys(input.insertion).length === 0) delete input.insertion;
    if (Object.keys(input.recursion).length === 0) delete input.recursion;
    return input;
  } finally {
    pointer.pop();
  }
}

function mapStructuralEntryFields(entry, input, { report, pointer, budget }) {
  pointer.push("id");
  try {
    if (hasOwn(entry, "id")) {
      budget.consume(1);
      const converted = CONVERTERS.entryId(entry.id);
      if (converted === MISSING) report.add("ignoredInvalid", pointer);
      else {
        report.add("supported", pointer);
        input.id = converted;
      }
    }
  } finally {
    pointer.pop();
  }
  pointer.push("content");
  try {
    if (hasOwn(entry, "content")) {
      budget.consume(1);
      if (typeof entry.content === "string") {
        report.add("supported", pointer);
        input.content = entry.content;
      } else {
        report.add("ignoredInvalid", pointer);
      }
    }
  } finally {
    pointer.pop();
  }
  for (const [key, invert] of [["enabled", false], ["disable", true]]) {
    if (!hasOwn(entry, key)) continue;
    budget.consume(1);
    pointer.push(key);
    try {
      if (typeof entry[key] === "boolean") {
        report.add("supported", pointer);
        if (!hasOwn(input, "enabled")) input.enabled = invert ? !entry[key] : entry[key];
      } else {
        report.add("ignoredInvalid", pointer);
      }
    } finally {
      pointer.pop();
    }
  }
}

function mapTableFields(entry, extensions, input, handled, handledExtensions, { report, pointer, budget }) {
  for (const [scope, key, section, target, kind] of ENTRY_FIELDS) {
    const object = scope === "extensions" ? extensions : entry;
    if (!object || !hasOwn(object, key) || hasOwn(input[section], target)) continue;
    (scope === "extensions" ? handledExtensions : handled).add(key);
    budget.consume(1);
    if (scope === "extensions") pointer.push("extensions");
    try {
      pointer.push(key);
      try {
        const converted = CONVERTERS[kind](object[key]);
        if (converted === MISSING) report.add("ignoredInvalid", pointer);
        else {
          report.add("supported", pointer);
          input[section][target] = converted;
        }
      } finally {
        pointer.pop();
      }
    } finally {
      if (scope === "extensions") pointer.pop();
    }
  }
}

// SillyTavern gates probability behind useProbability.
function mapUseProbability(entry, extensions, input, handled, handledExtensions, { report, pointer, budget }) {
  for (const [object, scope] of [[entry, "entry"], [extensions, "extensions"]]) {
    if (!object || !hasOwn(object, "useProbability")) continue;
    (scope === "extensions" ? handledExtensions : handled).add("useProbability");
    budget.consume(1);
    if (scope === "extensions") pointer.push("extensions");
    try {
      pointer.push("useProbability");
      try {
        if (typeof object.useProbability === "boolean") {
          report.add("supported", pointer);
          if (object.useProbability === false) input.activation.probability = 100;
        } else {
          report.add("ignoredInvalid", pointer);
        }
      } finally {
        pointer.pop();
      }
    } finally {
      if (scope === "extensions") pointer.pop();
    }
  }
}

function mapExtensions(entry, extensions, input, handledExtensions, hooks) {
  const { report, pointer, budget } = hooks;
  if (!hasOwn(entry, "extensions")) return;
  budget.consume(1);
  if (!extensions) {
    pointer.push("extensions");
    try {
      report.add("ignoredInvalid", pointer);
    } finally {
      pointer.pop();
    }
    return;
  }
  for (const key of Object.keys(extensions)) {
    if (handledExtensions.has(key)) continue;
    if (executableKey(key)) continue; // deferred: final walk reports rejectedExecutable
    budget.consume(1);
    pointer.push("extensions");
    try {
      pointer.push(key);
      try {
        classifyBookInert(extensions[key], hooks);
      } finally {
        pointer.pop();
      }
    } finally {
      pointer.pop();
    }
  }
  input.preservedExtensions = stripExecutableKeys(extensions);
}

module.exports = {
  mapEmbeddedCharacterBook,
};
