"use strict";

process.once("message", ({ action, dbPath, id } = {}) => {
  let result;
  try {
    const recovery = require("./store/database-recovery");
    const operations = {
      inspect: () => recovery.inspectDatabase(dbPath),
      // Same admission decision as inspect, minus the page scan; the full
      // verification runs in the background right after the app opens.
      probe: () => recovery.inspectDatabase(dbPath, { verify: false }),
      prepare: () => recovery.prepareRecovery(dbPath),
      restore: () => recovery.restoreRecoveryCandidate(dbPath, id),
      backup: () => recovery.createRecoveryBackup(dbPath, { minIntervalMs: 6 * 60 * 60 * 1000 }),
      receipt: () => ({ ok: true, receipt: recovery.getRecoveryReceipt(dbPath) }),
      ack: () => recovery.acknowledgeRecoveryReceipt(dbPath, id),
    };
    result = operations[action]?.() || { ok: false, reason: "invalid_action" };
  } catch {
    // Avoid leaking user paths, message contents or connection settings to UI.
    result = { ok: false, reason: "unknown" };
  }
  process.send({ type: "database-recovery-result", result }, () => process.disconnect());
});
