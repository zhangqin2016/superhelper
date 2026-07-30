"use strict";

const { MAX_CHARACTER_SOURCE_BYTES } = require("./constants");
const {
  DESTINATION_RESERVATION_PROTOCOL,
} = require("./destination-broker-protocol");
const { importError } = require("./file-authority-shared");

class ReferenceDestinationReservation {
  constructor(broker, reservationId, fileName) {
    this.protocol = DESTINATION_RESERVATION_PROTOCOL;
    this.fileName = fileName;
    this.broker = broker;
    this.reservationId = reservationId;
    this.released = false;
    this.committed = false;
    this.commitOperation = null;
    this.commitResult = null;
    this.outcomeUnknown = false;
    this.reconcilePromise = null;
  }

  async write(data, { signal, deadline } = {}) {
    if (this.released || this.committed) {
      throw importError("EXPORT_DESTINATION_INVALID", "Export reservation is invalid");
    }
    if (this.commitOperation) {
      throw importError(
        "EXPORT_COMMIT_IN_PROGRESS",
        "Export commit cannot accept additional writes",
      );
    }
    const bytes = Buffer.from(data);
    if (bytes.length > MAX_CHARACTER_SOURCE_BYTES) {
      throw importError("EXPORT_TOO_LARGE", "Character export exceeds the size limit");
    }
    return this.broker._request("write", {
      reservationId: this.reservationId,
      bytes,
    }, { signal, deadline });
  }

  async commit({ signal, deadline } = {}) {
    if (this.released || this.committed || this.commitOperation) {
      throw importError("EXPORT_DESTINATION_INVALID", "Export reservation is invalid");
    }
    if (this.broker.closed || this.broker.closing) {
      throw importError("EXPORT_DESTINATION_CLOSED", "Destination broker is closed");
    }
    const admission = Object.freeze({ phase: "admitting", requestSent: false });
    this.commitOperation = admission;
    let operation;
    try {
      operation = await this.broker._beginCommit({
        reservationId: this.reservationId,
      }, { signal, deadline });
    } catch (error) {
      this.commitOperation = null;
      throw error;
    }
    this.commitOperation = operation;
    try {
      const result = await operation.initial;
      this._finishCommit(result);
      return result;
    } catch (error) {
      if (error?.code === "EXPORT_COMMIT_OUTCOME_UNKNOWN") {
        this.outcomeUnknown = true;
      } else {
        this.commitOperation = null;
      }
      throw error;
    }
  }

  _finishCommit(result) {
    this.committed = true;
    this.commitResult = result;
    this.commitOperation = null;
    this.outcomeUnknown = false;
    if (result?.reservationReleased === true) {
      this.released = true;
      this.broker._forget(this);
    }
  }

  async reconcile() {
    if (this.committed) {
      return { status: "committed", result: this.commitResult };
    }
    if (!this.commitOperation) return { status: "retryable_safe", errorCode: null };
    if (!this.commitOperation.outcome) return { status: "in_progress" };
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.commitOperation.outcome.then(
      (result) => {
        this._finishCommit(result);
        return { status: "committed", result };
      },
      (error) => {
        if (error?.code === "EXPORT_COMMIT_OUTCOME_UNKNOWN") {
          return {
            status: "outcome_unknown",
            errorCode: "EXPORT_COMMIT_OUTCOME_UNKNOWN",
          };
        }
        this.commitOperation = null;
        this.outcomeUnknown = false;
        return {
          status: "retryable_safe",
          errorCode: typeof error?.code === "string"
            ? error.code
            : "EXPORT_WRITE_FAILED",
        };
      },
    );
    return this.reconcilePromise;
  }

  async release({ deadline } = {}) {
    if (this.released) return false;
    if (this.commitOperation) {
      throw importError(
        this.outcomeUnknown
          ? "EXPORT_COMMIT_OUTCOME_UNKNOWN"
          : "EXPORT_COMMIT_IN_PROGRESS",
        "Export commit cannot be released",
      );
    }
    await this.broker._request("release", {
      reservationId: this.reservationId,
    }, { deadline });
    this.released = true;
    this.broker._forget(this);
    return true;
  }
}

module.exports = {
  ReferenceDestinationReservation,
};
