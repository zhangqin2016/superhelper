"use strict";

/** A 4xx the shape learner could not turn into a lesson is exactly what the
 *  team needs to see to add a server-delivered hint: report it (host + model +
 *  the server's redacted words, never the key), best effort, never blocking. */
function reportUnhandledProbeRejection({ baseUrl, model, probe }) {
  try {
    if (!/^HTTP_4\d\d$/.test(String(probe?.error || "")) || !probe?.detail?.message) return;
    const host = (() => { try { return new URL(baseUrl).host; } catch { return ""; } })();
    const report = require("./service-client").reportRuntimeDiagnostic;
    if (typeof report !== "function") return;
    Promise.resolve(report({
      eventType: "model_probe", eventSubtype: "unhandled_rejection", normalizedKind: String(probe.detail.code || probe.error), severity: "warning",
      summary: `${host} ${model}: ${String(probe.detail.message).slice(0, 300)}`,
      trace: { status: probe.detail.status || Number(String(probe.error).slice(5)) || 0, param: probe.detail.param || "", host, model },
    })).catch(() => {});
  } catch { /* telemetry never affects the save */ }
}

module.exports = { reportUnhandledProbeRejection };
