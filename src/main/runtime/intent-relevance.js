"use strict";

/**
 * Deterministic, model-free intent relevance: token overlap between a request
 * text and a candidate text (guide section, procedure card). Latin words plus
 * CJK bigrams, so Chinese requests score without segmentation. Used to pick
 * WHICH guide sections survive a weak gateway's system budget and WHICH stored
 * procedure card matches a new request — cheap enough to run on every turn.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "be", "this", "that", "it", "as", "at", "by", "from", "into", "use",
]);

function intentTokens(value) {
  const text = String(value || "").toLowerCase();
  const tokens = new Set();
  for (const word of text.match(/[a-z0-9_./-]{2,}/g) || []) {
    if (!STOPWORDS.has(word)) tokens.add(word);
  }
  const cjk = text.match(/[一-鿿㐀-䶿]/g) || [];
  for (let i = 0; i < cjk.length - 1; i += 1) {
    tokens.add(cjk[i] + cjk[i + 1]);
  }
  return tokens;
}

/** Shared-token count between a request and a candidate text. 0 = unrelated. */
function intentOverlapScore(requestText, candidateText) {
  const request = intentTokens(requestText);
  if (!request.size) return 0;
  const candidate = intentTokens(candidateText);
  if (!candidate.size) return 0;
  let shared = 0;
  for (const token of candidate) {
    if (request.has(token)) shared += 1;
  }
  return shared;
}

module.exports = {
  intentTokens,
  intentOverlapScore,
};
