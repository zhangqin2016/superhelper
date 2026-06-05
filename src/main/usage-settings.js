"use strict";

const { getDeviceId, fetchUsageSummary } = require("./service-client");
const { getUsageSummary: getLocalUsageSummary } = require("./usage-local-store");
const { getPendingTodayTotals } = require("./usage-reporter");
const { buildUsageSummary, DEFAULT_HISTORY_DAYS } = require("./usage-summary");

async function getUsageSettingsPublic() {
  const deviceId = getDeviceId();
  const pendingToday = getPendingTodayTotals();
  const historyDays = DEFAULT_HISTORY_DAYS;

  const remote = await fetchUsageSummary({ historyDays });
  if (remote.ok && remote.json?.days) {
    return {
      ok: true,
      deviceId,
      source: "server",
      summary: buildUsageSummary({
        days: remote.json.days,
        historyDays: remote.json.historyDays || historyDays,
        pendingToday,
      }),
    };
  }

  const local = getLocalUsageSummary({ historyDays, pendingToday });
  return {
    ok: true,
    deviceId,
    source: "local",
    serverError: remote.error || null,
    summary: local,
  };
}

module.exports = {
  getUsageSettingsPublic,
};
