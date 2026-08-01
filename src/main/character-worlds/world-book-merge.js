"use strict";

/**
 * §10.4.1 multi-book merge (Phase 3 P3-2): resolve chat/persona/character/
 * global book revisions from the admitted binding.
 *
 * Source precedence: chat and Persona lore win ties but never bypass entry
 * insertion order. character/global lore follow the selected merge strategy
 * (`constant`: every book's constant entries merge, earlier scope wins on
 * duplicate entry ids; later strategies like `keyed`/`global` are reserved).
 *
 * Fail open: an empty/invalid input returns no units; a single book returns
 * that book's units unchanged.
 */

const SCOPE_PRECEDENCE = ["chat", "persona", "character", "global"];

function sortScoped(books) {
  return [...books].sort((a, b) => {
    const ai = SCOPE_PRECEDENCE.indexOf(a.scope);
    const bi = SCOPE_PRECEDENCE.indexOf(b.scope);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || String(a.scope).localeCompare(String(b.scope));
  });
}

/**
 * @param {Array} books [{ scope, revision }] — revision has canonical with
 *   normalized entries; only scope + entry ids matter for ordering.
 * @returns {Array} merged unit descriptors [{ scope, entryId, content, order }]
 */
function mergeWorldBooks(books = [], strategy = "constant") {
  const scoped = sortScoped(books.filter((b) => b && typeof b === "object" && b.revision));
  if (scoped.length === 0) return [];
  if (scoped.length === 1) {
    return entriesOf(scoped[0]);
  }
  const seen = new Set();
  const keySeen = new Set();
  const merged = [];
  for (const book of scoped) {
    for (const entry of entriesOf(book)) {
      if (seen.has(entry.entryId)) continue;
      seen.add(entry.entryId);
      if (strategy === "keyed") {
        // keyed: one winner per activation key (earlier scope wins); an
        // entry without keys still merges like constant.
        const keys = entry.activationKeys || [];
        const conflict = keys.some((k) => keySeen.has(k));
        if (conflict) continue;
        keys.forEach((k) => keySeen.add(k));
      }
      merged.push(entry);
    }
  }
  return merged;
}

function entriesOf(book) {
  const canonical = book.revision?.canonical || {};
  const raw = Array.isArray(canonical.entries) ? canonical.entries : [];
  const out = [];
  let order = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    out.push({
      scope: book.scope,
      entryId: entry.id || `e${order}`,
      content: entry.content || "",
      order,
      activationKeys: Array.isArray(entry.activation?.primaryKeys) ? entry.activation.primaryKeys : [],
    });
    order += 1;
  }
  return out;
}

module.exports = { mergeWorldBooks, SCOPE_PRECEDENCE };
