"use strict";

/**
 * Blocked-directive redaction for low-authority imported narrative text
 * (spec §6, §10). One versioned pattern list covers every low-authority
 * field the compiler ships — character identity/narrative fields, world-entry
 * content, and the persona narrative description (Phase 2B P2B-2).
 *
 * A match is replaced by a bounded placeholder and recorded as a
 * metadata-only warning (field name + count, never the matched text). The
 * pattern list is a versioned constant, not a card/persona-controlled field.
 *
 * Cf format chars (ZWSP, ZWNJ/ZWJ, LRM/RLM, U+2028/U+2029, bidi controls,
 * isolates, BOM) are stripped BEFORE the blocked-directive match, so
 * "ignore​ all previous instructions" cannot evade redaction with
 * invisible codepoints.
 */

const BLOCKED_DIRECTIVE_PATTERNS = Object.freeze([
  /\bdisable\s+(?:all\s+)?tools?\b/gi,
  /\bignore\s+(?:all\s+)?(?:previous\s+|prior\s+|above\s+)?permissions?\b/gi,
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|guidelines?|policies)\b/gi,
  /\bbypass\s+(?:all\s+)?(?:permissions?|safety|guardrails?)\b/gi,
  /\boverride\s+(?:system\s+)?(?:authority|permissions?|guardrails?)\b/gi,
  /\byou\s+are\s+now\s+the\s+system\b/gi,
]);
const REDACTION_PLACEHOLDER = "[redacted]";
const FORMAT_CHAR_PATTERN = /[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

function redactBlockedDirectives(field, text, warnings) {
  // Strip invisible format chars first (zero-width evasion); the stripped
  // form is what ships.
  let redacted = text.replace(FORMAT_CHAR_PATTERN, "");
  let count = 0;
  for (const pattern of BLOCKED_DIRECTIVE_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, () => {
      count += 1;
      return REDACTION_PLACEHOLDER;
    });
  }
  if (count > 0) {
    warnings.push({ code: "CHARACTER_CONTEXT_DIRECTIVE_REDACTED", field, count });
  }
  return redacted;
}

module.exports = {
  BLOCKED_DIRECTIVE_PATTERNS,
  REDACTION_PLACEHOLDER,
  redactBlockedDirectives,
};
