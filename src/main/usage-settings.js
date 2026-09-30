"use strict";

const { getDeviceId, fetchUsageSummary } = require("./service-client");
const { getUsageSummary: getLocalUsageSummary } = require("./usage-local-store");
const { getPendingUsageSnapshot } = require("./usage-reporter");
const { buildUsageSummary, DEFAULT_HISTORY_DAYS } = require("./usage-summary");
const { applyCreditEstimates } = require("./usage-credits");

// The last rates the server sent, so an offline refresh still estimates.
let lastCreditRates = null;

/** Connection ids that route through the Lily gateway (charged in credits). */
function creditBilledProviderIds() {
  try {
    const { classifyModelRoute } = require("./model-route-audit");
    return new Set(require("./model-selection-catalog").listRuntimeModelIds()
      .filter(model => classifyModelRoute(model.env || {}).isGateway).map(model => model.providerID));
  } catch { return new Set(); }
}

function decorateModels(summary, creditRates) {
  let models = [];
  try { models = require("./model-selection-catalog").listModelSelectionPublic().models || []; }
  catch { /* Usage history must remain readable without a working model catalog. */ }
  const names = new Map(models.map(model => [JSON.stringify([model.providerID, model.modelID]), model]));
  const billed = creditBilledProviderIds();
  const decorate = row => {
    const option = names.get(JSON.stringify([row.providerID, row.model]));
    return { ...row, label: option?.label || row.model,
      connectionType: option ? (option.managed ? "managed" : "custom") : "unknown",
      billedInCredits: option ? billed.has(row.providerID) : null };
  };
  return applyCreditEstimates({ ...summary,
    today: { ...summary.today, models: summary.today.models.map(decorate) },
    history: summary.history.map(day => ({ ...day, models: day.models.map(decorate) })),
    modelTotals: summary.modelTotals.map(decorate),
  }, creditRates);
}

async function getUsageSettingsPublic() {
  const deviceId = getDeviceId();
  const before = getPendingUsageSnapshot();
  const historyDays = DEFAULT_HISTORY_DAYS;
  let remote;
  try { remote = await fetchUsageSummary({ historyDays }); }
  catch { remote = { ok: false, error: "USAGE_UNAVAILABLE" }; }
  const after = getPendingUsageSnapshot();
  const serverAvailable = remote?.ok && Array.isArray(remote.json?.days);
  // An upload may be included in the remote response already. When its receipt
  // is uncertain, the local store and current pending records are disjoint.
  const stable = before.revision === after.revision && !before.unconfirmedReports && !after.unconfirmedReports;
  if (serverAvailable && remote.json.creditRates) lastCreditRates = remote.json.creditRates;
  if (serverAvailable && stable) {
    return {
      ok: true,
      deviceId,
      source: "server",
      summary: decorateModels(buildUsageSummary({
        days: remote.json.days,
        byModel: remote.json.byModel,
        historyDays,
        pendingUsage: after.records,
      }), lastCreditRates),
    };
  }

  const local = getLocalUsageSummary({ historyDays, pendingUsage: after.records });
  return {
    ok: true,
    deviceId,
    source: "local",
    localReason: serverAvailable ? "syncing" : "offline",
    serverError: remote?.error || null,
    summary: decorateModels(local, lastCreditRates),
  };
}

module.exports = {
  getUsageSettingsPublic,
};
