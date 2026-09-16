"use strict";

/**
 * How an index query finds its rows, and how it explains finding none.
 *
 * Retrieval is FTS5 with a LIKE scan as the fallback for a store whose FTS table
 * is unavailable or whose query the tokenizer rejects.
 *
 * The honesty half: which documents in an index carry ONLY a metadata chunk.
 *
 * A .docx/.xlsx/.pptx/.pdf whose text was never extracted is still counted as
 * indexed, so a search that finds nothing in it reads as "the document does not
 * contain that" — a different claim entirely. This derives the answer from the
 * chunks themselves rather than from a stored field, so indexes written before
 * content indexing existed answer honestly too.
 *
 * [gate: document-content-index]
 */

// The single source of truth for "a kind whose text can be extracted" lives with
// the extractor. Two copies would drift, and the drift is silent: the honesty
// hint would simply stop mentioning whichever kind was forgotten.
const DOCUMENT_SOURCE_TYPES = [...require("./mcp/file-intelligence-content").EXTRACTABLE_KINDS];

const EMPTY_QUERY_NOTE =
  "No match. These documents were indexed by metadata only, so their text was never searchable — "
  + "re-index them with content extraction or read them directly before concluding the content is absent.";

/**
 * @param {{ all: (sql: string, ...params: any[]) => any[] }} db
 * @returns {Array<{ sourcePath: string, kind: string }>}
 */
function metadataOnlyDocuments(db, indexId, limit = 20) {
  if (!db || !indexId) return [];
  try {
    return db.all(
      `SELECT source_path AS sourcePath, MIN(source_type) AS kind
         FROM chunks
        WHERE index_id = ? AND source_type IN (${DOCUMENT_SOURCE_TYPES.map(() => "?").join(",")})
        GROUP BY source_path
       HAVING SUM(CASE WHEN range_type = 'metadata' THEN 0 ELSE 1 END) = 0
        ORDER BY source_path
        LIMIT ?`,
      indexId,
      ...DOCUMENT_SOURCE_TYPES,
      Math.max(1, Number(limit) || 20),
    );
  } catch {
    // An honesty hint must never be able to fail a query.
    return [];
  }
}

/** The fields a no-match query result adds, or nothing when there is nothing to say. */
function emptyResultHint(db, indexId) {
  const documents = metadataOnlyDocuments(db, indexId);
  return documents.length ? { metadataOnlyDocuments: documents, note: EMPTY_QUERY_NOTE } : {};
}

/**
 * Rows matching a query, newest retrieval path first. Falls back to a bounded
 * LIKE scan when FTS is unusable, so a query never fails just because the
 * virtual table is missing.
 */
function fetchMatchingRows(db, { indexId, ftsQuery, query, max, tokenize }) {
  try {
    return db.all(
      `SELECT c.*, bm25(chunks_fts) AS rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
          AND c.index_id = ?
        ORDER BY rank ASC, c.chunk_id ASC
        LIMIT ?`,
      ftsQuery,
      indexId,
      max,
    );
  } catch {
    const terms = tokenize(query);
    return db.all("SELECT * FROM chunks WHERE index_id = ? ORDER BY id", indexId)
      .filter((row) => {
        const haystack = String(row.search_text || "").toLowerCase();
        return terms.some((term) => haystack.includes(term));
      })
      .slice(0, max);
  }
}

module.exports = {
  DOCUMENT_SOURCE_TYPES,
  fetchMatchingRows,
  EMPTY_QUERY_NOTE,
  emptyResultHint,
  metadataOnlyDocuments,
};
