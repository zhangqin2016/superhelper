"use strict";

const {
  legacyAdmissionFacts,
} = require("./turn-admission-migration-metadata");
const MOBILE_MIGRATION_BATCH_SIZE = 256;

function migrateLegacyExternalIdentities(db) {
  const seen = new Set();
  let cursor = 0;
  while (true) {
    const rows = db.all(
      `SELECT rowid, owner_scope, external_command_id,
              external_idempotency_key, external_payload_hash, metadata_json
       FROM turn_inputs
       WHERE rowid > ?
         AND external_command_id IS NOT NULL
       ORDER BY rowid
       LIMIT ?`,
      cursor,
      MOBILE_MIGRATION_BATCH_SIZE,
    );
    if (!rows.length) break;
    for (const row of rows) {
      cursor = Number(row.rowid);
      const facts = legacyAdmissionFacts(row.metadata_json);
      if (
        facts.identityConflict
        || !facts.externalDesktopDeviceId
        || !facts.externalMobileDeviceId
        || facts.externalCommandId !== row.external_command_id
        || facts.externalIdempotencyKey !== row.external_idempotency_key
        || facts.externalPayloadHash !== row.external_payload_hash
      ) continue;
      const key = [
        facts.externalDesktopDeviceId,
        facts.externalMobileDeviceId,
        facts.externalIdempotencyKey,
      ].join("\u0000");
      if (seen.has(key)) {
        db.run(
          `UPDATE turn_inputs
           SET migration_reason = 'legacy_external_identity_duplicate'
           WHERE rowid = ?`,
          row.rowid,
        );
        continue;
      }
      seen.add(key);
      db.run(
        `UPDATE turn_inputs
         SET external_desktop_device_id = ?,
             external_mobile_device_id = ?
         WHERE rowid = ?`,
        facts.externalDesktopDeviceId,
        facts.externalMobileDeviceId,
        row.rowid,
      );
    }
  }
}

module.exports = { migrateLegacyExternalIdentities };
