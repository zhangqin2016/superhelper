"use strict";

const { getLogger } = require("./logger");

const log = getLogger("task");

/**
 * An objective audit that COULD NOT RUN and one that ran and found nothing both
 * come back as status "unknown". Downstream they are indistinguishable, and
 * "unknown" deliberately never escalates — so until 2026-09-22 a platform whose
 * completion audit was dead (no judge connection, the kill switch left at 0, a
 * gateway that answers unparseable text every time) looked exactly like a
 * platform whose every turn was genuinely inconclusive. Nothing said so on any
 * machine but the user's.
 *
 * Every "unknown" now passes through here. The BENIGN set below is closed: a
 * reason means "there was nothing to audit" only if it is listed. Anything else
 * — including a reason invented by code written after this module — is reported.
 * That is the point: an organ going quiet must cost someone a diagnostic, and
 * silence must never be the default a new branch inherits.
 */

// "Nothing to audit" — these are the normal shape of a turn that did no work,
// or whose request was not captured whole. They carry no signal about health.
const BENIGN_REASONS = new Set([
  "request_source_incomplete",
  "no_execution_record",
  "not_required",
]);

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/** A reason is "cause:detail"; the cause alone is the stable, loggable class. */
function causeOf(reason) {
  return String(reason || "unspecified").split(":")[0].trim() || "unspecified";
}

/** True when this unknown means the audit itself did not happen. */
function auditUnavailable(reason) {
  return !BENIGN_REASONS.has(causeOf(reason));
}

function createCoverageObserver({
  report,
  logger = log,
  now = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  // Bounded by the reason vocabulary, not by traffic.
  const reportedAt = new Map();
  return function observeCoverageUnknown(reason, state = {}) {
    try {
      if (!auditUnavailable(reason)) return null;
      const cause = causeOf(reason);
      const record = {
        cause,
        reason: String(reason || "").slice(0, 200),
        sessionId: String(state.sessionId || ""),
        turnId: String(state.turnId || ""),
        // Whether the turn's own model was available to audit on, or the audit
        // had to fall back to the active preset.
        routed: Boolean(state.turnModelRoute?.selectionId),
        modelId: String(state.turnModelRoute?.modelId || ""),
      };
      // Local logs are the first evidence and cost nothing, so every occurrence
      // is written down; only the upstream report is throttled.
      logger?.warn?.(`objective coverage unavailable: cause=${record.cause} reason=${record.reason} turn=${record.turnId || "-"} routed=${record.routed}`);
      const at = now();
      // "Never reported" is not "reported at time 0": a missing entry must let
      // the first one through whatever the clock reads.
      if (reportedAt.has(cause) && at - reportedAt.get(cause) < cooldownMs) return record;
      reportedAt.set(cause, at);
      const send = report || require("./service-client").reportRuntimeDiagnostic;
      Promise.resolve()
        .then(() => send({
          eventType: "runtime",
          eventSubtype: "objective_coverage_unavailable",
          normalizedKind: "objective_coverage_unavailable",
          severity: "warning",
          summary: `the completion audit could not run (${record.cause})`,
          trace: { schemaVersion: 1, ...record },
        }))
        .catch(() => { /* observation never changes a verdict */ });
      return record;
    } catch { return null; }
  };
}

const observeCoverageUnknown = createCoverageObserver();

module.exports = {
  BENIGN_REASONS,
  DEFAULT_COOLDOWN_MS,
  auditUnavailable,
  causeOf,
  createCoverageObserver,
  observeCoverageUnknown,
};
