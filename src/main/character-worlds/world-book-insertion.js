"use strict";

/**
 * Budget selection and insertion-plan ordering (§10.4.5, resolver half).
 *
 * Budget selection applies compatibility priority classes first:
 *   0. sticky and constant entries;
 *   1. direct chat matches;
 *   2. other explicit matching-source matches;
 *   3. recursive matches.
 * Within a class, entries with an explicit `priority` outrank those without
 * (higher value wins), then larger insertion-order values win budget
 * priority, then the stable entry id breaks ties. Entries that do not fit the
 * entry/token budgets are reported through `omit` with reasons
 * budget_entries / budget_tokens. The token estimate is conservative and
 * deterministic: one token per content code point.
 *
 * Prompt position is separate from budget priority: the final insertion plan
 * orders each entry by its envelope bucket (POSITION_ORDER), then ascending
 * insertion order so larger values land closer to the end where specified,
 * then stable entry id. Envelope rendering itself is WB-4.
 */

const { hashContent } = require("./world-book-matching");

const POSITION_ORDER = [
  "before_character", "after_character", "before_examples", "after_examples",
  "author_note_top", "author_note_bottom", "at_depth", "outlet",
];

function priorityClass(selection) {
  if (selection.route === "sticky" || selection.route === "constant") return 0;
  if (selection.sourceScope === "chat") return 1;
  if (selection.sourceScope === "recursion") return 3;
  return 2;
}

function compareIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function estimateTokens(content) {
  return [...content].length;
}

function selectWithinBudget(selections, { maxEntries, tokenBudget, omit }) {
  const ordered = [...selections].sort((a, b) => {
    const classDelta = priorityClass(a) - priorityClass(b);
    if (classDelta !== 0) return classDelta;
    const ap = a.entry.insertion?.priority ?? null;
    const bp = b.entry.insertion?.priority ?? null;
    if (ap !== null || bp !== null) {
      if (ap === null) return 1;
      if (bp === null) return -1;
      if (ap !== bp) return bp - ap;
    }
    const orderDelta = (b.entry.insertion?.order ?? 100) - (a.entry.insertion?.order ?? 100);
    if (orderDelta !== 0) return orderDelta;
    return compareIds(a.entry.id, b.entry.id);
  });
  const chosen = [];
  let tokens = 0;
  for (const selection of ordered) {
    if (chosen.length >= maxEntries) {
      omit(selection.entry.id, "budget_entries");
      continue;
    }
    const estimate = estimateTokens(selection.entry.content ?? "");
    if (tokens + estimate > tokenBudget) {
      omit(selection.entry.id, "budget_tokens");
      continue;
    }
    tokens += estimate;
    chosen.push(selection);
  }
  return chosen;
}

function toInsertionPlan(chosen) {
  const ordered = [...chosen].sort((a, b) => {
    const positionDelta = POSITION_ORDER.indexOf(a.entry.insertion?.position ?? "before_character")
      - POSITION_ORDER.indexOf(b.entry.insertion?.position ?? "before_character");
    if (positionDelta !== 0) return positionDelta;
    const orderDelta = (a.entry.insertion?.order ?? 100) - (b.entry.insertion?.order ?? 100);
    if (orderDelta !== 0) return orderDelta;
    return compareIds(a.entry.id, b.entry.id);
  });
  return ordered.map((selection) => ({
    entryId: selection.entry.id,
    content: selection.entry.content ?? "",
    contentHash: hashContent(selection.entry.content ?? ""),
    position: selection.entry.insertion?.position ?? "before_character",
    order: selection.entry.insertion?.order ?? 100,
    role: selection.entry.insertion?.role ?? "system",
    depth: selection.entry.insertion?.depth ?? 4,
    outletName: selection.entry.insertion?.outletName ?? "",
    reason: selection.route,
    sourceScope: selection.sourceScope,
    matchedKeyCount: selection.matchedKeyCount,
    recursionLevel: selection.recursionLevel,
  }));
}

module.exports = {
  POSITION_ORDER,
  selectWithinBudget,
  toInsertionPlan,
};
