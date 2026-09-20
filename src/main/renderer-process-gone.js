"use strict";

const { getLogger } = require("./logger");

const log = getLogger("window");

/**
 * A renderer process ending is always written down and always reported.
 *
 * Until 2026-09-20 it was logged only under LILY_DEBUG_RENDERER and reported
 * nowhere, so a customer's "this window could not load · killed · 15" left no
 * trace on any machine but theirs. The exit code carries the signal on POSIX
 * (15 = SIGTERM, 9 = SIGKILL); with the uptime and whether the window came
 * back on its own, the next report answers itself.
 *
 * @param {{ reason?: string, exitCode?: number, recovered?: boolean, attempt?: number, role?: string }} info
 * @param {{ window?: string, report?: Function }} [context]
 */
function recordRendererGone(info = {}, context = {}) {
  const uptimeMs = Math.round(process.uptime() * 1000);
  const record = {
    window: String(context.window || info.role || "main"),
    reason: String(info.reason || "unknown"),
    exitCode: Number.isFinite(Number(info.exitCode)) ? Number(info.exitCode) : null,
    recovered: info.recovered === true,
    attempt: Number(info.attempt) || 0,
    uptimeMs,
    platform: process.platform,
    arch: process.arch,
  };
  log.error(`renderer process gone: window=${record.window} reason=${record.reason} exitCode=${record.exitCode} uptime=${Math.round(uptimeMs / 1000)}s recovered=${record.recovered} attempt=${record.attempt}`);
  const report = context.report || (() => require("./service-client").reportRuntimeDiagnostic);
  Promise.resolve()
    .then(() => report()({
      eventType: "runtime",
      eventSubtype: "renderer_process_gone",
      normalizedKind: "renderer_process_gone",
      severity: record.recovered ? "warning" : "error",
      summary: `renderer ${record.reason} (exit ${record.exitCode}) after ${Math.round(uptimeMs / 1000)}s in ${record.window}; ${record.recovered ? "recovered" : "not recovered"}`,
      trace: { schemaVersion: 1, ...record },
    }))
    .catch(() => { /* reporting never affects recovery */ });
  return record;
}

module.exports = { recordRendererGone };
