"use strict";

// What the platform's own scripts recorded about documents: which pages were
// inspected (lily-vision), where each render's receipt is (render_document.py)
// and which workbook bytes were recalculated (lily_xlsx_recalc.py). The turn's
// delivery gate and the agent's lily_delivery_check read the same entries.
// LILY_VISION_LEDGER=0 turns them all off: printed evidence only, as before 2026-09-30.
const { getLogger } = require("./logger");
const { ledgerInspections } = require("./vision-inspection-receipt");
const { ledgerRenders } = require("./document-render-receipt");
const { ledgerRecalcs } = require("./workbook-recalc-receipt");

const log = getLogger("delivery-ledgers");

/** { visionInspections, renderReceipts, recalcReceipts } recorded at or after `since`. */
function deliveryEvidenceSince(since, dirs = {}) {
  const empty = { visionInspections: [], renderReceipts: [], recalcReceipts: [] };
  if (process.env.LILY_VISION_LEDGER === "0" || !(Number(since) > 0)) return empty;
  try {
    return {
      visionInspections: ledgerInspections({ since, ...(dirs.vision ? { dir: dirs.vision } : {}) }),
      renderReceipts: ledgerRenders({ since, ...(dirs.render ? { dir: dirs.render } : {}) }),
      recalcReceipts: ledgerRecalcs({ since, ...(dirs.recalc ? { dir: dirs.recalc } : {}) }),
    };
  } catch (err) {
    log.warn("delivery ledgers unreadable, printed evidence only: %s", err?.message || err);
    return empty;
  }
}

/** The evidence recorded during the turn `state` describes. */
function turnDeliveryEvidence(state = {}) {
  return deliveryEvidenceSince(Number(state.startedAt) || 0);
}

module.exports = { deliveryEvidenceSince, turnDeliveryEvidence };
