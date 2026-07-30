"use strict";

const {
  importError,
} = require("./file-authority-shared");

const MAX_OPERATION_TIMEOUT_MS = 30_000;
const RELEASE_SAFE_STATES = new Set(["ready", "release_failed", "retryable_safe"]);
const PROTECTED_STATES = new Set(["claimed", "committing", "outcome_unknown"]);

function stableError(error, fallbackCode, fallbackMessage) {
  if (
    typeof error?.code === "string"
    && (error.code.startsWith("EXPORT_") || error.code.startsWith("IMPORT_"))
  ) {
    return importError(error.code, fallbackMessage);
  }
  return importError(fallbackCode, fallbackMessage);
}

function releaseError() {
  return importError(
    "EXPORT_RELEASE_FAILED",
    "Export reservation could not be released",
  );
}

function releaseSafeState(state) {
  return RELEASE_SAFE_STATES.has(state);
}

function protectedState(state) {
  return PROTECTED_STATES.has(state);
}

function recoveryInfo(capability) {
  return Object.freeze({
    action: "reconcile",
    capability,
  });
}

function commitInProgressError(capability) {
  const error = importError(
    "EXPORT_COMMIT_IN_PROGRESS",
    "Export commit is already in progress",
  );
  error.capability = capability;
  error.recovery = recoveryInfo(capability);
  return error;
}

function commitOutcomeUnknownError(capability) {
  const error = importError(
    "EXPORT_COMMIT_OUTCOME_UNKNOWN",
    "Export commit outcome is not yet known",
  );
  error.capability = capability;
  error.recovery = recoveryInfo(capability);
  return error;
}

function destinationBusyError() {
  return importError(
    "EXPORT_DESTINATION_BUSY",
    "Export destination capacity is busy",
  );
}

function closeOutcomeUnknown(entries) {
  const capabilities = Object.freeze(entries
    .map((entry) => entry.capability)
    .filter((value) => typeof value === "string")
    .sort());
  const failures = capabilities.map((capability) => (
    commitOutcomeUnknownError(capability)
  ));
  const aggregate = new AggregateError(
    failures,
    "Export commit outcome is not yet known",
  );
  aggregate.code = "EXPORT_CLOSE_OUTCOME_UNKNOWN";
  aggregate.failures = Object.freeze(failures.map((error) => error.code));
  aggregate.unknownCapabilities = capabilities;
  aggregate.recovery = Object.freeze({
    action: "reconcile",
    capabilities,
  });
  return aggregate;
}

function closeAggregate(errors) {
  const failures = errors.map((error) => (
    stableError(error, "EXPORT_CLOSE_FAILED", "Destination writer cleanup failed")
  ));
  const aggregate = new AggregateError(
    failures,
    "Destination writer cleanup failed",
  );
  aggregate.code = "EXPORT_CLOSE_FAILED";
  aggregate.failures = Object.freeze(failures.map((error) => error.code));
  return aggregate;
}

function validFileName(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 255
    && !/[\/\\\u0000-\u001f\u007f]/.test(value);
}

function timeoutMs(value, fallback) {
  return Math.max(10, Math.min(
    Number.isSafeInteger(value) ? value : fallback,
    MAX_OPERATION_TIMEOUT_MS,
  ));
}

function waitWithDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(importError(
      "EXPORT_CLOSE_TIMEOUT",
      "Destination writer close timed out",
    ));
  }
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(importError(
        "EXPORT_CLOSE_TIMEOUT",
        "Destination writer close timed out",
      )), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function committedResult(bytes, reservation, committed) {
  const maintenanceWarnings = [
    ...(Array.isArray(committed?.maintenanceWarnings)
      ? committed.maintenanceWarnings.filter((warning) => (
        typeof warning === "string" && warning.length <= 128
      ))
      : []),
  ];
  const fileName = validFileName(committed?.fileName)
    ? committed.fileName
    : validFileName(reservation?.fileName)
      ? reservation.fileName
      : "character-card.json";
  return Object.freeze({
    bytes,
    fileName,
    publication: typeof committed?.publication === "string"
      ? committed.publication
      : "trusted_broker_transaction",
    atomicVisibility: committed?.atomicVisibility === true,
    crashRecovery: typeof committed?.crashRecovery === "string"
      ? committed.crashRecovery
      : "broker_defined",
    maintenanceWarnings: Object.freeze(maintenanceWarnings),
  });
}

async function pruneWriterCapabilities(writer) {
  const now = writer._time();
  for (const entry of [...writer.capabilities.values()]) {
    if (entry.expiresAt <= now && releaseSafeState(entry.state)) {
      entry.expired = true;
      await writer._releaseEntry(entry);
    }
  }
  while (writer.capabilities.size >= writer.maxCapabilities) {
    const oldest = [...writer.capabilities.values()]
      .find((entry) => releaseSafeState(entry.state));
    if (!oldest) throw destinationBusyError();
    oldest.expired = true;
    await writer._releaseEntry(oldest);
  }
}

function armWriterExpiry(writer, entry) {
  entry.timer = setTimeout(() => {
    if (writer.capabilities.get(entry.capability) !== entry) return;
    entry.expired = true;
    if (!releaseSafeState(entry.state)) return;
    void writer._releaseEntry(entry).catch(() => {
      // The tombstone remains retryable through cancel(), release(), or close().
    });
  }, writer.capabilityTtlMs);
  entry.timer.unref?.();
}

function watchCommitOutcome(entry) {
  if (entry.reconcilePromise) return entry.reconcilePromise;
  entry.reconcilePromise = Promise.resolve()
    .then(() => entry.reservation.reconcile())
    .then((outcome) => {
      if (outcome?.status === "committed") {
        entry.state = "committed";
        entry.committed = true;
        entry.commitResult = outcome.result;
        entry.commitErrorCode = null;
      } else if (outcome?.status === "retryable_safe") {
        entry.state = "retryable_safe";
        entry.commitErrorCode = outcome.errorCode || "EXPORT_WRITE_FAILED";
      }
      return outcome;
    })
    .catch((error) => {
      if (error?.code !== "EXPORT_COMMIT_OUTCOME_UNKNOWN") {
        entry.state = "retryable_safe";
        entry.commitErrorCode = typeof error?.code === "string"
          ? error.code
          : "EXPORT_WRITE_FAILED";
      }
      return { status: entry.state, errorCode: entry.commitErrorCode };
    });
  void entry.reconcilePromise.catch(() => {});
  return entry.reconcilePromise;
}

function reconcileCommitEntry(entry, removeEntry) {
  if (entry.state === "committed") {
    const result = committedResult(
      entry.commitBytes,
      entry.reservation,
      entry.commitResult,
    );
    removeEntry(entry);
    return Object.freeze({ status: "committed", result });
  }
  if (entry.state === "retryable_safe" || entry.state === "release_failed") {
    return Object.freeze({
      status: "retryable_safe",
      errorCode: entry.commitErrorCode,
    });
  }
  return Object.freeze({
    status: entry.state === "outcome_unknown"
      ? "outcome_unknown"
      : "in_progress",
    capability: entry.capability,
    recovery: recoveryInfo(entry.capability),
  });
}

module.exports = {
  armWriterExpiry,
  closeAggregate,
  closeOutcomeUnknown,
  commitInProgressError,
  commitOutcomeUnknownError,
  committedResult,
  destinationBusyError,
  pruneWriterCapabilities,
  protectedState,
  releaseSafeState,
  reconcileCommitEntry,
  releaseError,
  stableError,
  timeoutMs,
  validFileName,
  waitWithDeadline,
  watchCommitOutcome,
};
