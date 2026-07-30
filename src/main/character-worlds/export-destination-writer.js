"use strict";

const crypto = require("node:crypto");
const { MAX_CHARACTER_SOURCE_BYTES } = require("./constants");
const {
  assertDestinationBrokerProtocol,
  assertDestinationReservationProtocol,
} = require("./destination-broker-protocol");
const {
  assertNotAborted,
  importError,
} = require("./file-authority-shared");
const {
  armWriterExpiry,
  closeAggregate,
  closeOutcomeUnknown,
  commitInProgressError,
  commitOutcomeUnknownError,
  committedResult,
  pruneWriterCapabilities,
  protectedState,
  releaseSafeState,
  reconcileCommitEntry,
  releaseError,
  stableError,
  timeoutMs,
  waitWithDeadline,
  watchCommitOutcome,
} = require("./destination-writer-support");

const DEFAULT_DESTINATION_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RESERVE_TIMEOUT_MS = 5000;
const DEFAULT_COMMIT_TIMEOUT_MS = 5000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5000;
const MAX_DESTINATION_CAPABILITIES = 64;
const CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;

class CharacterDestinationWriter {
  constructor({
    broker,
    ownsBroker = false,
    now = Date.now,
    capabilityTtlMs = DEFAULT_DESTINATION_CAPABILITY_TTL_MS,
    maxCapabilities = MAX_DESTINATION_CAPABILITIES,
    reserveTimeoutMs = DEFAULT_RESERVE_TIMEOUT_MS,
    commitTimeoutMs = DEFAULT_COMMIT_TIMEOUT_MS,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  } = {}) {
    assertDestinationBrokerProtocol(broker);
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.broker = broker;
    this.ownsBroker = ownsBroker === true;
    this.now = now;
    this.capabilityTtlMs = Math.max(1, Math.min(
      Number.isSafeInteger(capabilityTtlMs)
        ? capabilityTtlMs
        : DEFAULT_DESTINATION_CAPABILITY_TTL_MS,
      DEFAULT_DESTINATION_CAPABILITY_TTL_MS,
    ));
    this.maxCapabilities = Math.max(1, Math.min(
      Math.floor(Number(maxCapabilities) || MAX_DESTINATION_CAPABILITIES),
      MAX_DESTINATION_CAPABILITIES,
    ));
    this.reserveTimeoutMs = timeoutMs(reserveTimeoutMs, DEFAULT_RESERVE_TIMEOUT_MS);
    this.commitTimeoutMs = timeoutMs(commitTimeoutMs, DEFAULT_COMMIT_TIMEOUT_MS);
    this.closeTimeoutMs = timeoutMs(closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    this.capabilities = new Map();
    this.maintenanceEntries = new Set();
    this.approvals = new Set();
    this.writes = new Set();
    this.closed = false;
    this.closeComplete = false;
    this.closePromise = null;
    this.lifecycleEpoch = 0;
  }

  _time() {
    const value = Number(this.now());
    return Number.isFinite(value) ? Math.trunc(value) : Date.now();
  }

  _admit(signal, collection, fallbackCode, fallbackMessage) {
    const controller = new AbortController();
    let settle;
    const operation = {
      controller,
      epoch: this.lifecycleEpoch,
      externalSignal: signal || null,
      externalAbort: null,
      settled: new Promise((resolve) => { settle = resolve; }),
      settle,
    };
    if (signal) {
      operation.externalAbort = () => controller.abort(
        signal.reason || importError(fallbackCode, fallbackMessage),
      );
      if (signal.aborted) operation.externalAbort();
      else signal.addEventListener("abort", operation.externalAbort, { once: true });
    }
    collection.add(operation);
    return operation;
  }

  _finish(operation, collection) {
    if (operation.externalSignal && operation.externalAbort) {
      operation.externalSignal.removeEventListener("abort", operation.externalAbort);
    }
    collection.delete(operation);
    operation.settle();
  }

  _removeEntry(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (
      entry.capability
      && this.capabilities.get(entry.capability) === entry
    ) {
      this.capabilities.delete(entry.capability);
    }
    this.maintenanceEntries.delete(entry);
  }

  async _releaseEntry(entry) {
    if (!entry || entry.state === "released") return false;
    if (protectedState(entry.state)) return false;
    if (entry.releasePromise) return entry.releasePromise;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.state = "releasing";
    entry.releasePromise = Promise.resolve()
      .then(() => entry.reservation.release({
        deadline: Date.now() + this.reserveTimeoutMs,
      }))
      .then(() => {
        entry.state = "released";
        this._removeEntry(entry);
        return true;
      })
      .catch(() => {
        entry.releasePromise = null;
        entry.state = "release_failed";
        if (entry.committed || !entry.capability) {
          this.maintenanceEntries.add(entry);
        } else if (entry.capability) {
          this.capabilities.set(entry.capability, entry);
        }
        throw releaseError();
      });
    return entry.releasePromise;
  }

  async _releaseReservation(reservation) {
    const entry = {
      capability: null,
      reservation,
      expiresAt: 0,
      timer: null,
      releasePromise: null,
      state: "claimed",
      expired: false,
      committed: false,
    };
    entry.state = "ready";
    await this._releaseEntry(entry);
  }

  async approve(destinationRequest, { overwrite = false, signal } = {}) {
    if (this.closed) {
      throw importError("EXPORT_DESTINATION_CLOSED", "Export destination writer is closed");
    }
    const operation = this._admit(
      signal,
      this.approvals,
      "EXPORT_WRITE_CANCELLED",
      "Character export was cancelled",
    );
    try {
      assertNotAborted(
        operation.controller.signal,
        "EXPORT_WRITE_CANCELLED",
        "Character export was cancelled",
      );
      await pruneWriterCapabilities(this);
      let reservation;
      try {
        reservation = await this.broker.reserve(destinationRequest, {
          overwrite,
          signal: operation.controller.signal,
          deadline: Date.now() + this.reserveTimeoutMs,
        });
      } catch (error) {
        throw stableError(
          error,
          "EXPORT_DESTINATION_UNAUTHORIZED",
          "Export destination is not authorized",
        );
      }

      try {
        assertDestinationReservationProtocol(reservation);
      } catch {
        if (typeof reservation?.release === "function") {
          await this._releaseReservation(reservation);
        }
        throw importError(
          "EXPORT_BROKER_PROTOCOL",
          "Destination broker returned an invalid reservation",
        );
      }

      if (
        this.closed
        || operation.epoch !== this.lifecycleEpoch
        || operation.controller.signal.aborted
      ) {
        await this._releaseReservation(reservation);
        assertNotAborted(
          operation.controller.signal,
          "EXPORT_DESTINATION_CLOSED",
          "Export destination writer is closed",
        );
        throw importError("EXPORT_DESTINATION_CLOSED", "Export destination writer is closed");
      }

      let capability;
      do {
        capability = crypto.randomBytes(32).toString("hex");
      } while (this.capabilities.has(capability));
      const entry = {
        capability,
        reservation,
        expiresAt: this._time() + this.capabilityTtlMs,
        timer: null,
        releasePromise: null,
        state: "ready",
        expired: false,
        committed: false,
        commitResult: null,
        commitBytes: 0,
        commitErrorCode: null,
        reconcilePromise: null,
      };
      this.capabilities.set(capability, entry);
      armWriterExpiry(this, entry);
      return capability;
    } finally {
      this._finish(operation, this.approvals);
    }
  }

  async release(capability) {
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
      return false;
    }
    const entry = this.capabilities.get(capability);
    if (!entry) return false;
    if (!releaseSafeState(entry.state)) return false;
    await this._releaseEntry(entry);
    return true;
  }

  async cancel(capability) {
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
      return false;
    }
    const entry = this.capabilities.get(capability);
    if (!entry) return false;
    if (entry.state === "committing") throw commitInProgressError(capability);
    if (entry.state === "outcome_unknown") {
      throw commitOutcomeUnknownError(capability);
    }
    if (!releaseSafeState(entry.state)) return false;
    await this._releaseEntry(entry);
    return true;
  }

  async write(capability, data, { signal } = {}) {
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
      throw importError("EXPORT_DESTINATION_INVALID", "Export destination is invalid");
    }
    const entry = this.capabilities.get(capability);
    if (this.closed) {
      if (entry && releaseSafeState(entry.state)) await this._releaseEntry(entry);
      throw importError("EXPORT_DESTINATION_CLOSED", "Export destination writer is closed");
    }
    if (!entry || entry.state !== "ready") {
      throw importError("EXPORT_DESTINATION_INVALID", "Export destination is invalid");
    }
    if (entry.expiresAt <= this._time()) {
      entry.expired = true;
      await this._releaseEntry(entry);
      throw importError("EXPORT_DESTINATION_INVALID", "Export destination is invalid");
    }

    const bytes = Buffer.from(data);
    const operation = this._admit(
      signal,
      this.writes,
      "EXPORT_WRITE_CANCELLED",
      "Character export was cancelled",
    );
    operation.entry = entry;
    entry.state = "claimed";
    entry.commitBytes = bytes.length;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    try {
      if (bytes.length > MAX_CHARACTER_SOURCE_BYTES) {
        entry.state = "retryable_safe";
        await this._releaseEntry(entry);
        throw importError("EXPORT_TOO_LARGE", "Character export exceeds the size limit");
      }

      let committed;
      try {
        assertNotAborted(
          operation.controller.signal,
          "EXPORT_WRITE_CANCELLED",
          "Character export was cancelled",
        );
        await entry.reservation.write(bytes, {
          signal: operation.controller.signal,
          deadline: Date.now() + this.reserveTimeoutMs,
        });
        assertNotAborted(
          operation.controller.signal,
          "EXPORT_WRITE_CANCELLED",
          "Character export was cancelled",
        );
        entry.state = "committing";
        committed = await entry.reservation.commit({
          signal: operation.controller.signal,
          deadline: Date.now() + this.commitTimeoutMs,
        });
        entry.committed = true;
        entry.commitResult = committed;
        entry.state = "committed";
        this.capabilities.delete(capability);
      } catch (error) {
        if (error?.code === "EXPORT_COMMIT_OUTCOME_UNKNOWN") {
          entry.state = "outcome_unknown";
          entry.commitErrorCode = error.code;
          watchCommitOutcome(entry);
          throw commitOutcomeUnknownError(capability);
        }
        entry.state = "retryable_safe";
        try {
          await this._releaseEntry(entry);
        } catch (releaseFailure) {
          throw releaseFailure;
        }
        throw stableError(
          error,
          "EXPORT_WRITE_FAILED",
          "Character export could not be written",
        );
      }

      const result = committedResult(bytes.length, entry.reservation, committed);
      const maintenanceWarnings = [...result.maintenanceWarnings];
      try {
        await this._releaseEntry(entry);
      } catch {
        if (!maintenanceWarnings.includes("EXPORT_RELEASE_MAINTENANCE_REQUIRED")) {
          maintenanceWarnings.push("EXPORT_RELEASE_MAINTENANCE_REQUIRED");
        }
      }

      return Object.freeze({
        ...result,
        maintenanceWarnings: Object.freeze(maintenanceWarnings),
      });
    } finally {
      this._finish(operation, this.writes);
    }
  }

  async reconcile(capability) {
    if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) {
      throw importError("EXPORT_DESTINATION_INVALID", "Export destination is invalid");
    }
    const entry = this.capabilities.get(capability);
    if (!entry) {
      throw importError("EXPORT_DESTINATION_INVALID", "Export destination is invalid");
    }
    return reconcileCommitEntry(entry, (current) => this._removeEntry(current));
  }

  _entries() {
    return [...new Set([
      ...this.capabilities.values(),
      ...this.maintenanceEntries,
    ])];
  }

  async _releaseRound() {
    const failures = [];
    await Promise.all(this._entries().map(async (entry) => {
      if (protectedState(entry.state)) return;
      try {
        await this._releaseEntry(entry);
      } catch (error) {
        failures.push(error);
      }
    }));
    return failures;
  }

  async _closeAttempt(deadline) {
    const closedError = importError(
      "EXPORT_DESTINATION_CLOSED",
      "Export destination writer is closed",
    );
    for (const operation of this.approvals) operation.controller.abort(closedError);
    for (const operation of this.writes) operation.controller.abort(closedError);

    const committing = [...this.writes]
      .filter((operation) => operation.entry?.state === "committing")
      .map((operation) => operation.settled);
    try {
      await waitWithDeadline(Promise.allSettled(committing), deadline);
    } catch {
      const unknown = this._entries().filter((entry) => (
        entry.state === "committing" || entry.state === "outcome_unknown"
      ));
      throw closeOutcomeUnknown(unknown);
    }

    const settling = Promise.allSettled([
      ...[...this.approvals].map((operation) => operation.settled),
      ...[...this.writes].map((operation) => operation.settled),
    ]);
    const firstRelease = this._releaseRound();
    await waitWithDeadline(firstRelease, deadline);
    const unknown = this._entries().filter((entry) => (
      entry.state === "committing" || entry.state === "outcome_unknown"
    ));
    if (unknown.length > 0) throw closeOutcomeUnknown(unknown);
    let brokerFailure = null;
    const brokerClose = this.ownsBroker && typeof this.broker.close === "function"
      ? Promise.resolve()
        .then(() => new Promise((resolve) => setTimeout(resolve, 10)))
        .then(() => this.broker.close({ deadline }))
        .catch((error) => {
          brokerFailure = stableError(
            error,
            "EXPORT_CLOSE_FAILED",
            "Destination broker cleanup failed",
          );
        })
      : Promise.resolve();

    await waitWithDeadline(
      Promise.all([settling, brokerClose])
        .then(() => undefined),
      deadline,
    );

    const finalFailures = await waitWithDeadline(this._releaseRound(), deadline);
    const retryFailures = finalFailures.length > 0
      ? await waitWithDeadline(this._releaseRound(), deadline)
      : [];
    const failures = [
      ...(retryFailures.length > 0 ? retryFailures : []),
      ...(brokerFailure ? [brokerFailure] : []),
    ];
    if (failures.length > 0) throw closeAggregate(failures);
    this.capabilities.clear();
    this.maintenanceEntries.clear();
  }

  async close() {
    if (this.closeComplete) return;
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.lifecycleEpoch += 1;
    const deadline = Date.now() + this.closeTimeoutMs;
    const attempt = this._closeAttempt(deadline)
      .then(() => {
        this.closeComplete = true;
      })
      .finally(() => {
        if (!this.closeComplete) this.closePromise = null;
      });
    this.closePromise = attempt;
    return attempt;
  }
}

module.exports = {
  CharacterDestinationWriter,
};
