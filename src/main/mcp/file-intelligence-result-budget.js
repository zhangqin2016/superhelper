"use strict";

/**
 * A byte budget for what a file tool hands back to the model.
 *
 * Every other bound in file-intelligence caps what is READ from disk or how many
 * LINES are counted. Nothing capped the bytes RETURNED, so a 2-line, 60 KB file
 * asked for "two lines" handed over all 60 KB — line count is not a proxy for
 * size, and an oversized tool result is how a long session runs itself out of
 * context. Acceptance 2026-09-17 DEF-07.
 *
 * Trimming is always reported and always resumable: the result says how many
 * bytes were dropped and which line to continue from. It never returns nothing —
 * a single line larger than the whole budget is cut mid-line, because an empty
 * result is not evidence.
 *
 * [gate: tool-result-context-budget]
 */

const DEFAULT_MAX_RESULT_BYTES = 8 * 1024;
const MAX_RESULT_BYTES_CEILING = 256 * 1024;

function resultByteBudget(input = {}, options = {}) {
  const requested = Number(input.maxResultBytes ?? options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_MAX_RESULT_BYTES;
  return Math.max(512, Math.min(requested, MAX_RESULT_BYTES_CEILING));
}

/**
 * Trim returned text to a byte budget on a line boundary where possible, and say
 * so. Never returns nothing: a single line longer than the whole budget is cut
 * mid-line rather than dropped, because an empty result is not evidence.
 */
function capResultText(text, { maxBytes, rangeStart = 1, rangeEnd = 1 } = {}) {
  const full = String(text ?? "");
  if (Buffer.byteLength(full, "utf8") <= maxBytes) {
    return { text: full, rangeEnd, truncated: false };
  }
  const lines = full.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (used + cost > maxBytes) break;
    kept.push(line);
    used += cost;
  }
  if (!kept.length) {
    // One line bigger than the budget. Cut on a character boundary.
    const cut = Buffer.from(full, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
    return {
      text: cut,
      rangeEnd: rangeStart,
      truncated: true,
      truncatedBytes: Buffer.byteLength(full, "utf8") - Buffer.byteLength(cut, "utf8"),
      truncatedWithinLine: true,
    };
  }
  return {
    text: kept.join("\n"),
    rangeEnd: rangeStart + kept.length - 1,
    truncated: true,
    truncatedBytes: Buffer.byteLength(full, "utf8") - used,
    truncatedWithinLine: false,
  };
}

function truncationFields(capped, { nextLineKey = "nextLine" } = {}) {
  if (!capped.truncated) return {};
  return {
    truncated: true,
    truncatedBytes: capped.truncatedBytes,
    truncatedWithinLine: capped.truncatedWithinLine || undefined,
    [nextLineKey]: capped.truncatedWithinLine ? capped.rangeEnd : capped.rangeEnd + 1,
  };
}

module.exports = {
  DEFAULT_MAX_RESULT_BYTES,
  MAX_RESULT_BYTES_CEILING,
  capResultText,
  resultByteBudget,
  truncationFields,
};
