"use strict";

// Called only by the existing database owner. No decode/compression or file
// discovery runs while the owner writes, and no background connection writes.
function applyEnrichmentCommit(db, change) {
  if (change.type === "row") {
    const { row, next } = change;
    const result = db.prepare("UPDATE messages SET envelope_blob=? WHERE session_id=? AND seq=? AND id=? AND envelope_blob=?")
      .run(next, row.session_id, row.seq, row.id, row.envelope_blob);
    if (!result.changes) throw new Error("ENRICHMENT_CONCURRENT_CHANGE");
    return true;
  }
  if (change.type === "meta") {
    db.prepare("INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(change.key, String(change.value));
    return true;
  }
  if (change.type === "deleteMeta") {
    db.prepare("DELETE FROM schema_meta WHERE key=?").run(change.key);
    return true;
  }
  throw new Error("UNKNOWN_ENRICHMENT_COMMIT");
}

module.exports = { applyEnrichmentCommit };
