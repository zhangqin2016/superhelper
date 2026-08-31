"use strict";

const { getDeviceId, fetchUsageSummary } = require("./service-client");
const { getUsageSummary: getLocalUsageSummary } = require("./usage-local-store");
const { getPendingUsageSnapshot } = require("./usage-reporter");
const { buildUsageSummary, DEFAULT_HISTORY_DAYS } = require("./usage-summary");

function decorateModels(summary) {
  let models = [];
  try { models = require("./model-selection-catalog").listModelSelectionPublic().models || []; }
  catch { /* Usage history must remain readable without a working model catalog. */ }
  const names = new Map(models.map(model => [JSON.stringify([model.providerID, model.modelID]), model]));
  const decorate = row => {
    const option = names.get(JSON.stringify([row.providerID, row.model]));
    return { ...row, label: option?.label || row.model,
      connectionType: option ? (option.managed ? "managed" : "custom") : "unknown" };
  };
  return { ...summary,
    today: { ...summary.today, models: summary.today.models.map(decorate) },
    history: summary.history.map(day => ({ ...day, models: day.models.map(decorate) })),
    modelTotals: summary.modelTotals.map(decorate),
  };
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
      })),
    };
  }

  const local = getLocalUsageSummary({ historyDays, pendingUsage: after.records });
  return {
    ok: true,
    deviceId,
    source: "local",
    localReason: serverAvailable ? "syncing" : "offline",
    serverError: remote?.error || null,
    summary: decorateModels(local),
  };
}

module.exports = {
  getUsageSettingsPublic,
};
